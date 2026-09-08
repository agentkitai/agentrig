import { randomUUID } from "node:crypto";
import type { ContentBlock, Message } from "../messages.js";
import { thinkingFromItem, thinkingToItem, validateThinkingHistory } from "./thinking.js";
import type { ModelEvent, ModelProvider, ModelRequest, ReasoningEffort, StopReason } from "../provider.js";
import type { Usage } from "../events.js";
import { OpenAIChatGPTAuth, type OpenAIChatGPTAuthOptions } from "./openai-chatgpt-auth.js";
import { errorDetail, fetchWithRetries, streamWithRetries, type RetryPolicy, type StreamRetryInfo } from "./retry.js";
import { openAiCacheReadDiscount } from "./cache-pricing.js";

/**
 * Experimental `openai-chatgpt` provider (PLAN §2.9): reuses a ChatGPT subscription via the same
 * backend Codex talks to — `POST https://chatgpt.com/backend-api/codex/responses`, the Responses
 * API (NOT Chat Completions). Auth is the OAuth access token from `agentrig login openai-chatgpt`.
 *
 * AgentRig identifies itself honestly: `originator: agentrig` plus its own User-Agent, the same
 * attribution-header approach other third-party harnesses document. If the backend restricts the
 * originator to first-party clients this returns 403 — that is the correct outcome to surface,
 * not something to defeat by claiming to be another vendor's client. `originator` is
 * configurable for users who choose differently on their own accounts; AgentRig never ships a
 * default that misrepresents what software is calling.
 *
 * Endpoint, headers, and payload are undocumented and read from the Apache-2.0 openai/codex
 * source; they may drift without notice. Opt-in only.
 */

export interface OpenAIChatGPTProviderOptions {
  model: string;
  auth?: OpenAIChatGPTAuth;
  authOptions?: OpenAIChatGPTAuthOptions;
  baseUrl?: string;
  contextWindow?: number;
  /** Pinned reasoning effort, sent as `reasoning: { effort }`. Omitted when unset. */
  reasoningEffort?: ReasoningEffort;
  fetchFn?: typeof fetch;
  /**
   * Client identifier sent as the `originator` header. Defaults to AgentRig's own name — the
   * honest value. Override only if you have decided, for your own account, to present a
   * different client identity to the endpoint.
   */
  originator?: string;
  /** Version reported in the User-Agent. */
  clientVersion?: string;
  retry?: RetryPolicy;
  /** Called when a transient in-stream failure triggers a clean re-request, so a UI can say so. */
  onRetry?: (info: StreamRetryInfo) => void;
}

const CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/codex";
/** Honest self-identification; see the impersonation note above. */
const DEFAULT_ORIGINATOR = "agentrig";
type JsonObject = Record<string, unknown>;

/** Ordered raw output items of one response, replayed verbatim on the following request. */
interface RawItemGroup {
  id: string;
  items: JsonObject[];
}

function reconstructFunctionCall(b: Extract<ContentBlock, { type: "tool_use" }>): JsonObject {
  return { type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) };
}

/**
 * Map unified messages to the Responses API `input[]` items.
 *
 * Persisted thinking blocks own reasoning replay. The optional explicit `rawGroups` argument
 * is retained for legacy SDK callers; the provider itself never constructs a hidden cache.
 * A message with persisted thinking always wins over a caller-supplied legacy group.
 */
export function toResponsesInput(messages: Message[], rawGroups?: Map<string, RawItemGroup>): JsonObject[] {
  validateThinkingHistory(messages, "openai-responses");
  // Provenance stays on unified blocks, independent of cached vendor reasoning items. Never
  // overwrite unified history with this lossy wire projection or treat vendor text as labels.
  const input: JsonObject[] = [];
  const emitted = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant") {
      // Persisted reasoning is authoritative. The legacy cache remains only for callers
      // supplying old tool-only history, never as a second source of reasoning items.
      const persisted = m.content.some(block => block.type === "thinking");
      // preserve stream order: text and tool calls can interleave
      let pending = "";
      const flush = () => {
        if (pending !== "") {
          input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: pending }] });
          pending = "";
        }
      };
      for (const b of m.content) {
        if (b.type === "thinking") {
          flush();
          input.push(thinkingToItem(b, "openai-responses"));
          continue;
        }
        if (b.type === "text") {
          pending += b.text;
          continue;
        }
        if (b.type !== "tool_use") continue;
        flush();
        const group = persisted ? undefined : rawGroups?.get(b.id);
        if (group === undefined) {
          input.push(reconstructFunctionCall(b));
        } else if (!emitted.has(group.id)) {
          emitted.add(group.id);
          input.push(...group.items);
        }
      }
      flush();
      continue;
    }
    // user: tool results become function_call_output items; text/images become a message
    for (const b of m.content) {
      if (b.type === "tool_result") {
        const out = typeof b.content === "string" ? b.content : describeBlocks(b.content);
        input.push({ type: "function_call_output", call_id: b.toolUseId, output: out });
      }
    }
    const parts: JsonObject[] = [];
    for (const b of m.content) {
      if (b.type === "text") parts.push({ type: "input_text", text: b.text });
      else if (b.type === "image") parts.push({ type: "input_image", image_url: `data:${b.mediaType};base64,${b.data}` });
    }
    if (parts.length > 0) input.push({ type: "message", role: "user", content: parts });
  }
  return input;
}

/** Tool results are plain text here; note non-text blocks rather than dropping them silently. */
function describeBlocks(blocks: ContentBlock[]): string {
  return blocks
    .map((b) => (b.type === "text" ? b.text : b.type === "image" ? "[image omitted]" : ""))
    .filter((s) => s !== "")
    .join("\n");
}

export function toResponsesRequest(
  req: ModelRequest,
  model: string,
  rawGroups?: Map<string, RawItemGroup>,
  reasoningEffort?: ReasoningEffort,
): JsonObject {
  const body: JsonObject = {
    model,
    instructions: req.system,
    input: toResponsesInput(req.messages, rawGroups),
    stream: true,
    store: false,
    // reasoning models require their reasoning items on the following request; ask for the
    // encrypted form so they can be replayed without server-side storage
    include: ["reasoning.encrypted_content"],
    // NO `max_output_tokens`: this backend rejects it outright — verified live, 2026-08-30,
    // `HTTP 400 {"detail":"Unsupported parameter: max_output_tokens"}` on the first authenticated
    // call. Codex does not send it either. `ModelRequest.maxTokens` therefore cannot bind a
    // single response here; the session budget still meters what was actually spent.
  };
  if (req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
      // Responses can normalize omitted strict to true, making optional fields required.
      // Preserve the tool's schema; the runtime still validates inputs and permissions.
      strict: false,
    }));
    body.tool_choice = "auto";
  }
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (reasoningEffort !== undefined) body.reasoning = { effort: reasoningEffort };
  return body;
}

/** Map an `incomplete_details.reason` onto the unified stop reason, keeping unknowns visible. */
function mapIncompleteReason(reason: unknown): { reason: StopReason; raw?: string } {
  switch (reason) {
    case "max_output_tokens":
      return { reason: "max_tokens" };
    case "content_filter":
      return { reason: "refusal" };
    default:
      return { reason: "error", raw: String(reason ?? "incomplete") };
  }
}

export interface ParseResponsesOptions {
  /** Receives every raw output item, so the provider can replay reasoning items next turn. */
  onRawItem?: (item: JsonObject) => void;
}

/** Parse the Responses API SSE stream into ModelEvents (text live; tool_use on item done; usage+stop at end). */
export async function* parseResponsesSse(
  body: AsyncIterable<Uint8Array | string>,
  opts: ParseResponsesOptions = {},
): AsyncIterable<ModelEvent> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let usage: Usage | null = null;
  let sawToolUse = false;
  let sawRefusal = false;
  let stop: StopReason | null = null;
  let stopRaw: string | undefined;
  let thinkingBytes = 0;
  let thinkingCount = 0;

  const readUsage = (u: JsonObject | undefined): Usage | null => {
    if (!u || typeof u.input_tokens !== "number" || typeof u.output_tokens !== "number") return null;
    // The Usage contract (events.ts): `input` EXCLUDES cache reads. The Responses API's
    // `input_tokens` includes `cached_tokens`, so the cached part is subtracted out — otherwise
    // anything that sums input + cacheRead counts the cached prefix twice.
    const cached = (u.input_tokens_details as JsonObject | undefined)?.cached_tokens;
    const cacheRead = typeof cached === "number" && cached > 0 ? Math.min(cached, u.input_tokens) : 0;
    const out: Usage = { input: u.input_tokens - cacheRead, output: u.output_tokens };
    if (cacheRead > 0) out.cacheRead = cacheRead;
    return out;
  };

  const handle = function* (data: JsonObject): Generator<ModelEvent> {
    switch (data.type) {
      case "response.output_text.delta": {
        if (typeof data.delta === "string" && data.delta !== "") yield { type: "text_delta", text: data.delta };
        break;
      }
      case "response.refusal.delta":
        sawRefusal = true;
        break;
      case "response.output_item.done": {
        const item = data.item as JsonObject | undefined;
        if (item === undefined) break;
        if (item.type === "reasoning") {
          const block = thinkingFromItem("openai-responses", item);
          thinkingBytes += Buffer.byteLength(JSON.stringify(block));
          if (++thinkingCount > 32 || thinkingBytes > 1_048_576) throw new Error("reasoning response exceeds retention bound");
          yield { type: "thinking", block };
        }
        opts.onRawItem?.(item);
        if (item.type === "function_call") {
          sawToolUse = true;
          let parsed: unknown = {};
          const args = typeof item.arguments === "string" ? item.arguments : "";
          if (args.trim() !== "") {
            try {
              parsed = JSON.parse(args);
            } catch {
              parsed = {};
            }
          }
          const id = String(item.call_id ?? item.id ?? "");
          yield {
            type: "tool_use",
            // an id is required for one-to-one tool_use/tool_result pairing in the loop
            id: id === "" ? `call_${randomUUID().slice(0, 8)}` : id,
            name: String(item.name ?? ""),
            input: parsed,
          };
        } else if (item.type === "message") {
          const content = (item.content as JsonObject[] | undefined) ?? [];
          if (content.some((c) => c.type === "refusal")) sawRefusal = true;
        }
        break;
      }
      case "response.completed":
      case "response.incomplete": {
        const response = data.response as JsonObject | undefined;
        usage = readUsage(response?.usage as JsonObject | undefined) ?? usage;
        if (data.type === "response.incomplete") {
          const mapped = mapIncompleteReason((response?.incomplete_details as JsonObject | undefined)?.reason);
          stop = mapped.reason;
          stopRaw = mapped.raw;
        }
        break;
      }
      case "response.failed": {
        const err = (data.response as JsonObject | undefined)?.error as JsonObject | undefined;
        throw new Error(`openai-chatgpt stream failed: ${errorDetail(String(err?.message ?? err?.code ?? "unknown"), 300)}`);
      }
      case "error": {
        const err = data.error as JsonObject | undefined;
        throw new Error(`openai-chatgpt stream error: ${errorDetail(String(err?.message ?? JSON.stringify(data)), 300)}`);
      }
    }
  };

  const drain = function* (): Generator<ModelEvent> {
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
    yield* drain();
  }
  buffer += decoder.decode() + "\n";
  yield* drain();

  yield { type: "usage", usage: usage ?? { input: 0, output: 0 }, ...(usage === null ? { reported: false } : {}) };
  const finalStop: StopReason = stop ?? (sawToolUse ? "tool_use" : sawRefusal ? "refusal" : "end_turn");
  yield stopRaw === undefined ? { type: "stop", reason: finalStop } : { type: "stop", reason: finalStop, raw: stopRaw };
}

export class OpenAIChatGPTProvider implements ModelProvider {
  readonly id = "openai-chatgpt";
  validateHistory(messages: ModelRequest["messages"]): void { validateThinkingHistory(messages, "openai-responses"); }
  readonly model: string;
  readonly capabilities: ModelProvider["capabilities"];
  private readonly auth: OpenAIChatGPTAuth;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly originator: string;
  private readonly clientVersion: string;
  private readonly reasoningEffort: ReasoningEffort | undefined;
  private readonly retry: RetryPolicy;
  private readonly onRetry: ((info: StreamRetryInfo) => void) | undefined;
  private readonly sessionId = randomUUID();

  constructor(opts: OpenAIChatGPTProviderOptions) {
    this.model = opts.model;
    this.auth = opts.auth ?? new OpenAIChatGPTAuth(opts.authOptions ?? {});
    this.baseUrl = (opts.baseUrl ?? CHATGPT_BASE_URL).replace(/\/$/, "");
    this.fetchFn = opts.fetchFn ?? fetch;
    this.originator = opts.originator ?? DEFAULT_ORIGINATOR;
    this.clientVersion = opts.clientVersion ?? "0.0.0";
    this.reasoningEffort = opts.reasoningEffort;
    this.retry = opts.retry ?? {};
    this.onRetry = opts.onRetry;
    const cacheReadDiscount = openAiCacheReadDiscount(this.model);
    this.capabilities = {
      tools: true,
      parallelTools: true,
      caching: true,
      ...(cacheReadDiscount === undefined ? {} : { cacheReadDiscount }),
      contextWindow: opts.contextWindow ?? 200_000,
    };
  }

  /** Build the authed request; `force` refreshes the access token first. */
  private async request(req: ModelRequest, force: boolean): Promise<{ url: string; init: RequestInit }> {
    // Replay refusal must precede credential access and refresh network, not only fetch.
    validateThinkingHistory(req.messages, "openai-responses");
    const { accessToken, accountId } = await this.auth.getAccessToken(force);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${accessToken}`,
      // self-identifying attribution headers (PLAN §2.9): AgentRig says who it actually is
      originator: this.originator,
      "user-agent": `${this.originator}/${this.clientVersion} (${process.platform}; ${process.arch})`,
      "openai-beta": "responses=experimental",
      session_id: this.sessionId,
    };
    if (accountId !== undefined) headers["chatgpt-account-id"] = accountId;
    return {
      url: `${this.baseUrl}/responses`,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify(toResponsesRequest(req, this.model, undefined, this.reasoningEffort)),
      },
    };
  }

  async *stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    // fetchWithRetries covers transient failures (429/5xx/network) BEFORE a 200 arrives; the
    // streamWithRetries wrapper covers "200, then an overload error inside the SSE stream",
    // which this backend actually does; the 401 retry below is a separate token-expiry
    // recovery, since it must re-mint the Authorization header.
    const attempt = async (force: boolean): Promise<Response> => {
      const { url, init } = await this.request(req, force);
      return fetchWithRetries(this.fetchFn, "openai-chatgpt", url, init, signal, this.retry);
    };

    const openOnce = async function* (this: OpenAIChatGPTProvider): AsyncIterable<ModelEvent> {
      let res: Response;
      try {
        res = await attempt(false);
      } catch (err) {
        if (!(err instanceof Error) || !/HTTP 401/.test(err.message)) throw err;
        res = await attempt(true);
      }
      if (!res.body) throw new Error("openai-chatgpt: empty response body");

      // Canonical messages are the sole replay source. A hidden cache would resurrect
      // compacted reasoning and disappear on restart, creating different requests.
      yield* parseResponsesSse(res.body);
    }.bind(this);

    yield* streamWithRetries(openOnce, signal, this.retry, this.onRetry, (info) => ({ type: "retry", ...info }));
  }
}
