import type { ContentBlock, Message } from "../messages.js";
import type { ModelEvent, ModelProvider, ModelRequest, StopReason } from "../provider.js";
import type { Usage } from "../events.js";
import { fetchWithRetries, streamWithRetries, type RetryPolicy, type StreamRetryInfo } from "./retry.js";

/**
 * Anthropic Messages API adapter. Speaks the streaming REST API directly (no vendor SDK),
 * maps to/from the unified Message/ContentBlock schema, and exposes `fetchFn` so tests can
 * run the full SSE path without a network.
 */

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  contextWindow?: number;
  fetchFn?: typeof fetch;
  /** Backoff for transient HTTP failures (rate limits, 5xx); see RetryPolicy defaults. */
  retry?: RetryPolicy;
  /** Called when a transient in-stream failure triggers a clean re-request, so a UI can say so. */
  onRetry?: (info: StreamRetryInfo) => void;
}

const API_VERSION = "2023-06-01";

type JsonObject = Record<string, unknown>;

export function toAnthropicRequest(req: ModelRequest, model: string): JsonObject {
  const body: JsonObject = {
    model,
    max_tokens: req.maxTokens,
    system: req.cacheHints?.systemPrefix
      ? req.cacheHints.systemPrefixChars !== undefined && req.cacheHints.systemPrefixChars < req.system.length
        ? [
            { type: "text", text: req.system.slice(0, req.cacheHints.systemPrefixChars), cache_control: { type: "ephemeral" } },
            { type: "text", text: req.system.slice(req.cacheHints.systemPrefixChars) },
          ]
        : [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }]
      : req.system,
    messages: req.messages.map(toAnthropicMessage),
    tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
    stream: true,
  };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  return body;
}

function toAnthropicMessage(m: Message): JsonObject {
  return { role: m.role, content: m.content.map(toAnthropicBlock) };
}

function toAnthropicBlock(b: ContentBlock): JsonObject {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "tool_use":
      return { type: "tool_use", id: b.id, name: b.name, input: b.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: b.toolUseId,
        content: typeof b.content === "string" ? b.content : b.content.map(toAnthropicBlock),
        ...(b.isError !== undefined ? { is_error: b.isError } : {}),
      };
    case "image":
      return { type: "image", source: { type: "base64", media_type: b.mediaType, data: b.data } };
  }
}

function mapStopReason(reason: unknown): { reason: StopReason; raw?: string } {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return { reason: "end_turn" };
    case "tool_use":
      return { reason: "tool_use" };
    case "max_tokens":
      return { reason: "max_tokens" };
    case "refusal":
      return { reason: "refusal" };
    default:
      return { reason: "error", raw: String(reason) };
  }
}

/** Split a byte stream into SSE `data:` JSON payloads and map them to ModelEvents. */
export async function* parseAnthropicSse(body: AsyncIterable<Uint8Array | string>): AsyncIterable<ModelEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let pendingTool: { id: string; name: string; json: string } | null = null;
  let inputTokens = 0;
  let cacheRead: number | undefined;
  let cacheWrite: number | undefined;
  let outputTokens = 0;
  let stopReason: unknown;

  const handle = function* (data: JsonObject): Generator<ModelEvent> {
    switch (data.type) {
      case "message_start": {
        const usage = (data.message as JsonObject | undefined)?.usage as JsonObject | undefined;
        inputTokens = Number(usage?.input_tokens ?? 0);
        if (typeof usage?.cache_read_input_tokens === "number") cacheRead = usage.cache_read_input_tokens;
        if (typeof usage?.cache_creation_input_tokens === "number") cacheWrite = usage.cache_creation_input_tokens;
        break;
      }
      case "content_block_start": {
        const block = data.content_block as JsonObject | undefined;
        if (block?.type === "tool_use") {
          pendingTool = { id: String(block.id), name: String(block.name), json: "" };
        }
        break;
      }
      case "content_block_delta": {
        const delta = data.delta as JsonObject | undefined;
        if (delta?.type === "text_delta") yield { type: "text_delta", text: String(delta.text ?? "") };
        else if (delta?.type === "input_json_delta" && pendingTool) pendingTool.json += String(delta.partial_json ?? "");
        break;
      }
      case "content_block_stop": {
        if (pendingTool) {
          // The accumulated JSON can be truncated (max_tokens mid-tool-input) or garbage.
          // Never throw here — that would kill the session before the buffered usage/stop
          // events flow; an empty input lets the loop's schema validation report it instead.
          let input: unknown = {};
          const raw = pendingTool.json.trim();
          if (raw !== "") {
            try {
              input = JSON.parse(raw);
            } catch {
              input = {};
            }
          }
          yield { type: "tool_use", id: pendingTool.id, name: pendingTool.name, input };
          pendingTool = null;
        }
        break;
      }
      case "message_delta": {
        const delta = data.delta as JsonObject | undefined;
        if (delta?.stop_reason !== undefined) stopReason = delta.stop_reason;
        const usage = data.usage as JsonObject | undefined;
        if (typeof usage?.output_tokens === "number") outputTokens = usage.output_tokens;
        break;
      }
      case "error": {
        const err = data.error as JsonObject | undefined;
        throw new Error(`anthropic stream error: ${String(err?.type ?? "unknown")}: ${String(err?.message ?? "")}`);
      }
    }
  };

  const drainLines = function* (): Generator<ModelEvent> {
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trimEnd();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice("data:".length).trim();
      if (payload === "" || payload === "[DONE]") continue;
      yield* handle(JSON.parse(payload) as JsonObject);
    }
  };

  for await (const chunk of body) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    yield* drainLines();
  }
  buffer += "\n";
  yield* drainLines();

  const usage: Usage = { input: inputTokens, output: outputTokens };
  if (cacheRead !== undefined) usage.cacheRead = cacheRead;
  if (cacheWrite !== undefined) usage.cacheWrite = cacheWrite;
  yield { type: "usage", usage };
  const mapped = mapStopReason(stopReason);
  yield mapped.raw === undefined
    ? { type: "stop", reason: mapped.reason }
    : { type: "stop", reason: mapped.reason, raw: mapped.raw };
}

export class AnthropicProvider implements ModelProvider {
  readonly id = "anthropic";
  readonly model: string;
  readonly capabilities: ModelProvider["capabilities"];
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly retry: RetryPolicy | undefined;
  private readonly onRetry: ((info: StreamRetryInfo) => void) | undefined;

  constructor(opts: AnthropicProviderOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseUrl = (opts.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.fetchFn = opts.fetchFn ?? fetch;
    this.retry = opts.retry;
    this.onRetry = opts.onRetry;
    this.capabilities = {
      tools: true,
      parallelTools: true,
      caching: true,
      contextWindow: opts.contextWindow ?? 200_000,
    };
  }

  async *stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    // streamWithRetries re-requests when the failure arrives INSIDE a 200 stream (Anthropic
    // sends `overloaded_error` as an SSE error event) — but only before anything was yielded
    const openOnce = async function* (this: AnthropicProvider): AsyncIterable<ModelEvent> {
      const res = await fetchWithRetries(
        this.fetchFn,
        "anthropic",
        `${this.baseUrl}/v1/messages`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": this.apiKey,
            "anthropic-version": API_VERSION,
          },
          body: JSON.stringify(toAnthropicRequest(req, this.model)),
        },
        signal,
        this.retry ?? {},
      );
      if (!res.body) throw new Error("anthropic: empty response body");
      yield* parseAnthropicSse(res.body);
    }.bind(this);
    yield* streamWithRetries(openOnce, signal, this.retry ?? {}, this.onRetry, (info) => ({ type: "retry", ...info }));
  }
}
