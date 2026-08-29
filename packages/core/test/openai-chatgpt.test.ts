import { describe, expect, it } from "vitest";
import {
  OpenAIChatGPTAuth,
  OpenAIChatGPTProvider,
  parseResponsesSse,
  toResponsesRequest,
  type ChatGPTTokens,
  type ModelEvent,
  type ModelRequest,
  type TokenStore,
} from "@agentkitai/agentrig-core";

const baseReq: ModelRequest = {
  system: "be terse",
  messages: [
    { role: "user", content: [{ type: "text", text: "run ls" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "ok" },
        { type: "tool_use", id: "call_1", name: "bash", input: { command: "ls" } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", toolUseId: "call_1", content: "a.txt" }] },
  ],
  tools: [{ name: "bash", description: "run", inputSchema: { type: "object" } }],
  maxTokens: 1024,
};

describe("toResponsesRequest", () => {
  it("maps to Responses API shape: instructions, flat tools, function_call items", () => {
    const body = toResponsesRequest(baseReq, "gpt-5.6-sol") as Record<string, unknown>;
    expect(body.model).toBe("gpt-5.6-sol");
    expect(body.instructions).toBe("be terse");
    expect(body.stream).toBe(true);
    expect(body.max_output_tokens).toBe(1024);
    expect(body.tools).toEqual([{ type: "function", name: "bash", description: "run", parameters: { type: "object" } }]);
    expect(body.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "run ls" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
      { type: "function_call", call_id: "call_1", name: "bash", arguments: '{"command":"ls"}' },
      { type: "function_call_output", call_id: "call_1", output: "a.txt" },
    ]);
  });
});

const sse = (events: unknown[]): string => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";

const toolStream = sse([
  { type: "response.created" },
  { type: "response.output_text.delta", delta: "wor" },
  { type: "response.output_text.delta", delta: "king" },
  { type: "response.output_item.done", item: { type: "function_call", call_id: "fc_1", name: "bash", arguments: '{"command":"ls"}' } },
  { type: "response.completed", response: { status: "completed", usage: { input_tokens: 12, output_tokens: 5, input_tokens_details: { cached_tokens: 3 } } } },
]);

async function collect(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("parseResponsesSse", () => {
  it("assembles text deltas, a tool call, usage and a tool_use stop", async () => {
    async function* chunks() {
      for (let i = 0; i < toolStream.length; i += 19) yield toolStream.slice(i, i + 19);
    }
    expect(await collect(parseResponsesSse(chunks()))).toEqual([
      { type: "text_delta", text: "wor" },
      { type: "text_delta", text: "king" },
      { type: "tool_use", id: "fc_1", name: "bash", input: { command: "ls" } },
      { type: "usage", usage: { input: 12, output: 5, cacheRead: 3 } },
      { type: "stop", reason: "tool_use" },
    ]);
  });

  it("maps an incomplete max_output_tokens response to stop max_tokens", async () => {
    async function* s() {
      yield sse([
        { type: "response.output_text.delta", delta: "cut" },
        { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 1, output_tokens: 1 } } },
      ]);
    }
    expect((await collect(parseResponsesSse(s()))).at(-1)).toEqual({ type: "stop", reason: "max_tokens" });
  });

  it("detects a refusal content part", async () => {
    async function* s() {
      yield sse([
        { type: "response.output_item.done", item: { type: "message", content: [{ type: "refusal", refusal: "no" }] } },
        { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
      ]);
    }
    expect((await collect(parseResponsesSse(s()))).at(-1)).toEqual({ type: "stop", reason: "refusal" });
  });

  it("throws on response.failed", async () => {
    async function* s() {
      yield sse([{ type: "response.failed", response: { error: { message: "overloaded" } } }]);
    }
    await expect(collect(parseResponsesSse(s()))).rejects.toThrow(/overloaded/);
  });

  it("ends end_turn for a plain text response", async () => {
    async function* s() {
      yield sse([
        { type: "response.output_text.delta", delta: "hi" },
        { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
      ]);
    }
    const events = await collect(parseResponsesSse(s()));
    expect(events).toEqual([
      { type: "text_delta", text: "hi" },
      { type: "usage", usage: { input: 1, output: 1 } },
      { type: "stop", reason: "end_turn" },
    ]);
  });
});

class MemoryStore implements TokenStore {
  constructor(public tokens: ChatGPTTokens | null) {}
  async read() {
    return this.tokens;
  }
  async write(t: ChatGPTTokens) {
    this.tokens = t;
  }
}

function futureJwt(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({})}.${b64({ exp: Date.now() / 1000 + 3600, chatgpt_account_id: "acct_7" })}.s`;
}

describe("OpenAIChatGPTProvider.stream", () => {
  it("posts to the codex responses endpoint with Codex headers — no network", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchFn: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init! };
      return new Response(toolStream, { status: 200 });
    };
    const auth = new OpenAIChatGPTAuth({ store: new MemoryStore({ accessToken: futureJwt(), refreshToken: "r", accountId: "acct_7" }) });
    const provider = new OpenAIChatGPTProvider({ model: "gpt-5.6-sol", auth, fetchFn });
    const events = await collect(provider.stream(baseReq, new AbortController().signal));

    expect(captured!.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^Bearer /);
    expect(headers.originator).toBe("codex_cli_rs");
    expect(headers["chatgpt-account-id"]).toBe("acct_7");
    expect(headers["user-agent"]).toContain("codex_cli_rs/");
    expect(events.at(-1)).toEqual({ type: "stop", reason: "tool_use" });
  });

  it("on 401 forces a token refresh and retries once", async () => {
    let now = 9_000_000;
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const validJwt = `${b64({})}.${b64({ exp: now / 1000 + 3600, chatgpt_account_id: "a" })}.s`;
    const store = new MemoryStore({ accessToken: validJwt, refreshToken: "r1" });
    let posts = 0;
    let refreshed = false;
    const fetchFn: typeof fetch = async (url) => {
      const u = String(url);
      if (u.endsWith("/oauth/token")) {
        refreshed = true;
        return new Response(JSON.stringify({ access_token: validJwt, refresh_token: "r2" }), { status: 200 });
      }
      posts += 1;
      if (posts === 1) return new Response("expired", { status: 401 });
      return new Response(sse([{ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } }]), { status: 200 });
    };
    const auth = new OpenAIChatGPTAuth({ store, fetchFn, now: () => now });
    const provider = new OpenAIChatGPTProvider({ model: "m", auth, fetchFn });
    const events = await collect(provider.stream(baseReq, new AbortController().signal));

    expect(posts).toBe(2);
    expect(refreshed).toBe(true);
    expect(events.at(-1)).toEqual({ type: "stop", reason: "end_turn" });
  });

  it("throws with the body on a non-401 HTTP error", async () => {
    const auth = new OpenAIChatGPTAuth({ store: new MemoryStore({ accessToken: futureJwt(), refreshToken: "r" }) });
    const fetchFn: typeof fetch = async () => new Response("rate limited", { status: 429 });
    const provider = new OpenAIChatGPTProvider({ model: "m", auth, fetchFn });
    await expect(collect(provider.stream(baseReq, new AbortController().signal))).rejects.toThrow(/HTTP 429/);
  });
});
