import { describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  parseAnthropicSse,
  toAnthropicRequest,
  type ModelEvent,
  type ModelRequest,
} from "@agentkitai/agentrig-core";

const baseReq: ModelRequest = {
  system: "be terse",
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: "run ls" }],
    },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", toolUseId: "t1", content: "a.txt", isError: false }],
    },
  ],
  tools: [{ name: "bash", description: "run", inputSchema: { type: "object" } }],
  maxTokens: 1024,
};

describe("toAnthropicRequest", () => {
  it("maps the unified schema to the Messages API shape", () => {
    const body = toAnthropicRequest(baseReq, "claude-test") as Record<string, unknown>;
    expect(body.model).toBe("claude-test");
    expect(body.system).toBe("be terse");
    expect(body.stream).toBe(true);
    expect(body.tools).toEqual([{ name: "bash", description: "run", input_schema: { type: "object" } }]);
    const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(messages[1]!.content[0]).toEqual({ type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } });
    expect(messages[2]!.content[0]).toEqual({ type: "tool_result", tool_use_id: "t1", content: "a.txt", is_error: false });
  });

  it("applies the system cache hint", () => {
    const body = toAnthropicRequest({ ...baseReq, cacheHints: { systemPrefix: true } }, "m") as Record<string, unknown>;
    expect(body.system).toEqual([{ type: "text", text: "be terse", cache_control: { type: "ephemeral" } }]);
  });
});

const sse = (events: Array<[string, unknown]>): string =>
  events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join("");

const toolUseStream = sse([
  ["message_start", { type: "message_start", message: { usage: { input_tokens: 11, cache_read_input_tokens: 5 } } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "run" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ning" } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu1", name: "bash", input: {} } }],
  ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"comm' } }],
  ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'and":"ls"}' } }],
  ["content_block_stop", { type: "content_block_stop", index: 1 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } }],
  ["message_stop", { type: "message_stop" }],
]);

async function collect(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("parseAnthropicSse", () => {
  it("assembles text deltas, tool_use JSON, usage, and stop", async () => {
    async function* chunks() {
      // split at awkward boundaries to exercise buffering
      for (let i = 0; i < toolUseStream.length; i += 17) yield toolUseStream.slice(i, i + 17);
    }
    const events = await collect(parseAnthropicSse(chunks()));
    expect(events).toEqual([
      { type: "text_delta", text: "run" },
      { type: "text_delta", text: "ning" },
      { type: "tool_use", id: "tu1", name: "bash", input: { command: "ls" } },
      { type: "usage", usage: { input: 11, output: 7, cacheRead: 5 } },
      { type: "stop", reason: "tool_use" },
    ]);
  });

  it("maps refusal through and carries unknown stop reasons in raw", async () => {
    const delta = (stopReason: string) =>
      sse([["message_delta", { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 1 } }]]);
    async function* refusal() {
      yield delta("refusal");
    }
    async function* unknown() {
      yield delta("pause_turn");
    }
    expect((await collect(parseAnthropicSse(refusal()))).at(-1)).toEqual({ type: "stop", reason: "refusal" });
    expect((await collect(parseAnthropicSse(unknown()))).at(-1)).toEqual({
      type: "stop",
      reason: "error",
      raw: "pause_turn",
    });
  });

  it("maps stop_sequence to end_turn", async () => {
    async function* one() {
      yield sse([["message_delta", { type: "message_delta", delta: { stop_reason: "stop_sequence" }, usage: { output_tokens: 1 } }]]);
    }
    const events = await collect(parseAnthropicSse(one()));
    expect(events.at(-1)).toEqual({ type: "stop", reason: "end_turn" });
  });

  it("does not throw on truncated tool-input JSON (max_tokens mid-tool-call)", async () => {
    async function* truncated() {
      yield sse([
        ["message_start", { type: "message_start", message: { usage: { input_tokens: 4 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu1", name: "bash", input: {} } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"comma' } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 2 } }],
        ["message_stop", { type: "message_stop" }],
      ]);
    }
    const events = await collect(parseAnthropicSse(truncated()));
    expect(events).toEqual([
      { type: "tool_use", id: "tu1", name: "bash", input: {} },
      { type: "usage", usage: { input: 4, output: 2 } },
      { type: "stop", reason: "max_tokens" },
    ]);
  });

  it("throws on an error event", async () => {
    async function* one() {
      yield sse([["error", { type: "error", error: { type: "overloaded_error", message: "busy" } }]]);
    }
    await expect(collect(parseAnthropicSse(one()))).rejects.toThrow(/overloaded_error: busy/);
  });
});

describe("AnthropicProvider.stream", () => {
  it("posts the mapped request and streams the SSE response — no network", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchFn: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init! };
      return new Response(toolUseStream, { status: 200 });
    };
    const provider = new AnthropicProvider({ apiKey: "k", model: "claude-test", fetchFn });
    const events = await collect(provider.stream(baseReq, new AbortController().signal));

    expect(captured!.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("k");
    expect(headers["anthropic-version"]).toBeDefined();
    expect(JSON.parse(String(captured!.init.body)).model).toBe("claude-test");
    expect(events.at(-1)).toEqual({ type: "stop", reason: "tool_use" });
  });

  it("throws with the response body on HTTP errors", async () => {
    const fetchFn: typeof fetch = async () => new Response('{"error":"bad key"}', { status: 401 });
    const provider = new AnthropicProvider({ apiKey: "k", model: "m", fetchFn });
    await expect(collect(provider.stream(baseReq, new AbortController().signal))).rejects.toThrow(/HTTP 401/);
  });
});
