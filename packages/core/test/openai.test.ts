import { describe, expect, it } from "vitest";
import {
  OpenAICompatibleProvider,
  parseOpenAISse,
  toOpenAIRequest,
  type ModelEvent,
  type ModelRequest,
} from "@agentkitai/agentrig-core";

const baseReq: ModelRequest = {
  system: "be terse",
  messages: [
    { role: "user", content: [{ type: "text", text: "run ls" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "running" },
        { type: "tool_use", id: "call_1", name: "bash", input: { command: "ls" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", toolUseId: "call_1", content: "a.txt" }],
    },
  ],
  tools: [{ name: "bash", description: "run", inputSchema: { type: "object" } }],
  maxTokens: 1024,
};

describe("toOpenAIRequest", () => {
  it("maps the unified schema to the Chat Completions shape", () => {
    const body = toOpenAIRequest(baseReq, "gpt-test") as Record<string, unknown>;
    expect(body.model).toBe("gpt-test");
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.tools).toEqual([
      { type: "function", function: { name: "bash", description: "run", parameters: { type: "object" } } },
    ]);
    expect(body.messages).toEqual([
      { role: "system", content: "be terse" },
      { role: "user", content: "run ls" },
      {
        role: "assistant",
        content: "running",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "a.txt" },
    ]);
  });

  it("maps an assistant message with only tool calls to null content", () => {
    const body = toOpenAIRequest(
      {
        ...baseReq,
        messages: [{ role: "assistant", content: [{ type: "tool_use", id: "c1", name: "bash", input: {} }] }],
      },
      "m",
    ) as { messages: Array<Record<string, unknown>> };
    expect(body.messages[1]).toMatchObject({ role: "assistant", content: null });
  });
});

const sse = (chunks: unknown[]): string => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";

const toolCallStream = sse([
  { choices: [{ delta: { content: "check" } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_9", function: { name: "bash", arguments: "" } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"comm' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] } }] },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  { choices: [], usage: { prompt_tokens: 12, completion_tokens: 6, prompt_tokens_details: { cached_tokens: 4 } } },
]);

async function collect(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("parseOpenAISse", () => {
  it("streams text, assembles tool-call arguments across chunks, and maps usage/stop", async () => {
    async function* chunks() {
      for (let i = 0; i < toolCallStream.length; i += 13) yield toolCallStream.slice(i, i + 13);
    }
    const events = await collect(parseOpenAISse(chunks()));
    expect(events).toEqual([
      { type: "text_delta", text: "check" },
      { type: "tool_use", id: "call_9", name: "bash", input: { command: "ls" } },
      { type: "usage", usage: { input: 12, output: 6, cacheRead: 4 } },
      { type: "stop", reason: "tool_use" },
    ]);
  });

  it("maps finish reasons: length, content_filter, unknown-with-raw", async () => {
    const single = (finish: string) =>
      (async function* () {
        yield sse([{ choices: [{ delta: {}, finish_reason: finish }] }]);
      })();
    expect((await collect(parseOpenAISse(single("length")))).at(-1)).toEqual({ type: "stop", reason: "max_tokens" });
    expect((await collect(parseOpenAISse(single("content_filter")))).at(-1)).toEqual({
      type: "stop",
      reason: "refusal",
    });
    expect((await collect(parseOpenAISse(single("weird")))).at(-1)).toEqual({
      type: "stop",
      reason: "error",
      raw: "weird",
    });
  });

  it("guards truncated tool-call JSON instead of throwing", async () => {
    async function* truncated() {
      yield sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "bash", arguments: '{"cut' } }] } }] },
        { choices: [{ delta: {}, finish_reason: "length" }] },
      ]);
    }
    const events = await collect(parseOpenAISse(truncated()));
    expect(events).toEqual([
      { type: "tool_use", id: "c1", name: "bash", input: {} },
      { type: "usage", usage: { input: 0, output: 0 } },
      { type: "stop", reason: "max_tokens" },
    ]);
  });

  it("throws on an error payload", async () => {
    async function* err() {
      yield sse([{ error: { message: "model overloaded" } }]);
    }
    await expect(collect(parseOpenAISse(err()))).rejects.toThrow(/model overloaded/);
  });
});

describe("OpenAICompatibleProvider.stream", () => {
  it("posts to <baseUrl>/chat/completions with a bearer token — no network", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchFn: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init! };
      return new Response(toolCallStream, { status: 200 });
    };
    const provider = new OpenAICompatibleProvider({ apiKey: "sk-k", model: "gpt-test", fetchFn });
    const events = await collect(provider.stream(baseReq, new AbortController().signal));

    expect(captured!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect((captured!.init.headers as Record<string, string>).authorization).toBe("Bearer sk-k");
    expect(events.at(-1)).toEqual({ type: "stop", reason: "tool_use" });
  });

  it("omits the auth header for keyless local servers", async () => {
    let headers: Record<string, string> = {};
    const fetchFn: typeof fetch = async (_url, init) => {
      headers = init!.headers as Record<string, string>;
      return new Response(sse([{ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }]), { status: 200 });
    };
    const provider = new OpenAICompatibleProvider({ model: "local", baseUrl: "http://localhost:11434/v1", fetchFn });
    await collect(provider.stream(baseReq, new AbortController().signal));
    expect(headers.authorization).toBeUndefined();
  });

  it("throws with the response body on HTTP errors", async () => {
    const fetchFn: typeof fetch = async () => new Response("bad key", { status: 401 });
    const provider = new OpenAICompatibleProvider({ apiKey: "k", model: "m", fetchFn });
    await expect(collect(provider.stream(baseReq, new AbortController().signal))).rejects.toThrow(/HTTP 401/);
  });
});
