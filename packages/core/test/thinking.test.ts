import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AnthropicProvider, OpenAIChatGPTProvider, OpenAIChatGPTAuth, createAgent, RulePolicy,
  SessionStore, subagentTool, MessageSchema, ThinkingBlockSchema, parseAnthropicSse, parseResponsesSse,
  toAnthropicRequest, toResponsesRequest, toOpenAIRequest, summarizeOlderTurns,
  type Message, type ModelProvider, type ModelRequest, type ModelEvent, type ThinkingBlock } from "@agentkitai/agentrig-core";
import { thinkingFromItem } from "../src/providers/thinking.js";

const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
const sse = (events: unknown[]) => events.map(e => `data: ${JSON.stringify(e)}\n\n`).join("");
const collect = async <T,>(values: AsyncIterable<T>) => { const result: T[] = []; for await (const value of values) result.push(value); return result; };
const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text, trust: "user" }] });
const req = (messages: Message[]): ModelRequest => ({ system: "fixture", messages, tools: [], maxTokens: 50 });
const item = { type: "reasoning", id: "rs_fixture", encrypted_content: "OPAQUE_SECRET_你好", summary: [{ type: "summary_text", text: "disclosed summary" }] };
const anthropic = { type: "thinking", thinking: "disclosed summary", signature: "OPAQUE_SECRET_你好" };

function wire(format: ThinkingBlock["format"], tool: boolean): string {
  if (format === "openai-responses") return sse([
    { type: "response.output_item.done", item },
    ...(tool ? [{ type: "response.output_item.done", item: { type: "function_call", call_id: "call", name: "read_fixture", arguments: "{}" } }] : [{ type: "response.output_text.delta", delta: "final answer" }]),
    { type: "response.completed", response: { usage: { input_tokens: 40, output_tokens: 5, input_tokens_details: { cached_tokens: 20 } } } },
  ]);
  return sse([
    { type: "message_start", message: { usage: { input_tokens: 20, cache_read_input_tokens: 20 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: anthropic.thinking } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "OPAQUE_" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SECRET_你好" } },
    { type: "content_block_stop", index: 0 },
    ...(tool ? [{ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call", name: "read_fixture" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } }, { type: "content_block_stop", index: 1 }]
      : [{ type: "content_block_delta", delta: { type: "text_delta", text: "final answer" } }]),
    { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 5 } },
  ]);
}

function provider(format: ThinkingBlock["format"], bodies: Record<string, unknown>[], firstTool = true): ModelProvider {
  let count = 0;
  const fetchFn: typeof fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(wire(format, firstTool && count++ === 0));
  };
  if (format === "anthropic") return new AnthropicProvider({ apiKey: "fixture", model: "fixture", fetchFn });
  const accessToken = `a.${Buffer.from(JSON.stringify({ exp: 4_000_000_000 })).toString("base64url")}.c`;
  return new OpenAIChatGPTProvider({ model: "fixture", fetchFn,
    auth: new OpenAIChatGPTAuth({ store: { async read() { return { accessToken, refreshToken: "fixture" }; }, async write() {} } }) });
}

it.each(["anthropic", "openai-responses"] as const)("%s role-restricted child retains exact reasoning without executing its excluded tool", async format => {
  const cwd = await mkdtemp(join(tmpdir(), "agentrig-role-thinking-")); roots.push(cwd);
  const store = new SessionStore({ root: join(cwd, "logs") }), bodies: Record<string, unknown>[] = [];
  let effects = 0, parentTurn = 0;
  const spawn = subagentTool({ createAgent, roles: [{ name: "restricted", tools: [], "model-role": "subagents", delegable: false,
    body: "ROLE_BODY", origin: "fixture:role", hash: "1".repeat(64) }],
    childConfig: () => ({ provider: provider(format, bodies), store, repoMap: false, systemPrompt: "child",
      permissions: new RulePolicy([], "allow"), tools: [{ name: "read_fixture", description: "excluded", permission: "read", inputSchema: z.object({}),
        async execute() { effects++; return { output: "effect", display: "effect" }; } }] }) });
  const parentProvider: ModelProvider = { id: "fixture", model: "fixture", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100000 },
    async *stream() { if (parentTurn++ === 0) { yield { type: "tool_use", id: "spawn", name: "subagent", input: { task: "inspect", agent: "restricted" } }; yield { type: "stop", reason: "tool_use" }; }
      else yield { type: "stop", reason: "end_turn" }; } };
  const session = createAgent({ provider: parentProvider, store, repoMap: false, systemPrompt: "parent", tools: [spawn], permissions: new RulePolicy([], "allow") }).run("delegate", { cwd });
  const events = await collect(session.events); await session.done;
  const started = events.find(e => e.type === "subagent.spawn"); if (started?.type !== "subagent.spawn") throw Error("missing child");
  expect(effects).toBe(0); expect(bodies).toHaveLength(2);
  const replay = format === "anthropic" ? (bodies[1]!.messages as Message[]).flatMap(m => m.content).filter(b => b.type === "thinking")
    : (bodies[1]!.input as { type: string }[]).filter(b => b.type === "reasoning");
  expect(replay).toEqual([format === "anthropic" ? anthropic : item]);
  const childEvents = await store.readAll(started.id);
  expect(childEvents).toContainEqual(expect.objectContaining({ type: "tool.denied", name: "read_fixture" }));
  expect((await store.materializeMessages(started.id)).flatMap(m => m.content).filter(b => b.type === "thinking")).toHaveLength(2);
  expect(JSON.stringify(events.filter(e => e.type === "tool.result"))).not.toContain("OPAQUE_SECRET");
});

it.each(["anthropic", "openai-responses"] as const)("%s actual SSE tool session, snapshot, fresh-provider resume and fork retain exact reasoning", async format => {
  const cwd = await mkdtemp(join(tmpdir(), "agentrig-thinking-")); roots.push(cwd);
  const store = new SessionStore({ root: join(cwd, "logs") });
  const bodies: Record<string, unknown>[] = []; let effects = 0;
  const config = { store, systemPrompt: "fixture", repoMap: false as const,
    permissions: new RulePolicy([{ class: "read" as const, decision: "allow" as const }]),
    tools: [{ name: "read_fixture", description: "fixture", permission: "read" as const, effects: "read-only" as const,
      paths: () => [], inputSchema: z.object({}), async execute() { effects++; return { output: "ok", display: "ok" }; } }] };
  const session = createAgent({ ...config, provider: provider(format, bodies) }).run("go", { cwd });
  const eventsPromise = collect(session.events);
  const outcome = await session.done; const events = await eventsPromise;
  expect(outcome.reason, JSON.stringify(events.filter(e => e.type === "error"))).toBe("done");
  expect(effects).toBe(1); expect(bodies).toHaveLength(2);
  const expected = format === "anthropic" ? anthropic : item;
  const replayItems = (body: Record<string, unknown>): unknown[] => format === "anthropic"
    ? (body.messages as Message[]).flatMap(m => m.content).filter(b => b.type === "thinking")
    : (body.input as { type: string }[]).filter(b => b.type === "reasoning");
  expect(replayItems(bodies[1]!)).toEqual([expected]);
  const blocks = events.flatMap(e => e.type === "message.append" ? e.message.content : []).filter(b => b.type === "thinking");
  expect(blocks).toHaveLength(2);
  expect(blocks.every(b => b.trust === "generated" && b.context?.authority === "advisory")).toBe(true);
  expect(JSON.parse(blocks[0]!.replay)).toEqual(expected);
  expect(events.filter(e => e.type === "model.delta").map(e => e.text).join("")).toBe("final answer");
  expect(events.filter(e => e.type === "model.response").map(e => e.usage.cacheRead)).toEqual([20, 20]);
  const original = await readFile(store.pathFor(session.id), "utf8");
  const snapshot = await store.readSnapshot(session.id);
  expect(snapshot!.messages.flatMap(m => m.content).filter(b => b.type === "thinking")).toEqual(blocks);
  const fork = await store.fork(session.id, events.at(-1)!.seq);
  for (const id of [session.id, fork]) {
    const nextBodies: Record<string, unknown>[] = [];
    const resumed = createAgent({ ...config, provider: provider(format, nextBodies, false) }).run("continue", { cwd, resume: id });
    const drain = collect(resumed.events); expect((await resumed.done).reason).toBe("done"); await drain;
    expect(replayItems(nextBodies[0]!)).toEqual([expected, expected]);
  }
  expect((await readFile(store.pathFor(session.id), "utf8")).startsWith(original)).toBe(true);
});

it("empty disclosed text, redacted blocks and fragmented signatures round-trip without invented prose", async () => {
  const values = [{ type: "thinking", thinking: "", signature: "sig" }, { type: "redacted_thinking", data: "redacted" }];
  const parsed = await collect(parseAnthropicSse((async function* () { yield sse(values.flatMap(content_block => [
    { type: "content_block_start", content_block }, { type: "content_block_stop" },
  ])); })()));
  const blocks = parsed.filter(e => e.type === "thinking").map(e => e.block);
  expect(blocks.map(b => b.text)).toEqual(["", ""]);
  expect((toAnthropicRequest(req([{ role: "assistant", content: blocks }]), "fixture").messages as Message[])[0]!.content).toEqual(values);
});

it("refuses wrong format, forged display text, nested/user reasoning and overflow before provider fetch", async () => {
  const block = thinkingFromItem("openai-responses", item);
  const messages: Message[] = [{ role: "assistant", content: [block] }];
  expect(() => toAnthropicRequest(req(messages), "fixture")).toThrow("reasoning replay");
  expect(() => toOpenAIRequest(req(messages), "fixture")).toThrow("reasoning replay");
  expect(() => toResponsesRequest(req([{ role: "assistant", content: [{ ...block, text: "forged" }] }]), "fixture")).toThrow("reasoning replay");
  expect(() => toResponsesRequest(req([{ role: "user", content: [block] }]), "fixture")).toThrow("reasoning replay");
  expect(() => toResponsesRequest(req([{ role: "assistant", content: [{ type: "tool_result", toolUseId: "x", content: [block] }] }]), "fixture")).toThrow("reasoning replay");
  expect(ThinkingBlockSchema.safeParse({ ...block, replay: "x".repeat(262_145) }).success).toBe(false);
  const bodies: Record<string, unknown>[] = [];
  await expect(collect(provider("anthropic", bodies).stream(req(messages), new AbortController().signal))).rejects.toThrow("reasoning replay");
  expect(bodies).toEqual([]);
});

it("completed old reasoning is omitted before summarization; retained tool chain remains byte-identical", async () => {
  const block = thinkingFromItem("openai-responses", item);
  const chain: Message[] = [{ role: "assistant", content: [block, { type: "tool_use", id: "c", name: "read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", toolUseId: "c", content: "ok" }] }];
  const messages: Message[] = [user("old"), { role: "assistant", content: [block] }, user("new"), ...chain];
  const original = JSON.stringify(messages); let calls = 0;
  const fake: ModelProvider = { id: "fake", model: "fake", capabilities: { tools: false, parallelTools: false, caching: false, contextWindow: 100 },
    async *stream(): AsyncIterable<ModelEvent> { calls++; yield { type: "text_delta", text: "summary" }; } };
  const strategy = summarizeOlderTurns({ keepLastMessages: 1 });
  const compacted = await strategy.compact(messages, fake);
  expect(calls).toBe(1); expect(compacted.slice(-2)).toEqual(chain);
  expect(compacted[1]!.content.some(b => b.type === "thinking")).toBe(false);
  expect(JSON.stringify(messages)).toBe(original);
  const again = await strategy.compact(compacted, fake);
  expect(again.slice(-2)).toEqual(chain);
  expect(() => MessageSchema.parse(again.at(-2))).not.toThrow();
});

it("bounds streamed reasoning and rejects unfinished blocks", async () => {
  const tooMany = Array.from({ length: 33 }, () => ({ type: "response.output_item.done", item }));
  await expect(collect(parseResponsesSse((async function* () { yield sse(tooMany); })()))).rejects.toThrow("retention bound");
  await expect(collect(parseAnthropicSse((async function* () { yield sse([{ type: "content_block_start", content_block: anthropic }]); })()))).rejects.toThrow("incomplete thinking");
});

it.each(["anthropic", "openai-responses"] as const)("%s local E1-style continuity control: omitted versus retained reasoning cache acknowledgement", async format => {
  // Deterministic collector policy, NOT a measurement of a live provider's cache.
  const block = thinkingFromItem(format, format === "anthropic" ? anthropic : item);
  const history: Message[] = [user("E1 repeatable tool fixture"), { role: "assistant", content: [block,
    { type: "tool_use", id: "call", name: "read_fixture", input: {} }] },
  { role: "user", content: [{ type: "tool_result", toolUseId: "call", content: "ok" }] }];
  const before = structuredClone(history); before[1]!.content = before[1]!.content.filter(b => b.type !== "thinking");
  const build = (messages: Message[]) => format === "anthropic" ? toAnthropicRequest(req(messages), "fixture") : toResponsesRequest(req(messages), "fixture");
  const receipt = async (messages: Message[]) => {
    const body = build(messages);
    const exact = JSON.stringify(body).includes(JSON.stringify(format === "anthropic" ? anthropic : item));
    const cache = exact ? 20 : 0;
    const response = format === "anthropic"
      ? sse([{ type: "message_start", message: { usage: { input_tokens: 40 - cache, cache_read_input_tokens: cache } } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }])
      : sse([{ type: "response.completed", response: { usage: { input_tokens: 40, output_tokens: 5, input_tokens_details: { cached_tokens: cache } } } }]);
    const events = await collect((format === "anthropic" ? parseAnthropicSse : parseResponsesSse)((async function* () { yield response; })()));
    const usage = events.find(e => e.type === "usage")!;
    if (usage.type !== "usage") throw new Error("missing usage");
    return { exact, cached: usage.usage.cacheRead ?? 0, total: usage.usage.input + (usage.usage.cacheRead ?? 0) };
  };
  expect(await receipt(before)).toEqual({ exact: false, cached: 0, total: 40 });
  expect(await receipt(history)).toEqual({ exact: true, cached: 20, total: 40 });
});

it("a live Responses provider cannot resurrect reasoning removed from canonical history", async () => {
  const bodies: Record<string, unknown>[] = [];
  const p = provider("openai-responses", bodies);
  await collect(p.stream(req([user("go")]), new AbortController().signal));
  await collect(p.stream(req([user("go"), { role: "assistant", content: [{ type: "tool_use", id: "call", name: "read_fixture", input: {} }] },
    { role: "user", content: [{ type: "tool_result", toolUseId: "call", content: "ok" }] }]), new AbortController().signal));
  expect((bodies[1]!.input as { type: string }[]).filter(i => i.type === "reasoning")).toEqual([]);
});

it.each(["anthropic", "openai-responses"] as const)("%s preserves one-byte UTF-8 fragments and refuses invalid encoding", async format => {
  const parser = format === "anthropic" ? parseAnthropicSse : parseResponsesSse;
  const parsed = await collect(parser((async function* () { for (const byte of Buffer.from(wire(format, true))) yield Uint8Array.of(byte); })()));
  const thought = parsed.find(e => e.type === "thinking");
  expect(thought?.type === "thinking" && thought.block.signature).toBe("OPAQUE_SECRET_你好");
  await expect(collect(parser((async function* () { yield Uint8Array.of(0xff); })()))).rejects.toThrow();
});

it("refuses crossed Anthropic signature boundaries and missing signatures", async () => {
  const events = [{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "signature_delta", signature: "wrong-block" } }];
  await expect(collect(parseAnthropicSse((async function* () { yield sse(events); })()))).rejects.toThrow("invalid thinking delta");
  expect(() => thinkingFromItem("anthropic", { type: "thinking", thinking: "", signature: "" })).toThrow("reasoning replay");
});

it.each([false, true])("review regression: thinking compaction makes one-call progress, multi-user=%s", async multiUser => {
  const block = thinkingFromItem("openai-responses", item);
  const turns: Message[] = Array.from({ length: 8 }, (_, n): Message[] => [
    { role: "assistant", content: [block, { type: "tool_use", id: `t${n}`, name: "read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", toolUseId: `t${n}`, content: "large tool result ".repeat(500) }] },
  ]).flat();
  const messages = [user("task"), ...(multiUser ? [{ role: "assistant" as const, content: [block] }, user("continue")] : []), ...turns];
  const before = JSON.stringify(messages); let calls = 0;
  const p: ModelProvider = { id: "fixture", model: "fixture", capabilities: { tools: false, parallelTools: false, caching: false, contextWindow: 1000 },
    async *stream(request) { calls++; expect(JSON.stringify(request)).not.toContain("OPAQUE_SECRET");
      expect(JSON.stringify(request)).not.toContain("disclosed summary"); yield { type: "text_delta", text: "SUMMARY" }; } };
  const result = await summarizeOlderTurns({ keepLastMessages: 4 }).compact(messages, p);
  expect(calls).toBe(1);
  expect(result[0]).toEqual(messages[0]);
  expect(result.slice(-4)).toEqual(turns.slice(-4));
  expect(JSON.stringify(result).length).toBeLessThan(before.length * 0.9);
  expect(JSON.stringify(messages)).toBe(before);
});

it("review regression: actual single-task reasoning runtime continues compacting across tool rounds", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agentrig-thinking-compact-")); roots.push(cwd);
  const store = new SessionStore({ root: join(cwd, "logs") }); let turns = 0, summaries = 0;
  const block = thinkingFromItem("openai-responses", item);
  const p: ModelProvider = { id: "fixture", model: "fixture", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 2200 },
    async *stream(request) {
      if (request.system.startsWith("You compress")) {
        summaries++; expect(JSON.stringify(request)).not.toContain("OPAQUE_SECRET");
        yield { type: "text_delta", text: "Concise completed work summary." };
        yield { type: "usage", usage: { input: 30, output: 8 } }; yield { type: "stop", reason: "end_turn" }; return;
      }
      yield { type: "thinking", block };
      if (++turns <= 10) { yield { type: "tool_use", id: `t${turns}`, name: "read_fixture", input: {} }; yield { type: "stop", reason: "tool_use" }; }
      else { yield { type: "text_delta", text: "done" }; yield { type: "stop", reason: "end_turn" }; }
      yield { type: "usage", usage: { input: Math.ceil(JSON.stringify(request).length / 4), output: 20 } };
    } };
  const session = createAgent({ provider: p, store, systemPrompt: "fixture", repoMap: false,
    compaction: summarizeOlderTurns({ keepLastMessages: 2 }), budget: { maxTurns: 12 },
    permissions: new RulePolicy([{ class: "read", decision: "allow" }]),
    tools: [{ name: "read_fixture", description: "fixture", permission: "read", effects: "read-only", paths: () => [], inputSchema: z.object({}),
      async execute() { return { output: "ok", display: "tool result ".repeat(500) }; } }] }).run("one task", { cwd });
  const drained = collect(session.events); const outcome = await session.done; const events = await drained;
  expect(outcome.reason).toBe("done");
  expect(summaries, JSON.stringify(events.filter(e => e.type === "error" || e.type === "model.request"))).toBeGreaterThan(2);
  expect(events.filter(e => e.type === "context.compact").length).toBeGreaterThan(2);
  expect(events.filter(e => e.type === "error").some(e => e.message.includes("could not reduce"))).toBe(false);
});

it("incompatible Responses history refuses before credential reads or OAuth refresh", async () => {
  let reads = 0, refreshes = 0, requests = 0;
  const jwt = (exp: number) => `a.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.c`;
  const auth = new OpenAIChatGPTAuth({
    store: { async read() { reads++; return { accessToken: jwt(1), refreshToken: "fixture" }; }, async write() {} },
    fetchFn: async () => { refreshes++; return new Response(JSON.stringify({ access_token: jwt(4_000_000_000), refresh_token: "fixture" }), { status: 200 }); },
  });
  const p = new OpenAIChatGPTProvider({ model: "fixture", auth, fetchFn: async () => { requests++; throw new Error("unexpected provider fetch"); } });
  const block = thinkingFromItem("anthropic", anthropic);
  await expect(collect(p.stream(req([{ role: "assistant", content: [block] }]), new AbortController().signal))).rejects.toThrow("reasoning replay");
  expect({ reads, refreshes, requests }).toEqual({ reads: 0, refreshes: 0, requests: 0 });
});
