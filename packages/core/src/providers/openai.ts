import type { ContentBlock, Message } from "../messages.js";
import type { ModelEvent, ModelProvider, ModelRequest, StopReason } from "../provider.js";
import type { Usage } from "../events.js";

/**
 * OpenAI-compatible Chat Completions adapter: OpenAI itself plus most local servers
 * (Ollama, vLLM, llama.cpp, LM Studio) that speak the same streaming API. Like the
 * Anthropic adapter it talks REST directly with an injectable `fetchFn`; `apiKey` is
 * optional because local servers don't require one.
 */

export interface OpenAIProviderOptions {
  model: string;
  apiKey?: string;
  baseUrl?: string;
  contextWindow?: number;
  fetchFn?: typeof fetch;
  /**
   * Which request key carries the token cap. OpenAI deprecated `max_tokens` and current
   * models reject it, so the default is `max_completion_tokens` against api.openai.com and
   * `max_tokens` for other base URLs (what most local servers still expect).
   */
  maxTokensParam?: "max_tokens" | "max_completion_tokens";
}

type JsonObject = Record<string, unknown>;

/** tool_result content is a string or blocks; Chat Completions tool messages take plain text. */
function toolResultText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .map((b) => (b.type === "text" ? b.text : b.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

export function toOpenAIRequest(
  req: ModelRequest,
  model: string,
  maxTokensParam: "max_tokens" | "max_completion_tokens" = "max_completion_tokens",
): JsonObject {
  const messages: JsonObject[] = [{ role: "system", content: req.system }];
  for (const m of req.messages) messages.push(...toOpenAIMessages(m));
  const body: JsonObject = {
    model,
    [maxTokensParam]: req.maxTokens,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }
  if (req.temperature !== undefined) body.temperature = req.temperature;
  return body;
}

/** One unified message can fan out: tool_result blocks become individual `tool` role messages. */
function toOpenAIMessages(m: Message): JsonObject[] {
  const out: JsonObject[] = [];
  if (m.role === "assistant") {
    const text = m.content
      .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");
    const toolCalls = m.content
      .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
      .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
    const msg: JsonObject = { role: "assistant", content: text === "" ? null : text };
    if (toolCalls.length > 0) msg.tool_calls = toolCalls;
    out.push(msg);
    return out;
  }
  // user: tool_result blocks must come first, directly after the assistant's tool_calls message
  for (const b of m.content) {
    if (b.type === "tool_result") {
      out.push({ role: "tool", tool_call_id: b.toolUseId, content: toolResultText(b.content) });
    }
  }
  const parts: JsonObject[] = [];
  for (const b of m.content) {
    if (b.type === "text") parts.push({ type: "text", text: b.text });
    else if (b.type === "image")
      parts.push({ type: "image_url", image_url: { url: `data:${b.mediaType};base64,${b.data}` } });
  }
  if (parts.length > 0) {
    out.push({
      role: "user",
      content: parts.every((p) => p.type === "text")
        ? parts.map((p) => p.text as string).join("")
        : parts,
    });
  }
  return out;
}

function mapFinishReason(reason: unknown): { reason: StopReason; raw?: string } {
  switch (reason) {
    case "stop":
      return { reason: "end_turn" };
    case "tool_calls":
    case "function_call":
      return { reason: "tool_use" };
    case "length":
      return { reason: "max_tokens" };
    case "content_filter":
      return { reason: "refusal" };
    default:
      return { reason: "error", raw: String(reason) };
  }
}

/** Map the Chat Completions SSE stream to ModelEvents (text live; tool calls assembled, then usage, then stop). */
export async function* parseOpenAISse(body: AsyncIterable<Uint8Array | string>): AsyncIterable<ModelEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  const toolCalls = new Map<number, { id: string; name: string; args: string }>();
  let usage: Usage | null = null;
  let finishReason: unknown;

  const handle = (data: JsonObject): ModelEvent[] => {
    const events: ModelEvent[] = [];
    const choice = (data.choices as JsonObject[] | undefined)?.[0];
    if (choice) {
      const delta = choice.delta as JsonObject | undefined;
      if (typeof delta?.content === "string" && delta.content !== "") {
        events.push({ type: "text_delta", text: delta.content });
      }
      for (const tc of (delta?.tool_calls as JsonObject[] | undefined) ?? []) {
        // conforming servers always send index; without it, route by id, else to the latest call
        let index: number;
        if (typeof tc.index === "number") index = tc.index;
        else if (typeof tc.id === "string" && tc.id !== "") {
          const byId = [...toolCalls.entries()].find(([, e]) => e.id === tc.id);
          index = byId === undefined ? toolCalls.size : byId[0];
        } else {
          index = toolCalls.size === 0 ? 0 : Math.max(...toolCalls.keys());
        }
        const entry = toolCalls.get(index) ?? { id: "", name: "", args: "" };
        if (typeof tc.id === "string" && tc.id !== "") entry.id = tc.id;
        const fn = tc.function as JsonObject | undefined;
        // assign, don't concatenate: some proxies resend the full name in every chunk
        if (typeof fn?.name === "string" && fn.name !== "" && entry.name === "") entry.name = fn.name;
        if (typeof fn?.arguments === "string") entry.args += fn.arguments;
        toolCalls.set(index, entry);
      }
      if (choice.finish_reason != null) finishReason = choice.finish_reason;
    }
    const u = data.usage as JsonObject | undefined;
    if (u && typeof u.prompt_tokens === "number" && typeof u.completion_tokens === "number") {
      usage = { input: u.prompt_tokens, output: u.completion_tokens };
      const cached = (u.prompt_tokens_details as JsonObject | undefined)?.cached_tokens;
      if (typeof cached === "number" && cached > 0) usage.cacheRead = cached;
    }
    if (data.error) {
      const err = data.error as JsonObject;
      throw new Error(`openai stream error: ${String(err.message ?? JSON.stringify(err))}`);
    }
    return events;
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

  for (const [, tc] of [...toolCalls.entries()].sort(([a], [b]) => a - b)) {
    // same guard as the Anthropic adapter: truncated/garbage arguments must not kill the session
    let input: unknown = {};
    if (tc.args.trim() !== "") {
      try {
        input = JSON.parse(tc.args);
      } catch {
        input = {};
      }
    }
    yield { type: "tool_use", id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`, name: tc.name, input };
  }
  yield { type: "usage", usage: usage ?? { input: 0, output: 0 } };
  const mapped = mapFinishReason(finishReason ?? "stop");
  yield mapped.raw === undefined
    ? { type: "stop", reason: mapped.reason }
    : { type: "stop", reason: mapped.reason, raw: mapped.raw };
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id = "openai-compatible";
  readonly model: string;
  readonly capabilities: ModelProvider["capabilities"];
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly maxTokensParam: "max_tokens" | "max_completion_tokens";

  constructor(opts: OpenAIProviderOptions) {
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.fetchFn = opts.fetchFn ?? fetch;
    this.maxTokensParam =
      opts.maxTokensParam ?? (this.baseUrl.includes("api.openai.com") ? "max_completion_tokens" : "max_tokens");
    this.capabilities = {
      tools: true,
      parallelTools: true,
      caching: false,
      contextWindow: opts.contextWindow ?? 128_000,
    };
  }

  async *stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey !== undefined) headers.authorization = `Bearer ${this.apiKey}`;
    const res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(toOpenAIRequest(req, this.model, this.maxTokensParam)),
      signal,
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new Error(`openai-compatible: HTTP ${res.status} ${detail.slice(0, 500)}`);
    }
    yield* parseOpenAISse(res.body);
  }
}
