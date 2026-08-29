import type { ContentBlock, Message } from "../messages.js";
import type { ModelEvent, ModelProvider, ModelRequest, StopReason } from "../provider.js";
import type { Usage } from "../events.js";
import { OpenAIChatGPTAuth, type OpenAIChatGPTAuthOptions } from "./openai-chatgpt-auth.js";

/**
 * Experimental `openai-chatgpt` provider (PLAN §2.9): reuses a ChatGPT subscription via the same
 * backend Codex talks to — `POST https://chatgpt.com/backend-api/codex/responses`, the Responses
 * API (NOT Chat Completions). Auth is the OAuth access token from `agentrig login openai-chatgpt`.
 *
 * The `originator: codex_cli_rs` header impersonates the Codex client to pass a server-side
 * whitelist (a non-Codex value returns 403). Endpoint, headers, and payload are undocumented and
 * read from the Apache-2.0 openai/codex source; they may drift without notice. Opt-in only.
 */

export interface OpenAIChatGPTProviderOptions {
  model: string;
  auth?: OpenAIChatGPTAuth;
  authOptions?: OpenAIChatGPTAuthOptions;
  baseUrl?: string;
  contextWindow?: number;
  fetchFn?: typeof fetch;
  /** Sent as the Codex client version in the User-Agent; see the impersonation note above. */
  codexVersion?: string;
}

const CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/codex";
const ORIGINATOR = "codex_cli_rs";

type JsonObject = Record<string, unknown>;

function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Map unified messages to the Responses API `input[]` items. */
export function toResponsesInput(messages: Message[]): JsonObject[] {
  const input: JsonObject[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = textOf(m.content);
      if (text !== "") input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
      for (const b of m.content) {
        if (b.type === "tool_use") {
          input.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
        }
      }
      continue;
    }
    // user: tool results become function_call_output items; text/images become a message
    for (const b of m.content) {
      if (b.type === "tool_result") {
        const out = typeof b.content === "string" ? b.content : textOf(b.content);
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

export function toResponsesRequest(req: ModelRequest, model: string): JsonObject {
  const body: JsonObject = {
    model,
    instructions: req.system,
    input: toResponsesInput(req.messages),
    stream: true,
    store: false,
    max_output_tokens: req.maxTokens,
  };
  if (req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }));
    body.tool_choice = "auto";
  }
  if (req.temperature !== undefined) body.temperature = req.temperature;
  return body;
}

/** Parse the Responses API SSE stream into ModelEvents (text live; tool_use on item done; usage+stop at end). */
export async function* parseResponsesSse(body: AsyncIterable<Uint8Array | string>): AsyncIterable<ModelEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: Usage | null = null;
  let sawToolUse = false;
  let sawRefusal = false;
  let stop: StopReason | null = null;

  const readUsage = (u: JsonObject | undefined): Usage | null => {
    if (!u || typeof u.input_tokens !== "number" || typeof u.output_tokens !== "number") return null;
    const out: Usage = { input: u.input_tokens, output: u.output_tokens };
    const cached = (u.input_tokens_details as JsonObject | undefined)?.cached_tokens;
    if (typeof cached === "number" && cached > 0) out.cacheRead = cached;
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
        if (item?.type === "function_call") {
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
          yield {
            type: "tool_use",
            id: String(item.call_id ?? item.id ?? ""),
            name: String(item.name ?? ""),
            input: parsed,
          };
        } else if (item?.type === "message") {
          const content = (item.content as JsonObject[] | undefined) ?? [];
          if (content.some((c) => c.type === "refusal")) sawRefusal = true;
        }
        break;
      }
      case "response.completed":
      case "response.incomplete": {
        const response = data.response as JsonObject | undefined;
        usage = readUsage(response?.usage as JsonObject | undefined) ?? usage;
        const reason = (response?.incomplete_details as JsonObject | undefined)?.reason;
        if (reason === "max_output_tokens") stop = "max_tokens";
        break;
      }
      case "response.failed": {
        const err = (data.response as JsonObject | undefined)?.error as JsonObject | undefined;
        throw new Error(`openai-chatgpt stream failed: ${String(err?.message ?? err?.code ?? "unknown")}`);
      }
      case "error": {
        const err = data.error as JsonObject | undefined;
        throw new Error(`openai-chatgpt stream error: ${String(err?.message ?? JSON.stringify(data))}`);
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
  buffer += "\n";
  yield* drain();

  yield { type: "usage", usage: usage ?? { input: 0, output: 0 } };
  const finalStop: StopReason = stop ?? (sawToolUse ? "tool_use" : sawRefusal ? "refusal" : "end_turn");
  yield { type: "stop", reason: finalStop };
}

export class OpenAIChatGPTProvider implements ModelProvider {
  readonly id = "openai-chatgpt";
  readonly model: string;
  readonly capabilities: ModelProvider["capabilities"];
  private readonly auth: OpenAIChatGPTAuth;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly codexVersion: string;

  constructor(opts: OpenAIChatGPTProviderOptions) {
    this.model = opts.model;
    this.auth = opts.auth ?? new OpenAIChatGPTAuth(opts.authOptions ?? {});
    this.baseUrl = (opts.baseUrl ?? CHATGPT_BASE_URL).replace(/\/$/, "");
    this.fetchFn = opts.fetchFn ?? fetch;
    this.codexVersion = opts.codexVersion ?? "0.0.0";
    this.capabilities = {
      tools: true,
      parallelTools: true,
      caching: true,
      contextWindow: opts.contextWindow ?? 200_000,
    };
  }

  private async post(req: ModelRequest, signal: AbortSignal, force: boolean): Promise<Response> {
    const { accessToken, accountId } = await this.auth.getAccessToken(force);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${accessToken}`,
      // impersonates the Codex client to pass the backend originator whitelist (PLAN §2.9)
      originator: ORIGINATOR,
      "user-agent": `${ORIGINATOR}/${this.codexVersion} (agentrig)`,
    };
    if (accountId !== undefined) headers["chatgpt-account-id"] = accountId;
    return this.fetchFn(`${this.baseUrl}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(toResponsesRequest(req, this.model)),
      signal,
    });
  }

  async *stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    let res = await this.post(req, signal, false);
    // a 401 usually means the access token expired between refresh checks: force one refresh + retry
    if (res.status === 401) {
      await res.body?.cancel().catch(() => {});
      res = await this.post(req, signal, true);
    }
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new Error(`openai-chatgpt: HTTP ${res.status} ${detail.slice(0, 500)}`);
    }
    yield* parseResponsesSse(res.body);
  }
}
