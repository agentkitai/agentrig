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
    // AgentRig identifies itself; it must not claim to be another vendor's client
    expect(headers.originator).toBe("agentrig");
    expect(headers["chatgpt-account-id"]).toBe("acct_7");
    expect(headers["user-agent"]).toContain("agentrig/");
    expect(JSON.stringify(headers)).not.toContain("codex_cli_rs");
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
    const provider = new OpenAIChatGPTProvider({ model: "m", auth, fetchFn, retry: { sleep: async () => {} } });
    const events = await collect(provider.stream(baseReq, new AbortController().signal));

    expect(posts).toBe(2);
    expect(refreshed).toBe(true);
    expect(events.at(-1)).toEqual({ type: "stop", reason: "end_turn" });
  });

  it("throws with the body on a non-401 HTTP error", async () => {
    const auth = new OpenAIChatGPTAuth({ store: new MemoryStore({ accessToken: futureJwt(), refreshToken: "r" }) });
    const fetchFn: typeof fetch = async () => new Response("rate limited", { status: 429 });
    const provider = new OpenAIChatGPTProvider({ model: "m", auth, fetchFn, retry: { sleep: async () => {} } });
    await expect(collect(provider.stream(baseReq, new AbortController().signal))).rejects.toThrow(/HTTP 429/);
  });
});

describe("stop-reason fidelity (M1 invariant: unknowns must surface)", () => {
  it("surfaces a non-max_output_tokens incomplete reason as an error stop with raw", async () => {
    async function* s() {
      yield sse([
        { type: "response.output_text.delta", delta: "partial" },
        { type: "response.incomplete", response: { incomplete_details: { reason: "content_filter" }, usage: { input_tokens: 1, output_tokens: 1 } } },
      ]);
    }
    expect((await collect(parseResponsesSse(s()))).at(-1)).toEqual({ type: "stop", reason: "refusal" });
  });

  it("never reports an unknown incomplete reason as a clean end_turn", async () => {
    async function* s() {
      yield sse([
        { type: "response.incomplete", response: { incomplete_details: { reason: "some_future_reason" }, usage: { input_tokens: 1, output_tokens: 1 } } },
      ]);
    }
    expect((await collect(parseResponsesSse(s()))).at(-1)).toEqual({
      type: "stop",
      reason: "error",
      raw: "some_future_reason",
    });
  });

  it("treats an incomplete with no reason as an error, not a completion", async () => {
    async function* s() {
      yield sse([{ type: "response.incomplete", response: { usage: { input_tokens: 1, output_tokens: 1 } } }]);
    }
    expect((await collect(parseResponsesSse(s()))).at(-1)).toMatchObject({ type: "stop", reason: "error" });
  });
});

describe("tool-call id hygiene", () => {
  it("synthesizes distinct ids when the server omits call_id, preserving pairing", async () => {
    async function* s() {
      yield sse([
        { type: "response.output_item.done", item: { type: "function_call", name: "bash", arguments: "{}" } },
        { type: "response.output_item.done", item: { type: "function_call", name: "grep", arguments: "{}" } },
        { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
      ]);
    }
    const events = await collect(parseResponsesSse(s()));
    const ids = events.filter((e) => e.type === "tool_use").map((e) => e.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe("");
    expect(ids[0]).not.toBe(ids[1]); // two indistinguishable ids would break tool pairing
  });

  it("emits both calls for parallel tool use", async () => {
    async function* s() {
      yield sse([
        { type: "response.output_item.done", item: { type: "function_call", call_id: "a", name: "bash", arguments: "{}" } },
        { type: "response.output_item.done", item: { type: "function_call", call_id: "b", name: "grep", arguments: "{}" } },
        { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
      ]);
    }
    expect((await collect(parseResponsesSse(s()))).filter((e) => e.type === "tool_use").map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("input mapping fidelity", () => {
  it("preserves interleaved text/tool order in assistant history", () => {
    const body = toResponsesRequest(
      {
        ...baseReq,
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "before " },
              { type: "tool_use", id: "t1", name: "bash", input: {} },
              { type: "text", text: "after" },
            ],
          },
        ],
      },
      "m",
    ) as { input: Array<Record<string, unknown>> };
    expect(body.input.map((i) => i.type)).toEqual(["message", "function_call", "message"]);
  });

  it("asks for encrypted reasoning content so it can be replayed", () => {
    expect((toResponsesRequest(baseReq, "m") as Record<string, unknown>).include).toEqual([
      "reasoning.encrypted_content",
    ]);
  });
});

describe("reasoning replay (the live risk for turn 2 of a tool conversation)", () => {
  it("replays the previous response's reasoning items alongside its function call", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const streamWithReasoning = sse([
      { type: "response.output_item.done", item: { type: "reasoning", id: "rs_1", encrypted_content: "ENC" } },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "fc_9", name: "bash", arguments: "{}" } },
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    const fetchFn: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init!.body)) as Record<string, unknown>);
      return new Response(streamWithReasoning, { status: 200 });
    };
    const auth = new OpenAIChatGPTAuth({ store: new MemoryStore({ accessToken: futureJwt(), refreshToken: "r" }) });
    const provider = new OpenAIChatGPTProvider({ model: "m", auth, fetchFn, retry: { sleep: async () => {} } });

    // turn 1: the model asks for a tool
    await collect(provider.stream({ ...baseReq, messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] }, new AbortController().signal));

    // turn 2: history carries the tool_use + its result, as the agent loop builds it
    await collect(
      provider.stream(
        {
          ...baseReq,
          messages: [
            { role: "user", content: [{ type: "text", text: "go" }] },
            { role: "assistant", content: [{ type: "tool_use", id: "fc_9", name: "bash", input: {} }] },
            { role: "user", content: [{ type: "tool_result", toolUseId: "fc_9", content: "out" }] },
          ],
        },
        new AbortController().signal,
      ),
    );

    const input = bodies[1]!.input as Array<Record<string, unknown>>;
    // the reasoning item must accompany its function_call, and appear exactly once
    expect(input.filter((i) => i.type === "reasoning")).toHaveLength(1);
    expect(input.find((i) => i.type === "reasoning")).toMatchObject({ id: "rs_1", encrypted_content: "ENC" });
    const order = input.map((i) => i.type);
    expect(order.indexOf("reasoning")).toBeLessThan(order.indexOf("function_call"));
    expect(input.filter((i) => i.type === "function_call")).toHaveLength(1);
  });
});
