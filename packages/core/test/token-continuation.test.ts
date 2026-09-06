import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { z } from "zod";
import { createAgent, SessionStore, RulePolicy, HarnessEvent,
  parseAnthropicSse, parseOpenAISse, parseResponsesSse, toAnthropicRequest, toOpenAIRequest,
  type AgentConfig, type ModelProvider, type ModelRequest, type ModelEvent, type Session,
} from "@agentkitai/agentrig-core";

class Script implements ModelProvider {
  readonly id = "script";
  readonly model = "fixture";
  readonly capabilities = { tools: true, parallelTools: true, caching: false, contextWindow: 100_000 };
  requests: ModelRequest[] = [];
  constructor(readonly responses: ModelEvent[][]) {}
  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(structuredClone(request));
    const response = this.responses.shift();
    if (!response) throw new Error("unexpected provider request");
    yield* response;
  }
}
const reply = (stop: "max_tokens" | "end_turn" | "tool_use", text = "partial", tool = false): ModelEvent[] => [
  { type: "text_delta", text },
  ...(tool ? [{ type: "tool_use" as const, id: text, name: "probe", input: { value: text } }] : []),
  { type: "usage", usage: { input: 3, output: 4, cacheRead: 2, cacheWrite: 1 } },
  { type: "stop", reason: stop },
];
let root: string;
let executions: string[];
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "agentrig-continuation-")); executions = []; });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
function config(provider: ModelProvider, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { provider, store: new SessionStore({ root }), systemPrompt: "fixture", repoMap: false,
    permissions: new RulePolicy([{ class: "read", decision: "allow" }]),
    tools: [{ name: "probe", description: "fixture", permission: "read", inputSchema: z.object({ value: z.string() }),
      execute: async ({ value }: { value: string }) => { executions.push(value); return { output: value, display: value }; } }],
    ...overrides };
}
async function collect(session: Session): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for await (const event of session.events) events.push(HarnessEvent.parse(event));
  await session.done;
  return events;
}

it("continues twice, preserving partial content and normal turn/token/cache/USD accounting", async () => {
  const provider = new Script([reply("max_tokens", "one"), reply("max_tokens", "two"), reply("end_turn", "three")]);
  const cfg = config(provider, { budget: { maxTurns: 3 }, pricing: { inputUsdPerMTok: 1, outputUsdPerMTok: 2 } });
  const session = createAgent(cfg).run("task", { cwd: root });
  const events = await collect(session);
  expect(await session.done).toMatchObject({ reason: "done", turns: 3, usage: { input: 9, output: 12, cacheRead: 6, cacheWrite: 3 } });
  expect(events.filter(e => e.type === "turn.continued")).toMatchObject([
    { n: 2, from: 1, attempt: 1, maxAttempts: 2 }, { n: 3, from: 2, attempt: 2, maxAttempts: 2 },
  ]);
  expect(provider.requests).toHaveLength(3);
  expect(provider.requests[2]!.messages.filter(m => m.role === "assistant").map(m => m.content[0])).toMatchObject([
    { text: "one" }, { text: "two" },
  ]);
  const nudges = provider.requests[2]!.messages.flatMap(m => m.content).filter(b => b.type === "text" && b.text.startsWith("[Platform continuation:"));
  expect(nudges).toHaveLength(2);
  expect(nudges.every(b => b.context?.principal === "platform" && b.context.authority === "advisory")).toBe(true);
  expect(events.some(e => e.type === "steer")).toBe(false);
  expect(await cfg.store.readAll(session.id)).toEqual(events);
  expect((await cfg.store.readSnapshot(session.id))!.usd).toBeGreaterThan(0);
});

it("never dispatches truncated calls, persists paired non-execution results, then permits a fresh complete call", async () => {
  const provider = new Script([reply("max_tokens", "incomplete", true), reply("tool_use", "complete", true), reply("end_turn")]);
  const cfg = config(provider);
  const session = createAgent(cfg).run("task", { cwd: root });
  const events = await collect(session);
  expect((await session.done).reason).toBe("done");
  expect(executions).toEqual(["complete"]);
  expect(events.filter(e => e.type === "tool.call").map(e => e.id)).toEqual(["complete"]);
  const results = provider.requests[1]!.messages.flatMap(m => m.content).filter(b => b.type === "tool_result");
  expect(results).toMatchObject([{ toolUseId: "incomplete", isError: true, context: { principal: "platform", authority: "advisory" } }]);
  expect(results[0]!.content).toContain("NOT executed");
  expect(await cfg.store.materializeMessages(session.id)).toEqual((await cfg.store.readSnapshot(session.id))!.messages);
});

it("exhausts after two continuations and leaves every truncated tool ID resumable", async () => {
  const provider = new Script([reply("max_tokens", "a", true), reply("max_tokens", "b", true), reply("max_tokens", "c", true)]);
  const cfg = config(provider);
  const session = createAgent(cfg).run("task", { cwd: root });
  const events = await collect(session);
  expect((await session.done).reason).toBe("error");
  expect(events.filter(e => e.type === "turn.continued")).toHaveLength(2);
  expect(events.some(e => e.type === "error" && /continuation limit exhausted/.test(e.message))).toBe(true);
  expect(executions).toEqual([]);
  const second = new Script([reply("end_turn")]);
  const resumed = createAgent({ ...cfg, provider: second }).run("", { resume: session.id });
  await collect(resumed);
  expect((await resumed.done).reason).toBe("done");
  const blocks = second.requests[0]!.messages.flatMap(m => m.content);
  expect(blocks.filter(b => b.type === "tool_use").map(b => b.id)).toEqual(["a", "b", "c"]);
  expect(blocks.filter(b => b.type === "tool_result").map(b => b.toolUseId)).toEqual(["a", "b", "c"]);
});

it("resets the consecutive limit only after a non-truncated response", async () => {
  const provider = new Script([reply("max_tokens"), reply("max_tokens"), reply("tool_use", "real", true),
    reply("max_tokens"), reply("max_tokens"), reply("end_turn")]);
  const session = createAgent(config(provider)).run("task", { cwd: root });
  const events = await collect(session);
  expect((await session.done).reason).toBe("done");
  expect(events.filter(e => e.type === "turn.continued").map(e => e.attempt)).toEqual([1, 2, 1, 2]);
});

it.each([{ maxTurns: 1 }, { maxTokens: 10 }, { maxUsd: 0.000001 }])("refuses a continuation at the ordinary budget gate: %j", async budget => {
  const provider = new Script([reply("max_tokens", "truncated", true)]);
  const session = createAgent(config(provider, { budget, pricing: { inputUsdPerMTok: 1, outputUsdPerMTok: 2 } })).run("task", { cwd: root });
  const events = await collect(session);
  expect((await session.done).reason).toBe("budget");
  expect(provider.requests).toHaveLength(1);
  expect(events.filter(e => e.type === "turn.continued")).toEqual([]);
  expect(executions).toEqual([]);
});

it.each(["veto", "abort", "time"] as const)("does not announce a retry blocked during pre_model: %s", async mode => {
  let session: Session;
  let clock = 0;
  const provider = new Script([reply("max_tokens")]);
  session = createAgent(config(provider, { now: () => clock, budget: { maxMinutes: 1 }, hooks: [{ point: "pre_model", handler: ({ turn }) => {
    if (turn === 2) {
      if (mode === "veto") return { action: "deny", reason: "fixture" };
      if (mode === "abort") session.control.abort();
      if (mode === "time") clock = 60_001;
    }
    return { action: "continue" };
  } }] })).run("task", { cwd: root });
  const events = await collect(session);
  expect((await session.done).reason).toBe(mode === "veto" ? "done" : mode === "abort" ? "aborted" : "budget");
  expect(events.filter(e => e.type === "turn.continued")).toEqual([]);
  expect(provider.requests).toHaveLength(1);
});

it.each(["anthropic", "openai", "responses"] as const)("continues actual %s parser truncation output without dispatching partial JSON", async kind => {
  const chunks = kind === "anthropic" ? [
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "cut", name: "probe", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"value' } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ] : kind === "openai" ? [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "cut", function: { name: "probe", arguments: '{"value' } }] } }] },
    { choices: [{ delta: {}, finish_reason: "length" }] },
  ] : [
    { type: "response.output_text.delta", delta: "partial" },
    { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 1, output_tokens: 1 } } },
  ];
  async function* wire() {
    for (const chunk of chunks) yield `${kind === "anthropic" ? `event: ${"type" in chunk ? chunk.type : ""}\n` : ""}data: ${JSON.stringify(chunk)}\n\n`;
  }
  const parsed = kind === "anthropic" ? parseAnthropicSse(wire()) : kind === "openai" ? parseOpenAISse(wire()) : parseResponsesSse(wire());
  const response: ModelEvent[] = [];
  for await (const event of parsed) response.push(event);
  expect(response.at(-1)).toMatchObject({ type: "stop", reason: "max_tokens" });
  const provider = new Script([response, reply("end_turn")]);
  const session = createAgent(config(provider)).run("task", { cwd: root });
  const events = await collect(session);
  expect((await session.done).reason).toBe("done");
  expect(events.filter(e => e.type === "turn.continued")).toHaveLength(1);
  expect(executions).toEqual([]);
  const next = provider.requests[1]!;
  const anthropic = JSON.stringify(toAnthropicRequest(next, "fixture"));
  const openai = JSON.stringify(toOpenAIRequest(next, "fixture"));
  if (kind !== "responses") {
    expect(anthropic).toContain('"tool_use_id":"cut"');
    expect(openai).toContain('"tool_call_id":"cut"');
    expect(anthropic).toContain("NOT executed");
    expect(openai).toContain("NOT executed");
  }
});
