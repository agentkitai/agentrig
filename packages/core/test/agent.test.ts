import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  builtinTools,
  createAgent,
  RulePolicy,
  SessionStore,
  summarizeOlderTurns,
  toToolSpec,
  type Session,
  type AgentConfig,
  type AnyTool,
  type HarnessEvent,
  type ModelEvent,
  type ModelProvider,
  type ModelRequest,
} from "@agentkitai/agentrig-core";

/** Scripted provider: each run() turn consumes the next ModelEvent[] — no network anywhere. */
class FakeProvider implements ModelProvider {
  readonly id = "fake";
  readonly model = "fake-1";
  readonly capabilities = { tools: true, parallelTools: true, caching: false, contextWindow: 100_000 };
  readonly requests: ModelRequest[] = [];
  constructor(private readonly turns: ModelEvent[][]) {}
  async *stream(req: ModelRequest, _signal: AbortSignal): AsyncIterable<ModelEvent> {
    this.requests.push(structuredClone(req));
    const turn = this.turns.shift();
    if (!turn) throw new Error("FakeProvider: no scripted turn left");
    yield* turn;
  }
}

const echoTool = (): AnyTool => ({
  name: "echo",
  description: "echo text back",
  inputSchema: z.object({ text: z.string() }),
  permission: "read",
  execute: async (input: { text: string }) => ({ output: input.text, display: `echo: ${input.text}` }),
});

const usage = (input: number, output: number): ModelEvent => ({ type: "usage", usage: { input, output } });
const stop = (reason: "end_turn" | "tool_use" | "max_tokens" | "error"): ModelEvent => ({ type: "stop", reason });

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentrig-agent-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeConfig(provider: ModelProvider, overrides: Partial<AgentConfig> = {}): AgentConfig {
  let t = 1000;
  return {
    provider,
    tools: [echoTool()],
    permissions: new RulePolicy([{ class: "read", decision: "allow" }]),
    systemPrompt: "test system",
    store: new SessionStore({ root, now: () => t, newId: () => "sess1" }),
    now: () => t++,
    ...overrides,
  };
}

async function collect(session: { events: AsyncIterable<HarnessEvent> }): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const e of session.events) out.push(e);
  return out;
}

describe("agent loop", () => {
  it("runs a tool turn then finishes, with every event in the session store", async () => {
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "let me " },
        { type: "text_delta", text: "check" },
        { type: "tool_use", id: "t1", name: "echo", input: { text: "hi" } },
        usage(10, 5),
        stop("tool_use"),
      ],
      [{ type: "text_delta", text: "done" }, usage(20, 3), stop("end_turn")],
    ]);
    const config = makeConfig(provider);
    const session = createAgent(config).run("say hi", { cwd: "/w" });
    const events = await collect(session);
    const summary = await session.done;

    expect(events.map((e) => e.type)).toEqual([
      "session.start",
      "turn.start",
      "model.request",
      "model.delta",
      "model.delta",
      "model.response",
      "permission.request",
      "permission.decision",
      "tool.call",
      "tool.result",
      "turn.end",
      "turn.start",
      "model.request",
      "model.delta",
      "model.response",
      "turn.end",
      "session.end",
    ]);
    expect(events[0]).toMatchObject({ task: "say hi", provider: "fake", model: "fake-1", cwd: "/w" });
    expect(events.find((e) => e.type === "tool.result")).toMatchObject({ id: "t1", ok: true, display: "echo: hi" });
    expect(events.at(-1)).toMatchObject({ type: "session.end", reason: "done" });
    expect(summary).toMatchObject({ id: "sess1", reason: "done", turns: 2, usage: { input: 30, output: 8 } });

    // the store is the source of truth: the log replays identically to what subscribers saw
    expect(await config.store.readAll("sess1")).toEqual(events);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));

    // the second model request carries the assistant tool_use and our tool_result back
    expect(provider.requests[1]!.messages).toMatchObject([
      { role: "user", content: [{ type: "text", text: "say hi" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me check" },
          { type: "tool_use", id: "t1", name: "echo", input: { text: "hi" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "echo: hi" }] },
    ]);
    expect(provider.requests[0]!.system).toBe("test system");
  });

  it("denies by policy: tool.denied event, error tool_result to the model", async () => {
    const provider = new FakeProvider([
      [{ type: "tool_use", id: "t1", name: "echo", input: { text: "hi" } }, usage(1, 1), stop("tool_use")],
      [usage(1, 1), stop("end_turn")],
    ]);
    const session = createAgent(
      makeConfig(provider, { permissions: new RulePolicy([{ tool: "echo", decision: "deny" }]) }),
    ).run("t");
    const events = await collect(session);

    expect(events.some((e) => e.type === "tool.denied" && e.name === "echo")).toBe(true);
    expect(events.some((e) => e.type === "tool.call")).toBe(false);
    expect(provider.requests[1]!.messages.at(-1)!.content[0]).toMatchObject({
      type: "tool_result",
      toolUseId: "t1",
      isError: true,
    });
    expect((await session.done).reason).toBe("done");
  });

  it("resolves ask through onAsk, defaulting to deny headless", async () => {
    const script = (): ModelEvent[][] => [
      [{ type: "tool_use", id: "t1", name: "echo", input: { text: "x" } }, usage(1, 1), stop("tool_use")],
      [usage(1, 1), stop("end_turn")],
    ];
    const askPolicy = new RulePolicy([]); // everything falls through to ask

    const headless = createAgent(makeConfig(new FakeProvider(script()), { permissions: askPolicy })).run("t");
    const headlessEvents = await collect(headless);
    const decisions = headlessEvents.filter((e) => e.type === "permission.decision").map((e) => e.d);
    expect(decisions).toEqual(["ask", "deny"]);
    expect(headlessEvents.some((e) => e.type === "tool.denied")).toBe(true);

    const interactive = createAgent(
      makeConfig(new FakeProvider(script()), { permissions: askPolicy, onAsk: async () => "allow" }),
    ).run("t");
    const interactiveEvents = await collect(interactive);
    expect(interactiveEvents.filter((e) => e.type === "permission.decision").map((e) => e.d)).toEqual([
      "ask",
      "allow",
    ]);
    expect(interactiveEvents.some((e) => e.type === "tool.result" && e.ok)).toBe(true);
  });

  it("enforces the turn budget", async () => {
    const alwaysToolUse = Array.from({ length: 5 }, (): ModelEvent[] => [
      { type: "tool_use", id: "t", name: "echo", input: { text: "x" } },
      usage(1, 1),
      stop("tool_use"),
    ]);
    const session = createAgent(makeConfig(new FakeProvider(alwaysToolUse), { budget: { maxTurns: 2 } })).run("t");
    const events = await collect(session);
    const summary = await session.done;

    expect(summary.reason).toBe("budget");
    expect(summary.turns).toBe(2);
    expect(events.at(-1)).toMatchObject({ type: "session.end", reason: "budget" });
    expect(events.some((e) => e.type === "error" && !e.fatal && /turn budget/.test(e.message))).toBe(true);
  });

  it("enforces the token budget", async () => {
    const alwaysToolUse = Array.from({ length: 5 }, (): ModelEvent[] => [
      { type: "tool_use", id: "t", name: "echo", input: { text: "x" } },
      usage(600, 100),
      stop("tool_use"),
    ]);
    const session = createAgent(makeConfig(new FakeProvider(alwaysToolUse), { budget: { maxTokens: 1000 } })).run("t");
    await collect(session);
    const summary = await session.done;
    expect(summary.reason).toBe("budget");
    expect(summary.turns).toBe(2); // 700 tokens after turn 1 < 1000; 1400 after turn 2 trips it
  });

  it("surfaces provider failures as a fatal error and ends the session", async () => {
    const provider: ModelProvider = {
      id: "boom",
      model: "boom-1",
      capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 1000 },
      async *stream(): AsyncIterable<ModelEvent> {
        throw new Error("connection refused");
      },
    };
    const session = createAgent(makeConfig(provider)).run("t");
    const events = await collect(session);
    const summary = await session.done;

    expect(summary.reason).toBe("error");
    expect(events.some((e) => e.type === "error" && e.fatal && /connection refused/.test(e.message))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "session.end", reason: "error" });
  });

  it("reports unknown tools and invalid input back to the model without executing", async () => {
    const provider = new FakeProvider([
      [
        { type: "tool_use", id: "t1", name: "missing", input: {} },
        { type: "tool_use", id: "t2", name: "echo", input: { wrong: 1 } },
        usage(1, 1),
        stop("tool_use"),
      ],
      [usage(1, 1), stop("end_turn")],
    ]);
    const session = createAgent(makeConfig(provider)).run("t");
    const events = await collect(session);

    const results = events.filter((e) => e.type === "tool.result");
    expect(results).toMatchObject([
      { id: "t1", ok: false, display: "unknown tool: missing" },
      { id: "t2", ok: false },
    ]);
    expect(results[1]!.display).toContain("invalid input");
    const fedBack = provider.requests[1]!.messages.at(-1)!.content;
    expect(fedBack).toMatchObject([
      { type: "tool_result", toolUseId: "t1", isError: true },
      { type: "tool_result", toolUseId: "t2", isError: true },
    ]);
  });

  it("injects steer messages at the next turn boundary", async () => {
    const provider = new FakeProvider([[{ type: "text_delta", text: "ok" }, usage(1, 1), stop("end_turn")]]);
    const session = createAgent(makeConfig(provider)).run("t");
    session.control.steer("also check the README");
    const events = await collect(session);

    expect(events.some((e) => e.type === "steer" && e.message === "also check the README")).toBe(true);
    expect(provider.requests[0]!.messages).toMatchObject([
      { role: "user", content: [{ type: "text", text: "t" }] },
      { role: "user", content: [{ type: "text", text: "also check the README" }] },
    ]);
  });

  it("abort wins over a tool that ignores its signal", async () => {
    const hangingTool: AnyTool = {
      name: "hang",
      description: "never resolves",
      inputSchema: z.object({}),
      permission: "read",
      execute: () => new Promise(() => {}),
    };
    const provider = new FakeProvider([
      [{ type: "tool_use", id: "t1", name: "hang", input: {} }, usage(1, 1), stop("tool_use")],
    ]);
    const session = createAgent(makeConfig(provider, { tools: [hangingTool] })).run("t");
    setTimeout(() => session.control.abort(), 50);
    const events = await collect(session);
    const summary = await session.done;

    expect(summary.reason).toBe("aborted");
    expect(events.find((e) => e.type === "tool.result")).toMatchObject({ id: "t1", ok: false, display: "aborted" });
    expect(events.at(-1)).toMatchObject({ type: "session.end", reason: "aborted" });
  });

  it("events a tool emits via ctx.emit land in order through the loop", async () => {
    const emitter: AnyTool = {
      name: "toucher",
      description: "emits file.changed",
      inputSchema: z.object({}),
      permission: "write",
      execute: async (_input, ctx) => {
        ctx.emit({ type: "file.changed", path: "x.txt", op: "create", contentHash: "abcd" });
        return { output: null, display: "touched" };
      },
    };
    const provider = new FakeProvider([
      [{ type: "tool_use", id: "t1", name: "toucher", input: {} }, usage(1, 1), stop("tool_use")],
      [usage(1, 1), stop("end_turn")],
    ]);
    const config = makeConfig(provider, {
      tools: [emitter],
      permissions: new RulePolicy([{ class: "write", decision: "allow" }]),
    });
    const session = createAgent(config).run("t");
    const events = await collect(session);

    const types = events.map((e) => e.type);
    const call = types.indexOf("tool.call");
    expect(types.slice(call, call + 3)).toEqual(["tool.call", "file.changed", "tool.result"]);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(await config.store.readAll("sess1")).toEqual(events);
  });

  it("preserves the stream order of interleaved text and tool_use blocks", async () => {
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "before " },
        { type: "tool_use", id: "t1", name: "echo", input: { text: "hi" } },
        { type: "text_delta", text: "after" },
        usage(1, 1),
        stop("tool_use"),
      ],
      [usage(1, 1), stop("end_turn")],
    ]);
    const session = createAgent(makeConfig(provider)).run("t");
    await collect(session);
    await session.done;

    expect(provider.requests[1]!.messages[1]).toMatchObject({
      role: "assistant",
      content: [
        { type: "text", text: "before " },
        { type: "tool_use", id: "t1", name: "echo" },
        { type: "text", text: "after" },
      ],
    });
  });

  it("keeps tool_use/tool_result pairing one-to-one across a mixed allowed+denied batch", async () => {
    const provider = new FakeProvider([
      [
        { type: "tool_use", id: "t1", name: "echo", input: { text: "a" } },
        { type: "tool_use", id: "t2", name: "blocked", input: { text: "b" } },
        { type: "tool_use", id: "t3", name: "echo", input: { text: "c" } },
        usage(1, 1),
        stop("tool_use"),
      ],
      [usage(1, 1), stop("end_turn")],
    ]);
    const blocked: AnyTool = { ...echoTool(), name: "blocked" };
    const session = createAgent(
      makeConfig(provider, {
        tools: [echoTool(), blocked],
        permissions: new RulePolicy([
          { tool: "blocked", decision: "deny" },
          { class: "read", decision: "allow" },
        ]),
      }),
    ).run("t");
    await collect(session);
    await session.done;

    expect(provider.requests[1]!.messages.at(-1)!.content).toMatchObject([
      { type: "tool_result", toolUseId: "t1", content: "echo: a" },
      { type: "tool_result", toolUseId: "t2", isError: true },
      { type: "tool_result", toolUseId: "t3", content: "echo: c" },
    ]);
  });

  it("confines cwdOnly-allowed writes to the working directory", async () => {
    const provider = new FakeProvider([
      [
        { type: "tool_use", id: "t1", name: "write_file", input: { path: "inside.txt", content: "ok" } },
        { type: "tool_use", id: "t2", name: "write_file", input: { path: "../escape.txt", content: "nope" } },
        usage(1, 1),
        stop("tool_use"),
      ],
      [usage(1, 1), stop("end_turn")],
    ]);
    const inner = join(root, "project");
    await mkdir(inner, { recursive: true });
    const session = createAgent(
      makeConfig(provider, {
        tools: builtinTools(),
        permissions: new RulePolicy([{ class: "write", cwdOnly: true, decision: "allow" }]),
      }),
    ).run("t", { cwd: inner });
    const events = await collect(session);

    expect(events.some((e) => e.type === "tool.result" && e.id === "t1" && e.ok)).toBe(true);
    expect(events.some((e) => e.type === "tool.denied" && e.id === "t2")).toBe(true);
    expect(await readFile(join(inner, "inside.txt"), "utf8")).toBe("ok");
    await expect(readFile(join(root, "escape.txt"), "utf8")).rejects.toThrow();
  });

  it("ends with reason error when the final response is truncated at max_tokens", async () => {
    const provider = new FakeProvider([[{ type: "text_delta", text: "cut off mid-" }, usage(1, 1), stop("max_tokens")]]);
    const session = createAgent(makeConfig(provider)).run("t");
    const events = await collect(session);
    const summary = await session.done;

    expect(summary.reason).toBe("error");
    expect(events.some((e) => e.type === "error" && !e.fatal && /truncated at maxTokens/.test(e.message))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "session.end", reason: "error" });
  });

  it("treats refusal as a completed session with a non-fatal marker", async () => {
    const provider = new FakeProvider([[{ type: "text_delta", text: "I can't help with that." }, usage(1, 1), { type: "stop", reason: "refusal" }]]);
    const session = createAgent(makeConfig(provider)).run("t");
    const events = await collect(session);
    const summary = await session.done;

    expect(summary.reason).toBe("done");
    expect(events.some((e) => e.type === "error" && !e.fatal && /refused/.test(e.message))).toBe(true);
  });

  it("carries the raw stop reason into the fatal error for unknown stops", async () => {
    const provider = new FakeProvider([[usage(1, 1), { type: "stop", reason: "error", raw: "pause_turn" }]]);
    const session = createAgent(makeConfig(provider)).run("t");
    const events = await collect(session);
    expect((await session.done).reason).toBe("error");
    expect(events.some((e) => e.type === "error" && e.fatal && /pause_turn/.test(e.message))).toBe(true);
  });

  it("records a supervisor steer source, and an undelivered steer as a non-fatal error", async () => {
    const delivered = new FakeProvider([[{ type: "text_delta", text: "ok" }, usage(1, 1), stop("end_turn")]]);
    const s1 = createAgent(makeConfig(delivered)).run("t");
    s1.control.steer("focus on tests", "supervisor");
    const deliveredEvents = await collect(s1);
    expect(deliveredEvents.find((e) => e.type === "steer")).toMatchObject({
      source: "supervisor",
      message: "focus on tests",
    });

    // a steer issued mid-turn that never reaches a turn boundary is recorded, not lost
    let s2!: Session;
    const lateProvider: ModelProvider = {
      id: "late",
      model: "late-1",
      capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 1000 },
      async *stream(): AsyncIterable<ModelEvent> {
        s2.control.steer("too late", "supervisor");
        yield usage(1, 1);
        yield stop("end_turn");
      },
    };
    s2 = createAgent(makeConfig(lateProvider)).run("t");
    const lateEvents = await collect(s2);
    expect(lateEvents.some((e) => e.type === "steer")).toBe(false);
    const dropped = lateEvents.find((e) => e.type === "error" && /not delivered/.test(e.message));
    expect(dropped).toMatchObject({ fatal: false });
    expect(dropped!.message).toContain("too late");
    expect(lateEvents.at(-1)).toMatchObject({ type: "session.end" });
  });

  it("abort ends the session with reason aborted", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const provider: ModelProvider = {
      id: "slow",
      model: "slow-1",
      capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 1000 },
      async *stream(_req, signal): AsyncIterable<ModelEvent> {
        yield { type: "text_delta", text: "thinking" };
        await gate;
        if (signal.aborted) throw new Error("aborted");
        yield stop("end_turn");
      },
    };
    const session = createAgent(makeConfig(provider)).run("t");
    setTimeout(() => {
      session.control.abort();
      release();
    }, 10);
    await collect(session);
    expect((await session.done).reason).toBe("aborted");
  });
});

describe("compaction in the loop", () => {
  it("compacts past the window threshold and emits context.compact", async () => {
    const provider = new FakeProvider([
      // turn 1: small usage, no compaction
      [{ type: "tool_use", id: "t1", name: "echo", input: { text: "one" } }, usage(10, 5), stop("tool_use")],
      // turn 2: 80k of a 100k window — compaction triggers after this turn's tools
      [{ type: "tool_use", id: "t2", name: "echo", input: { text: "two" } }, usage(80_000, 100), stop("tool_use")],
      // the summarization call consumes the next scripted response
      [{ type: "text_delta", text: "SUMMARY OF EARLIER WORK" }, usage(50, 20), stop("end_turn")],
      // turn 3 runs on the compacted history
      [usage(100, 5), stop("end_turn")],
    ]);
    const session = createAgent(
      makeConfig(provider, { compaction: summarizeOlderTurns({ keepLastMessages: 2 }) }),
    ).run("t");
    const events = await collect(session);
    await session.done;

    const compact = events.find((e) => e.type === "context.compact");
    expect(compact).toBeDefined();
    expect(compact!.after).toBeLessThan(compact!.before);

    // turn 3's request sees: task, summary, and turn 2's pair verbatim — turn 1 summarized away
    const turn3 = provider.requests[3]!.messages;
    expect(turn3).toHaveLength(4);
    expect(turn3[0]!.content[0]).toMatchObject({ type: "text", text: "t" });
    expect(turn3[1]!.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("SUMMARY OF EARLIER WORK") });
    expect(turn3[2]!.content[0]).toMatchObject({ type: "tool_use", id: "t2" });
    expect(turn3[3]!.content[0]).toMatchObject({ type: "tool_result", toolUseId: "t2" });
  });
});

describe("compaction lifecycle", () => {
  it("abort wins over a hung summarization call", async () => {
    const provider = new FakeProvider([
      [{ type: "tool_use", id: "t1", name: "echo", input: { text: "x" } }, usage(90_000, 100), stop("tool_use")],
    ]);
    const hangingCompaction = {
      shouldCompact: () => true,
      compact: () => new Promise<never>(() => {}),
    };
    const session = createAgent(makeConfig(provider, { compaction: hangingCompaction })).run("t");
    setTimeout(() => session.control.abort(), 50);
    const events = await collect(session);
    expect((await session.done).reason).toBe("aborted");
    expect(events.at(-1)).toMatchObject({ type: "session.end", reason: "aborted" });
  });

  it("a failing summarization call degrades gracefully instead of killing the session", async () => {
    const provider = new FakeProvider([
      [{ type: "tool_use", id: "t1", name: "echo", input: { text: "x" } }, usage(90_000, 100), stop("tool_use")],
      [usage(10, 1), stop("end_turn")],
    ]);
    const failingCompaction = {
      shouldCompact: () => true,
      compact: async () => {
        throw new Error("summary endpoint 500");
      },
    };
    const session = createAgent(makeConfig(provider, { compaction: failingCompaction })).run("t");
    const events = await collect(session);
    expect((await session.done).reason).toBe("done");
    expect(events.some((e) => e.type === "error" && !e.fatal && /compaction failed/.test(e.message))).toBe(true);
    expect(events.some((e) => e.type === "context.compact")).toBe(false);
  });

  it("no-progress compaction warns once and stops retrying", async () => {
    const alwaysToolUse = Array.from({ length: 3 }, (): ModelEvent[] => [
      { type: "tool_use", id: "t", name: "echo", input: { text: "x" } },
      usage(90_000, 100),
      stop("tool_use"),
    ]);
    let calls = 0;
    const noopCompaction: AgentConfig["compaction"] = {
      shouldCompact: () => true,
      compact: async (m) => (calls++, m),
    };
    const session = createAgent(
      makeConfig(new FakeProvider([...alwaysToolUse, [usage(1, 1), stop("end_turn")]]), {
        compaction: noopCompaction,
      }),
    ).run("t");
    const events = await collect(session);
    await session.done;

    expect(calls).toBe(1);
    expect(events.some((e) => e.type === "context.compact")).toBe(false);
    expect(events.filter((e) => e.type === "error" && /could not reduce/.test(e.message))).toHaveLength(1);
  });

  it("warns once when the provider reports no usage, and still compacts on estimates", async () => {
    const provider = new FakeProvider([
      [{ type: "tool_use", id: "t1", name: "echo", input: { text: "x" } }, usage(0, 0), stop("tool_use")],
      [{ type: "tool_use", id: "t2", name: "echo", input: { text: "y" } }, usage(0, 0), stop("tool_use")],
      [usage(0, 0), stop("end_turn")],
    ]);
    let sawEstimate = 0;
    const spyCompaction: AgentConfig["compaction"] = {
      shouldCompact: ({ tokens }) => {
        if (tokens > 0) sawEstimate += 1;
        return false;
      },
      compact: async (m) => m,
    };
    const session = createAgent(makeConfig(provider, { compaction: spyCompaction })).run("t");
    const events = await collect(session);
    await session.done;

    expect(events.filter((e) => e.type === "error" && /no token usage/.test(e.message))).toHaveLength(1);
    // the check runs after each tool turn (turns 1 and 2); the final end_turn breaks before it
    expect(sawEstimate).toBe(2);
  });
});

describe("resume", () => {
  it("continues a session from its snapshot: same log, restored messages, appended task", async () => {
    const first = new FakeProvider([
      [{ type: "tool_use", id: "t1", name: "echo", input: { text: "hi" } }, usage(10, 5), stop("tool_use")],
      [{ type: "text_delta", text: "done" }, usage(20, 3), stop("end_turn")],
    ]);
    const config = makeConfig(first);
    const s1 = createAgent(config).run("say hi", { cwd: "/w" });
    await collect(s1);
    const firstSummary = await s1.done;
    expect(firstSummary.reason).toBe("done");

    const second = new FakeProvider([[{ type: "text_delta", text: "again" }, usage(5, 2), stop("end_turn")]]);
    const s2 = createAgent({ ...config, provider: second }).run("now say bye", { resume: "sess1" });
    const resumedEvents = await collect(s2);
    const summary = await s2.done;

    expect(summary).toMatchObject({ id: "sess1", reason: "done", turns: 3 });
    expect(summary.usage).toMatchObject({ input: 35, output: 10 });
    expect(resumedEvents[0]).toMatchObject({ type: "session.resume", task: "now say bye", cwd: "/w" });

    // the resumed model call carries the whole prior conversation plus the new task
    const msgs = second.requests[0]!.messages;
    expect(msgs[0]!.content[0]).toMatchObject({ type: "text", text: "say hi" });
    expect(msgs.at(-1)!.content[0]).toMatchObject({ type: "text", text: "now say bye" });
    expect(msgs.some((m) => m.content.some((b) => b.type === "tool_result"))).toBe(true);

    // one log, contiguous seq across both runs, exactly two session boundaries
    const all = await config.store.readAll("sess1");
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i));
    expect(all.filter((e) => e.type === "session.end")).toHaveLength(2);
    expect(all.some((e) => e.type === "session.resume")).toBe(true);
  });

  it("keeps a max_tokens-truncated tool call resumable by synthesizing an error tool_result", async () => {
    const first = new FakeProvider([
      // truncated mid-tool-call: tool_use emitted, but stop is max_tokens so it never runs
      [{ type: "tool_use", id: "t1", name: "echo", input: {} }, usage(10, 5), stop("max_tokens")],
    ]);
    const config = makeConfig(first);
    const s1 = createAgent(config).run("task", { cwd: "/w" });
    await collect(s1);
    expect((await s1.done).reason).toBe("error");

    const snap = await config.store.readSnapshot("sess1");
    expect(snap!.messages.at(-1)).toMatchObject({
      role: "user",
      content: [{ type: "tool_result", toolUseId: "t1", isError: true }],
    });

    // the resumed request must be valid: every tool_use answered before the new task
    const second = new FakeProvider([[usage(1, 1), stop("end_turn")]]);
    const s2 = createAgent({ ...config, provider: second }).run("carry on", { resume: "sess1" });
    await collect(s2);
    expect((await s2.done).reason).toBe("done");
    const msgs = second.requests[0]!.messages;
    const toolUseIds = msgs.flatMap((m) => m.content.filter((b) => b.type === "tool_use").map((b) => b.id));
    const resultIds = msgs.flatMap((m) => m.content.filter((b) => b.type === "tool_result").map((b) => b.toolUseId));
    expect(resultIds).toEqual(toolUseIds);
  });

  it("a second concurrent resume fails loudly without touching the log", async () => {
    const provider = new FakeProvider([[usage(1, 1), stop("end_turn")]]);
    const config = makeConfig(provider);
    const s1 = createAgent(config).run("task");
    await collect(s1);
    await s1.done;
    const logBefore = await config.store.readAll("sess1");

    const release = await config.store.acquireLock("sess1"); // simulate another process mid-resume
    const blocked = createAgent({ ...config, provider: new FakeProvider([]) }).run("more", { resume: "sess1" });
    const blockedEvents = await collect(blocked);
    const summary = await blocked.done;

    expect(summary.reason).toBe("error");
    expect(summary.error).toMatch(/locked by another process/);
    expect(blockedEvents).toEqual([]); // nothing appended — the other process owns the log
    expect(await config.store.readAll("sess1")).toEqual(logBefore);

    await release();
    const resumed = createAgent({ ...config, provider: new FakeProvider([[usage(1, 1), stop("end_turn")]]) }).run(
      "more",
      { resume: "sess1" },
    );
    await collect(resumed);
    expect((await resumed.done).reason).toBe("done");
  });

  it("a resumed run that completes no turn never clobbers the previous snapshot", async () => {
    const config = makeConfig(new FakeProvider([[usage(1, 1), stop("end_turn")]]), {
      budget: { maxTurns: 1 },
    });
    const s1 = createAgent(config).run("task");
    await collect(s1);
    expect((await s1.done).reason).toBe("done");
    const goodSnap = await config.store.readSnapshot("sess1");

    // budget already spent: the resume appends its task, hits the budget, and must not save
    const s2 = createAgent({ ...config, provider: new FakeProvider([]) }).run("retry", { resume: "sess1" });
    await collect(s2);
    expect((await s2.done).reason).toBe("budget");
    expect(await config.store.readSnapshot("sess1")).toEqual(goodSnap);
  });

  it("fails loudly when no snapshot exists", async () => {
    const provider = new FakeProvider([]);
    const session = createAgent(makeConfig(provider, { store: new SessionStore({ root, newId: () => "x" }) })).run(
      "t",
      { resume: "ghost" },
    );
    const events = await collect(session);
    const summary = await session.done;

    expect(summary.reason).toBe("error");
    expect(events.some((e) => e.type === "error" && e.fatal && /no snapshot/.test(e.message))).toBe(true);
    expect(provider.requests).toHaveLength(0);
  });
});

describe("toToolSpec", () => {
  it("derives a JSON Schema object from the zod schema", () => {
    const spec = toToolSpec(echoTool());
    expect(spec.name).toBe("echo");
    expect(spec.inputSchema).toMatchObject({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    });
    expect(spec.inputSchema.$schema).toBeUndefined();
  });
});

describe("SessionControl.record", () => {
  it("appends a supervisor event through the same chain, sharing one seq order", async () => {
    const provider = new FakeProvider([[usage(1, 1), stop("end_turn")]]);
    const session = createAgent(makeConfig(provider)).run("t", { cwd: root });
    session.control.record({
      type: "supervisor.signal",
      signal: { type: "loop", confidence: 0.9, evidence: ["e"], window: [0, 1] },
    });
    const events = await collect(session);
    await session.done;

    const recorded = events.filter((e) => e.type === "supervisor.signal");
    expect(recorded).toHaveLength(1);
    // it goes through store.append like everything else: no seq collision, no gap
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
  });

  it("is dropped after the session has ended, so session.end stays the last line", async () => {
    const provider = new FakeProvider([[usage(1, 1), stop("end_turn")]]);
    const session = createAgent(makeConfig(provider)).run("t", { cwd: root });
    await collect(session);
    const summary = await session.done;

    session.control.record({ type: "supervisor.intervention", intervention: { type: "force_replan" } });
    await new Promise((r) => setTimeout(r, 20));

    const lines = (await readFile(join(root, `${summary.id}.jsonl`), "utf8")).trim().split("\n");
    const parsed = lines.map((l) => JSON.parse(l) as HarnessEvent);
    expect(parsed.at(-1)!.type).toBe("session.end");
    expect(parsed.some((e) => e.type === "supervisor.intervention")).toBe(false);
  });
});
