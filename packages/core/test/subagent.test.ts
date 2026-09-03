import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAgent,
  RulePolicy,
  SessionStore,
  subagentTool,
  type AgentConfig,
  type AnyTool,
  type HarnessEvent,
  type ModelEvent,
  type ModelProvider,
  type Budget,
  type Pricing,
} from "@agentkitai/agentrig-core";

/** Each call to stream() consumes the next scripted turn. Shared by parent and child. */
class ScriptedProvider implements ModelProvider {
  readonly id = "fake";
  readonly model = "fake-1";
  readonly capabilities = { tools: true, parallelTools: true, caching: false, contextWindow: 100_000 };
  constructor(private readonly turns: ModelEvent[][]) {}
  async *stream(): AsyncIterable<ModelEvent> {
    yield* this.turns.shift() ?? [{ type: "stop", reason: "end_turn" }];
  }
}

const usage = (i: number, o: number): ModelEvent => ({ type: "usage", usage: { input: i, output: o } });
const stop = (r: "end_turn" | "tool_use"): ModelEvent => ({ type: "stop", reason: r });
const say = (text: string): ModelEvent => ({ type: "text_delta", text });
const spawn = (task: string, label?: string): ModelEvent[] => [
  { type: "tool_use", id: "s1", name: "subagent", input: { task, ...(label === undefined ? {} : { label }) } },
  usage(1, 1),
  stop("tool_use"),
];

const echoTool = (): AnyTool => ({
  name: "echo",
  description: "echo",
  inputSchema: z.object({ text: z.string() }),
  permission: "read",
  paths: () => [],
  execute: async (i: { text: string }) => ({ output: i.text, display: `echo: ${i.text}` }),
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentrig-sub-"));
});
afterEach(async () => {
  // An aborted child can still be flushing its JSONL while this walks the tree; on macOS that
  // surfaces as ENOTEMPTY (CI flaked exactly so). Retries let the straggler land, then delete.
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Slow enough that an abort can land while the child is mid-tool. */
const slowTool = (): AnyTool => ({
  name: "echo",
  description: "slow echo",
  inputSchema: z.object({ text: z.string() }),
  permission: "read",
  paths: () => [],
  execute: async (i: { text: string }, ctx) => {
    await new Promise((r) => setTimeout(r, 60));
    ctx.signal.throwIfAborted();
    return { output: i.text, display: `echo: ${i.text}` };
  },
});

interface HarnessOptions {
  maxDepth?: number;
  depth?: number;
  slow?: boolean;
  maxChildren?: number;
  maxChildTokens?: number;
  maxChildUsd?: number;
  pricing?: Pricing;
  childBudget?: Omit<Budget, "maxTurns">;
  /** A budget on the config `childConfig()` returns — which the tool must NOT inherit. */
  configBudget?: Budget;
  /** Extra tools the caller's `childConfig()` hands the child. */
  childExtraTools?: AnyTool[];
  /** Extra fields on the config `childConfig()` returns — what the tool derives a child's grace from. */
  childExtra?: Partial<AgentConfig>;
  /** Every config `createAgent` was called with, in order: child, then grandchild. */
  created?: AgentConfig[];
  /** The child's store, when a test needs to hold its log open (see `GatedStore`). */
  childStore?: () => SessionStore;
  /** Overrides applied to the PARENT's config only. */
  parent?: Partial<AgentConfig>;
}

/** The tool alone, plus a context to drive it with — no parent agent between test and tool. */
function bareTool(provider: ModelProvider, opts: HarnessOptions = {}) {
  const tool = harnessTool(provider, opts);
  const controller = new AbortController();
  const emitted: Array<{ type: string }> = [];
  const ctx = {
    cwd: root,
    sessionId: "parent",
    emit: (e: { type: string }) => void emitted.push(e),
    signal: controller.signal,
  };
  return { tool, ctx, controller, emitted };
}

function harnessTool(provider: ModelProvider, opts: HarnessOptions = {}) {
  const childTool = opts.slow === true ? slowTool() : echoTool();
  const allowAll = () =>
    new RulePolicy([{ class: "read", decision: "allow" }, { class: "exec", decision: "allow" }]);
  const base = (): AgentConfig => ({
    provider,
    tools: [childTool, ...(opts.childExtraTools ?? [])],
    permissions: allowAll(),
    systemPrompt: "child",
    store: new SessionStore({ root }),
    maxTokensPerTurn: 100,
    ...(opts.configBudget === undefined ? {} : { budget: opts.configBudget }),
    ...(opts.childExtra ?? {}),
  });
  return subagentTool({
    createAgent: (config) => {
      opts.created?.push(config);
      return createAgent(config);
    },
    childConfig: base,
    maxTurns: 5,
    ...(opts.maxDepth === undefined ? {} : { maxDepth: opts.maxDepth }),
    ...(opts.depth === undefined ? {} : { depth: opts.depth }),
    ...(opts.maxChildren === undefined ? {} : { maxChildren: opts.maxChildren }),
    ...(opts.maxChildTokens === undefined ? {} : { maxChildTokens: opts.maxChildTokens }),
    ...(opts.maxChildUsd === undefined ? {} : { maxChildUsd: opts.maxChildUsd }),
    ...(opts.pricing === undefined ? {} : { pricing: opts.pricing }),
    ...(opts.childBudget === undefined ? {} : { childBudget: opts.childBudget }),
  });
}

function harness(provider: ModelProvider, opts: HarnessOptions = {}) {
  const childTool = opts.slow === true ? slowTool() : echoTool();
  const allowAll = () =>
    new RulePolicy([{ class: "read", decision: "allow" }, { class: "exec", decision: "allow" }]);
  const base = (): AgentConfig => ({
    provider,
    tools: [childTool, ...(opts.childExtraTools ?? [])],
    permissions: allowAll(),
    systemPrompt: "child",
    store: new SessionStore({ root }),
    maxTokensPerTurn: 100,
    ...(opts.configBudget === undefined ? {} : { budget: opts.configBudget }),
    ...(opts.childStore === undefined ? {} : { store: opts.childStore() }),
    ...(opts.childExtra ?? {}),
  });
  const tool = subagentTool({
    createAgent: (config) => {
      opts.created?.push(config);
      return createAgent(config);
    },
    childConfig: base,
    maxTurns: 5,
    ...(opts.maxDepth === undefined ? {} : { maxDepth: opts.maxDepth }),
    ...(opts.depth === undefined ? {} : { depth: opts.depth }),
    ...(opts.maxChildren === undefined ? {} : { maxChildren: opts.maxChildren }),
    ...(opts.maxChildTokens === undefined ? {} : { maxChildTokens: opts.maxChildTokens }),
    ...(opts.maxChildUsd === undefined ? {} : { maxChildUsd: opts.maxChildUsd }),
    ...(opts.pricing === undefined ? {} : { pricing: opts.pricing }),
    ...(opts.childBudget === undefined ? {} : { childBudget: opts.childBudget }),
  });
  return createAgent({
    provider,
    tools: [childTool, tool],
    permissions: allowAll(),
    systemPrompt: "parent",
    store: new SessionStore({ root }),
    budget: { maxTurns: 10 },
    maxTokensPerTurn: 100,
    ...(opts.parent ?? {}),
  });
}

/**
 * A store whose `session.end` append waits on a gate: the one deterministic way to hold a
 * session's end open from outside it (an aborted session skips its hooks, so a slow
 * `session_end` hook cannot do it).
 */
class GatedStore extends SessionStore {
  entered = false;
  release!: () => void;
  private readonly gate = new Promise<void>((r) => (this.release = r));
  constructor() {
    super({ root });
  }
  override async append(sessionId: string, payload: Parameters<SessionStore["append"]>[1]): Promise<HarnessEvent> {
    if (payload.type === "session.end") {
      this.entered = true;
      await this.gate;
    }
    return super.append(sessionId, payload);
  }
}

async function collect(session: { events: AsyncIterable<HarnessEvent> }): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const e of session.events) out.push(e);
  return out;
}

describe("subagents are context isolation, not parallelism", () => {
  it("the parent receives the child's answer and nothing else", async () => {
    const provider = new ScriptedProvider([
      spawn("count the files"),
      // the child's turns
      [say("I looked at forty files and the answer is 42."), usage(1, 1), stop("end_turn")],
      // back in the parent
      [usage(1, 1), stop("end_turn")],
    ]);
    const session = harness(provider).run("do it", { cwd: root });
    const events = await collect(session);
    await session.done;

    const result = events.find((e) => e.type === "tool.result") as { display: string };
    const spawned = events.find((e) => e.type === "subagent.spawn") as { id: string };
    expect(result.display).toContain(`subagent session ${spawned.id}`);
    expect(result.display).toContain("the answer is 42");
  });

  it("the child's transcript stays in the CHILD's log", async () => {
    const provider = new ScriptedProvider([
      spawn("go and look"),
      [
        { type: "tool_use", id: "c1", name: "echo", input: { text: "child noise" } },
        usage(1, 1),
        stop("tool_use"),
      ],
      [say("done"), usage(1, 1), stop("end_turn")],
      [usage(1, 1), stop("end_turn")],
    ]);
    const session = harness(provider).run("do it", { cwd: root });
    const parentEvents = await collect(session);
    const summary = await session.done;

    // forwarding the child's events would defeat the isolation that is the whole reason to spawn
    expect(parentEvents.some((e) => e.type === "tool.result" && (e as { display: string }).display.includes("child noise"))).toBe(false);

    const spawned = parentEvents.find((e) => e.type === "subagent.spawn") as { id: string };
    const store = new SessionStore({ root });
    const childEvents: HarnessEvent[] = [];
    for await (const e of store.read(spawned.id)) childEvents.push(e);
    // ...and it really is in the child's own log
    expect(childEvents.some((e) => e.type === "tool.result" && (e as { display: string }).display.includes("child noise"))).toBe(true);
    expect(spawned.id).not.toBe(summary.id);
  });

  it("emits spawn and end, with how the child finished", async () => {
    const provider = new ScriptedProvider([
      spawn("a task", "counting files"),
      [say("42"), usage(1, 1), stop("end_turn")],
      [usage(1, 1), stop("end_turn")],
    ]);
    const session = harness(provider).run("do it", { cwd: root });
    const events = await collect(session);
    await session.done;

    const start = events.find((e) => e.type === "subagent.spawn") as { task: string };
    const end = events.find((e) => e.type === "subagent.end") as { reason?: string };
    // the label is what makes a trajectory readable; the full task would be a paragraph
    expect(start.task).toBe("counting files");
    expect(end.reason).toBe("done");
  });

  it("falls back to the task when no label is given", async () => {
    const provider = new ScriptedProvider([
      spawn("the whole task text"),
      [say("ok"), usage(1, 1), stop("end_turn")],
      [usage(1, 1), stop("end_turn")],
    ]);
    const session = harness(provider).run("do it", { cwd: root });
    const events = await collect(session);
    await session.done;
    expect((events.find((e) => e.type === "subagent.spawn") as { task: string }).task).toBe("the whole task text");
  });
});

describe("a subagent cannot run away", () => {
  it("refuses to nest past the depth limit — and creates nothing", async () => {
    const provider = new ScriptedProvider([spawn("recurse"), [usage(1, 1), stop("end_turn")]]);
    const created: AgentConfig[] = [];
    const session = harness(provider, { depth: 1, maxDepth: 1, created }).run("do it", { cwd: root });
    const events = await collect(session);
    const summary = await session.done;

    const result = events.find((e) => e.type === "tool.result") as { ok: boolean; display: string };
    // unbounded recursion here is a fork bomb with a token budget attached
    expect(result.ok).toBe(false);
    expect(result.display).toContain("may not nest");
    expect(events.some((e) => e.type === "subagent.spawn")).toBe(false);
    // the point of the guard is that no child EXISTS, not that an error was returned: a refusal
    // issued after the session was created and left running would satisfy the assertions above
    expect(created).toEqual([]);
    const logs = (await readdir(root)).filter((f) => f.endsWith(".jsonl"));
    expect(logs).toEqual([`${summary.id}.jsonl`]);
  });

  it("threads depth itself, so the child's own subagent tool is one level deeper", async () => {
    // parent spawns a child; the child spawns a grandchild; the grandchild has no subagent tool
    const provider = new ScriptedProvider([
      spawn("level 1"),
      spawn("level 2"),
      [say("bottom"), usage(1, 1), stop("end_turn")],
      [say("middle"), usage(1, 1), stop("end_turn")],
      [usage(1, 1), stop("end_turn")],
    ]);
    const created: AgentConfig[] = [];
    const session = harness(provider, { maxDepth: 2, created }).run("do it", { cwd: root });
    await collect(session);
    await session.done;

    expect(created).toHaveLength(2);
    // `depth` is threaded HERE, not by the caller: a guard that only fires when the caller
    // remembers to increment a counter never fires at all
    expect(created[0]!.tools.map((t) => t.name)).toContain("subagent");
    expect(created[1]!.tools.map((t) => t.name)).not.toContain("subagent");
  });

  it("replaces a subagent tool the caller's childConfig supplied", async () => {
    const forged: AnyTool = {
      name: "subagent",
      description: "an unbounded one, built at depth 0",
      inputSchema: z.object({ task: z.string() }),
      permission: "exec",
      execute: async () => ({ output: null, display: "" }),
    } as AnyTool;
    const provider = new ScriptedProvider([
      spawn("go"),
      [say("ok"), usage(1, 1), stop("end_turn")],
      [usage(1, 1), stop("end_turn")],
    ]);
    const created: AgentConfig[] = [];
    const session = harness(provider, { maxDepth: 1, childExtraTools: [forged], created }).run("do it", {
      cwd: root,
    });
    await collect(session);
    await session.done;

    // otherwise one line in a caller's wiring turns the depth limit back into a fork bomb
    expect(created[0]!.tools.map((t) => t.name)).not.toContain("subagent");
  });

  it("states the child's budget rather than inheriting the config's", async () => {
    const provider = new ScriptedProvider([
      spawn("go"),
      [say("ok"), usage(1, 1), stop("end_turn")],
      [usage(1, 1), stop("end_turn")],
    ]);
    const created: AgentConfig[] = [];
    const session = harness(provider, {
      // a caller whose childConfig carries the parent's budget must not give it to EVERY child
      configBudget: { maxTurns: 99, maxTokens: 5_000_000, maxUsd: 50, maxMinutes: 600 },
      childBudget: { maxTokens: 1000 },
      created,
    }).run("do it", { cwd: root });
    await collect(session);
    await session.done;

    expect(created[0]!.budget).toEqual({ maxTurns: 5, maxTokens: 1000 });
  });

  it("children of one session share a pool, so spawning cannot go on forever", async () => {
    const provider = new ScriptedProvider([
      spawn("one"),
      [say("a"), usage(1, 1), stop("end_turn")],
      spawn("two"),
      [say("b"), usage(1, 1), stop("end_turn")],
      spawn("three"),
      [usage(1, 1), stop("end_turn")],
    ]);
    const created: AgentConfig[] = [];
    const session = harness(provider, { maxChildren: 2, created }).run("do it", { cwd: root });
    const events = await collect(session);
    await session.done;

    expect(events.filter((e) => e.type === "subagent.spawn")).toHaveLength(2);
    expect(created).toHaveLength(2);
    const results = events.filter((e) => e.type === "tool.result") as Array<{ ok: boolean; display: string }>;
    expect(results.at(-1)!.ok).toBe(false);
    expect(results.at(-1)!.display).toContain("the limit");
  });

  it("meters what children actually spent, not just how many there were", async () => {
    const provider = new ScriptedProvider([
      spawn("one"),
      [say("a"), usage(40, 40), stop("end_turn")],
      spawn("two"),
      [usage(1, 1), stop("end_turn")],
    ]);
    const session = harness(provider, { maxChildTokens: 50 }).run("do it", { cwd: root });
    const events = await collect(session);
    await session.done;

    // a parent's own meter never sees a child's tokens — the child is a separate session
    expect(events.filter((e) => e.type === "subagent.spawn")).toHaveLength(1);
    const results = events.filter((e) => e.type === "tool.result") as Array<{ display: string }>;
    expect(results.at(-1)!.display).toContain("token allowance");
  });

  it("meters children in USD when pricing is given", async () => {
    const provider = new ScriptedProvider([
      spawn("one"),
      [say("a"), usage(1000, 1000), stop("end_turn")],
      spawn("two"),
      [usage(1, 1), stop("end_turn")],
    ]);
    const session = harness(provider, {
      maxChildUsd: 0.001,
      pricing: { inputUsdPerMTok: 1000, outputUsdPerMTok: 1000 },
    }).run("do it", { cwd: root });
    const events = await collect(session);
    await session.done;

    expect(events.filter((e) => e.type === "subagent.spawn")).toHaveLength(1);
    const results = events.filter((e) => e.type === "tool.result") as Array<{ display: string }>;
    expect(results.at(-1)!.display).toContain("USD allowance");
  });

  it("a child that exhausts its own budget is reported as an error, not as an answer", async () => {
    const provider = new ScriptedProvider([
      spawn("loop forever"),
      // the child keeps calling a tool and never finishes
      ...Array.from({ length: 8 }, () => [
        { type: "tool_use" as const, id: "c", name: "echo", input: { text: "again" } },
        usage(1, 1),
        stop("tool_use"),
      ]),
      [usage(1, 1), stop("end_turn")],
    ]);
    const session = harness(provider).run("do it", { cwd: root });
    const events = await collect(session);
    await session.done;

    const result = events.find((e) => e.type === "tool.result") as { ok: boolean; display: string };
    const spawned = events.find((e) => e.type === "subagent.spawn") as { id: string };
    expect(result.ok).toBe(false);
    expect(result.display).toContain(`subagent session ${spawned.id}`);
    expect(result.display).toMatch(/budget/);
    expect((events.find((e) => e.type === "subagent.end") as { reason?: string }).reason).toBe("budget");
  });

  it("a child gets its own smaller budget, not the parent's", async () => {
    // the parent allows 10 turns; the tool caps the child at 5
    const provider = new ScriptedProvider([
      spawn("spin"),
      ...Array.from({ length: 8 }, () => [
        { type: "tool_use" as const, id: "c", name: "echo", input: { text: "x" } },
        usage(1, 1),
        stop("tool_use"),
      ]),
      [usage(1, 1), stop("end_turn")],
    ]);
    const session = harness(provider).run("do it", { cwd: root });
    const events = await collect(session);
    await session.done;

    const spawned = events.find((e) => e.type === "subagent.spawn") as { id: string };
    const store = new SessionStore({ root });
    let turns = 0;
    for await (const e of store.read(spawned.id)) if (e.type === "turn.end") turns += 1;
    expect(turns).toBeLessThanOrEqual(5);
  });

  it("the pool bounds the TREE, not one level of it", async () => {
    // parent -> child -> grandchild, with maxChildren 2: the whole tree is 2 descendants, not 2
    // per level. A pool held per level made the bound `maxChildren ** maxDepth`.
    const provider = new ScriptedProvider([
      spawn("level 1"),
      spawn("level 2"),
      [say("bottom"), usage(1, 1), stop("end_turn")],
      // the child tries a second grandchild; the parent's pool is already full
      spawn("level 2 again"),
      [say("middle"), usage(1, 1), stop("end_turn")],
      [usage(1, 1), stop("end_turn")],
    ]);
    const created: AgentConfig[] = [];
    const session = harness(provider, { maxDepth: 2, maxChildren: 2, created }).run("do it", { cwd: root });
    await collect(session);
    await session.done;

    expect(created).toHaveLength(2);
  });

  it("a grandchild's spend is charged to every ancestor", async () => {
    const provider = new ScriptedProvider([
      spawn("level 1"),
      spawn("level 2"),
      // the grandchild burns the allowance
      [say("bottom"), usage(60, 60), stop("end_turn")],
      [say("middle"), usage(1, 1), stop("end_turn")],
      // the parent tries again; the tokens its grandchild spent are its own to account for
      spawn("another child"),
      [usage(1, 1), stop("end_turn")],
    ]);
    const created: AgentConfig[] = [];
    const session = harness(provider, { maxDepth: 2, maxChildren: 5, maxChildTokens: 100, created }).run(
      "do it",
      { cwd: root },
    );
    const events = await collect(session);
    await session.done;

    expect(created).toHaveLength(2);
    const results = events.filter((e) => e.type === "tool.result") as Array<{ display: string }>;
    expect(results.at(-1)!.display).toContain("token allowance");
  });

  it("charges a child's cap at spawn time, so two spawns in flight cannot both pass the gate", async () => {
    // the agent loop runs tool calls sequentially today, but `parallelTools` is advertised and
    // this tool is public API: a gate read before an await and written after it is not a gate
    const provider = new ScriptedProvider([
      [say("a"), usage(0, 0), stop("end_turn")],
      [say("b"), usage(0, 0), stop("end_turn")],
    ]);
    const { tool, ctx } = bareTool(provider, { maxChildTokens: 100, childBudget: { maxTokens: 100 }, slow: true });
    const [first, second] = await Promise.all([
      tool.execute({ task: "one" }, ctx),
      tool.execute({ task: "two" }, ctx),
    ]);

    const displays = [first.display, second.display];
    expect(displays.filter((d) => d.includes("token allowance"))).toHaveLength(1);
    // exactly one ran; charging only on completion let both through
    expect(displays.filter((d) => d.endsWith("\na") || d.endsWith("\nb"))).toHaveLength(1);
  });

  it("gives the reservation back when the child spends less than its cap", async () => {
    const provider = new ScriptedProvider([
      spawn("one"),
      [say("a"), usage(1, 1), stop("end_turn")],
      spawn("two"),
      [say("b"), usage(1, 1), stop("end_turn")],
      [usage(1, 1), stop("end_turn")],
    ]);
    const session = harness(provider, { maxChildTokens: 100, childBudget: { maxTokens: 90 } }).run("do it", {
      cwd: root,
    });
    const events = await collect(session);
    await session.done;

    // reserving without reconciling would make every child after the first impossible
    expect(events.filter((e) => e.type === "subagent.spawn")).toHaveLength(2);
  });

  it("defaults to eight children per session, with no wiring required", async () => {
    const provider = new ScriptedProvider([
      ...Array.from({ length: 8 }, () => [
        spawn("go"),
        [say("ok"), usage(1, 1), stop("end_turn")],
      ]).flat(),
      spawn("one too many"),
      [usage(1, 1), stop("end_turn")],
    ]);
    // an embedder that sets no limit at all still gets one
    const session = harness(provider).run("do it", { cwd: root });
    const events = await collect(session);
    await session.done;

    expect(events.filter((e) => e.type === "subagent.spawn")).toHaveLength(8);
    const results = events.filter((e) => e.type === "tool.result") as Array<{ display: string }>;
    expect(results.at(-1)!.display).toContain("the limit");
  });

  it("the parent's abort reaches the child", async () => {
    const provider = new ScriptedProvider([
      spawn("long job"),
      ...Array.from({ length: 20 }, () => [
        { type: "tool_use" as const, id: "c", name: "echo", input: { text: "x" } },
        usage(1, 1),
        stop("tool_use"),
      ]),
    ]);
    // a slow child, so the abort lands while it is still working rather than after it finished
    const session = harness(provider, { slow: true }).run("do it", { cwd: root });
    setTimeout(() => session.control.abort(), 80);
    const events = await collect(session);
    const summary = await session.done;

    // aborting a session must not leave its children running and billing
    expect(summary.reason).toBe("aborted");
    const spawned = events.find((e) => e.type === "subagent.spawn") as { id: string } | undefined;
    expect(spawned).toBeDefined();
    const store = new SessionStore({ root });
    const childEvents: HarnessEvent[] = [];
    for await (const e of store.read(spawned!.id)) childEvents.push(e);
    const end = childEvents.at(-1) as { type: string; reason?: string };
    expect(end.type).toBe("session.end");
    expect(end.reason).toBe("aborted");
  });

  it("the parent does not report itself ended until its aborted child has (#86)", async () => {
    // The abort races past the subagent tool, so without a grace the parent's summary resolved
    // while the child was still writing snapshot + session.end — and a reader of the child's log
    // saw a session with no end. Hold the child's end open at its store and check the parent
    // waits for it.
    const childStore = new GatedStore();
    const provider = new ScriptedProvider([
      spawn("long job"),
      ...Array.from({ length: 20 }, () => [
        { type: "tool_use" as const, id: "c", name: "echo", input: { text: "x" } },
        usage(1, 1),
        stop("tool_use"),
      ]),
    ]);
    const session = harness(provider, { slow: true, childStore: () => childStore }).run("do it", { cwd: root });
    setTimeout(() => session.control.abort(), 80);
    let parentDone = false;
    const done = session.done.then((s) => {
      parentDone = true;
      return s;
    });
    const eventsP = collect(session);

    const deadline = Date.now() + 5_000;
    while (!childStore.entered && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(childStore.entered).toBe(true);
    // the child is about to write session.end and cannot: the parent must still be waiting
    await new Promise((r) => setTimeout(r, 150));
    expect(parentDone).toBe(false);

    childStore.release();
    const summary = await done;
    const events = await eventsP;
    expect(summary.reason).toBe("aborted");
    const spawned = events.find((e) => e.type === "subagent.spawn") as { id: string };
    const childEvents: HarnessEvent[] = [];
    for await (const e of new SessionStore({ root }).read(spawned.id)) childEvents.push(e);
    expect((childEvents.at(-1) as { type: string }).type).toBe("session.end");
  });

  it("a child's session_end hooks run on the parent's abort, and are cut at the child's grace (#88, #86)", async () => {
    // the child's end hooks would otherwise outlive the parent's grace with nothing able to stop
    // them: the parent's signal fires once, and that once is the child's FIRST abort
    let hookOutcome = "not run";
    let hookReason: string | undefined;
    let abortedAt = 0;
    let cutAt = 0;
    const provider = new ScriptedProvider([
      spawn("long job"),
      ...Array.from({ length: 20 }, () => [
        { type: "tool_use" as const, id: "c", name: "echo", input: { text: "x" } },
        usage(1, 1),
        stop("tool_use"),
      ]),
    ]);
    const session = harness(provider, {
      slow: true,
      childExtra: {
        abortGraceMs: 200,
        hooks: [{
          point: "session_end",
          handler: (ctx) =>
            new Promise((resolve) => {
              hookReason = (ctx.summary as { reason: string }).reason;
              hookOutcome = "running";
              ctx.signal.addEventListener("abort", () => { hookOutcome = "cut"; cutAt = Date.now(); resolve({ action: "continue" }); }, { once: true });
              setTimeout(() => { if (hookOutcome === "running") { hookOutcome = "finished"; resolve({ action: "continue" }); } }, 5_000);
            }),
        }],
      },
    }).run("do it", { cwd: root });
    setTimeout(() => { abortedAt = Date.now(); session.control.abort(); }, 80);
    const events = await collect(session);
    const summary = await session.done;
    expect(summary.reason).toBe("aborted");
    // the child's hook ran (it used to be skipped outright), saw the abort, and was cut before
    // the parent's grace (200ms here: the child's is 100, the cut lands at 150) rather than
    // running its five seconds
    await new Promise((r) => setTimeout(r, 300));
    expect(hookReason).toBe("aborted");
    expect(hookOutcome).toBe("cut");
    expect(cutAt - abortedAt).toBeLessThan(200);
    const spawned = events.find((e) => e.type === "subagent.spawn") as { id: string };
    const childEvents = await new SessionStore({ root }).readAll(spawned.id);
    expect((childEvents.at(-1) as { type: string }).type).toBe("session.end");
  });

  it("a child still inside a tool that ignores the abort keeps its session_end hooks", async () => {
    // the child spends its whole grace waiting for the tool, THEN runs its hooks; a cut armed at
    // the child's grace landed first and the aborted child was never ingested — the #88 outcome
    let hookOutcome = "not run";
    const stubborn: AnyTool = {
      name: "echo",
      description: "ignores abort for a while",
      inputSchema: z.object({ text: z.string() }),
      permission: "read",
      paths: () => [],
      execute: async (i: { text: string }) => {
        await new Promise((r) => setTimeout(r, 350));
        return { output: i.text, display: `echo: ${i.text}` };
      },
    };
    const provider = new ScriptedProvider([
      spawn("long job"),
      ...Array.from({ length: 20 }, () => [
        { type: "tool_use" as const, id: "c", name: "echo", input: { text: "x" } },
        usage(1, 1),
        stop("tool_use"),
      ]),
    ]);
    const session = harness(provider, {
      childExtraTools: [stubborn],
      childExtra: {
        abortGraceMs: 400,
        tools: [stubborn],
        hooks: [{
          point: "session_end",
          handler: (ctx) =>
            new Promise((resolve) => {
              hookOutcome = "running";
              ctx.signal.addEventListener("abort", () => { hookOutcome = "cut"; resolve({ action: "continue" }); }, { once: true });
              setTimeout(() => { if (hookOutcome === "running") { hookOutcome = "finished"; resolve({ action: "continue" }); } }, 5_000);
            }),
        }],
      },
    }).run("do it", { cwd: root });
    setTimeout(() => session.control.abort(), 80);
    await collect(session);
    expect((await session.done).reason).toBe("aborted");
    await new Promise((r) => setTimeout(r, 400));
    // the child's grace is 200; its orphan wait spends it all; the hooks still ran and were cut
    expect(hookOutcome).toBe("cut");
  });

  it("the parent's second abort reaches a child's session_end hooks before the grace runs out", async () => {
    let hookOutcome = "not run";
    let cutAt = 0;
    const provider = new ScriptedProvider([
      spawn("long job"),
      ...Array.from({ length: 20 }, () => [
        { type: "tool_use" as const, id: "c", name: "echo", input: { text: "x" } },
        usage(1, 1),
        stop("tool_use"),
      ]),
    ]);
    const session = harness(provider, {
      slow: true,
      parent: { abortGraceMs: 4_000 },
      childExtra: {
        abortGraceMs: 4_000,
        hooks: [{
          point: "session_end",
          handler: (ctx) =>
            new Promise((resolve) => {
              hookOutcome = "running";
              ctx.signal.addEventListener("abort", () => { hookOutcome = "cut"; cutAt = Date.now(); resolve({ action: "continue" }); }, { once: true });
              // the second abort, fired once the hook is running and well inside the 2s child
              // grace: it must be what cuts the hook, not the grace timer
              setTimeout(() => session.control.abort(), 20);
            }),
        }],
      },
    }).run("do it", { cwd: root });
    const startedAt = Date.now();
    setTimeout(() => session.control.abort(), 80);
    await collect(session);
    const summary = await session.done;
    expect(summary.reason).toBe("aborted");
    await new Promise((r) => setTimeout(r, 100));
    expect(hookOutcome).toBe("cut");
    expect(cutAt - startedAt).toBeLessThan(1_500);
  it("a child's own session.start names its parent, so its log can dispute a forged spawn record (#104)", async () => {
    const provider = new ScriptedProvider([
      spawn("say hi"),
      [say("hi"), usage(1, 1), stop("end_turn")],
      [say("done"), usage(1, 1), stop("end_turn")],
    ]);
    const session = harness(provider).run("do it", { cwd: root });
    const events = await collect(session);
    await session.done;
    const spawned = events.find((e) => e.type === "subagent.spawn") as { id: string };
    const childEvents = await new SessionStore({ root }).readAll(spawned.id);
    expect(childEvents[0]).toMatchObject({ type: "session.start", parent: session.id });
    // the parent's own start names nobody
    expect(events[0]).toMatchObject({ type: "session.start" });
    expect(events[0]).not.toHaveProperty("parent");
  });

  it("a child's abort grace is half its parent's, floored at 1ms, from the one clamp (#96)", async () => {
    for (const [parentGrace, expected] of [[100, 50], [1, 1], [0, 1], [Number.NaN, 500], [-5, 500]] as const) {
      const created: AgentConfig[] = [];
      const provider = new ScriptedProvider([
        spawn("x"),
        [say("hi"), usage(1, 1), stop("end_turn")],
        [say("done"), usage(1, 1), stop("end_turn")],
      ]);
      // the tool derives the child's grace from the config `childConfig()` returns
      const session = harness(provider, { created, childExtra: { abortGraceMs: parentGrace } }).run("do it", { cwd: root });
      await collect(session);
      await session.done;
      expect(created[0]!.abortGraceMs, `parent ${parentGrace}`).toBe(expected);
    }
  });

  it("the abort grace is bounded, and running past it is recorded (#86)", async () => {
    // a child whose end never comes must not hold the parent forever: past `abortGraceMs` the
    // parent ends anyway and says what it left running
    const childStore = new GatedStore();
    const provider = new ScriptedProvider([
      spawn("long job"),
      ...Array.from({ length: 20 }, () => [
        { type: "tool_use" as const, id: "c", name: "echo", input: { text: "x" } },
        usage(1, 1),
        stop("tool_use"),
      ]),
    ]);
    const session = harness(provider, {
      slow: true,
      parent: { abortGraceMs: 100 },
      childStore: () => childStore,
    }).run("do it", { cwd: root });
    setTimeout(() => session.control.abort(), 80);
    const events = await collect(session);
    const summary = await session.done;

    expect(summary.reason).toBe("aborted");
    const note = events.find(
      (e) => e.type === "error" && /still running 100ms after abort \(tool subagent\)/.test((e as { message: string }).message),
    ) as { fatal: boolean } | undefined;
    expect(note).toBeDefined();
    expect(note!.fatal).toBe(false);
    // and the child really had not ended: the parent went first, as the note says
    const spawned = events.find((e) => e.type === "subagent.spawn") as { id: string };
    const childEvents: HarnessEvent[] = [];
    for await (const e of new SessionStore({ root }).read(spawned.id)) childEvents.push(e);
    expect((childEvents.at(-1) as { type: string }).type).not.toBe("session.end");
    // let the child finish so the tmpdir teardown does not race its last append
    childStore.release();
    await new Promise((r) => setTimeout(r, 200));
  });

  it("an abort always writes session.end, even when the grace timer is the only live handle (#86)", async () => {
    // Vitest keeps the event loop alive, so this can only be seen from a bare process: with the
    // grace timer unref'd, Node exited during the grace with no snapshot and no session.end and
    // exit code 0 — a silently truncated log, the exact drop #86 named as its worse candidate.
    const script = fileURLToPath(new URL("./fixtures/abort-exit.ts", import.meta.url));
    // core's own devDependency, so the path holds under a frozen-lockfile install too (the root
    // .bin only carried tsx by hoisting, which CI did not reproduce)
    const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
    const r = spawnSync(tsx, [script, root, "300"], { encoding: "utf8", timeout: 15_000 });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "{}") as { id?: string; reason?: string };
    expect(out.reason).toBe("aborted");
    expect(out.id).toBeDefined();
    const logEvents: HarnessEvent[] = [];
    for await (const e of new SessionStore({ root }).read(out.id!)) logEvents.push(e);
    const end = logEvents.at(-1) as { type: string; reason?: string };
    expect(end.type).toBe("session.end");
    expect(end.reason).toBe("aborted");
    expect(logEvents.some((e) => e.type === "error" && /still running 300ms after abort \(tool hang\)/.test((e as { message: string }).message))).toBe(true);
  });

  it("a child gets half its parent's grace, so a hung leaf never leaves the parent recording a live child (#86)", async () => {
    // abort reaches parent and child on the same signal; a child that waited as long as its
    // parent would always finish its log AFTER the parent gave up waiting for it
    // the hung leaf aborts the PARENT from inside itself, so the abort provably lands while the
    // child is mid-tool whatever the host's speed (a fixed delay was too short on a loaded runner)
    let abortParent: () => void = () => {};
    const hang: AnyTool = {
      name: "hang",
      description: "never returns and ignores its signal",
      inputSchema: z.object({}),
      permission: "read",
      paths: () => [],
      execute: () => {
        setTimeout(() => abortParent(), 10);
        return new Promise(() => {});
      },
    };
    const provider = new ScriptedProvider([
      spawn("long job"),
      [{ type: "tool_use", id: "h", name: "hang", input: {} }, usage(1, 1), stop("tool_use")],
    ]);
    const session = harness(provider, { childExtraTools: [hang] }).run("do it", { cwd: root });
    abortParent = () => session.control.abort();
    const events = await collect(session);
    const summary = await session.done;

    expect(summary.reason).toBe("aborted");
    const stillRunning = (e: HarnessEvent) => e.type === "error" && /still running/.test((e as { message: string }).message);
    // the parent waited its child out: nothing left running from its point of view
    expect(events.some(stillRunning)).toBe(false);
    const spawned = events.find((e) => e.type === "subagent.spawn") as { id: string };
    const childEvents: HarnessEvent[] = [];
    for await (const e of new SessionStore({ root }).read(spawned.id)) childEvents.push(e);
    expect((childEvents.at(-1) as { type: string }).type).toBe("session.end");
    // the child is the one that gave up on its hung tool, at half the default grace
    expect(childEvents.some((e) => stillRunning(e) && /500ms after abort \(tool hang\)/.test((e as { message: string }).message))).toBe(true);
  });

  it("a child spawned after the abort already landed is aborted at once (#86)", async () => {
    // an abort between the loop's top-of-turn check and the tool call (here: inside pre_tool)
    // reaches the subagent tool with its signal already aborted, and a listener added to an
    // already-aborted signal never fires — the child ran its whole budget with nobody to stop it
    let sessionRef: { control: { abort(): void } } | undefined;
    const provider = new ScriptedProvider([
      spawn("long job"),
      ...Array.from({ length: 5 }, () => [
        { type: "tool_use" as const, id: "c", name: "echo", input: { text: "x" } },
        usage(1, 1),
        stop("tool_use"),
      ]),
    ]);
    const session = harness(provider, {
      slow: true,
      parent: {
        hooks: [{
          point: "pre_tool",
          id: "abort-now",
          handler: () => {
            sessionRef?.control.abort();
            return { action: "continue" };
          },
        }],
      },
    }).run("do it", { cwd: root });
    sessionRef = session;
    const events = await collect(session);
    const summary = await session.done;

    expect(summary.reason).toBe("aborted");
    const spawned = events.find((e) => e.type === "subagent.spawn") as { id: string } | undefined;
    expect(spawned).toBeDefined();
    const childEvents: HarnessEvent[] = [];
    for await (const e of new SessionStore({ root }).read(spawned!.id)) childEvents.push(e);
    const end = childEvents.at(-1) as { type: string; reason?: string };
    expect(end.type).toBe("session.end");
    expect(end.reason).toBe("aborted");
    // it did not get to run its budget of five slow turns
    expect(childEvents.filter((e) => e.type === "tool.call").length).toBeLessThanOrEqual(1);
  });

  it("records the child's end in the parent's log even when the parent is the one aborting", async () => {
    const provider = new ScriptedProvider([
      spawn("long job"),
      ...Array.from({ length: 20 }, () => [
        { type: "tool_use" as const, id: "c", name: "echo", input: { text: "x" } },
        usage(1, 1),
        stop("tool_use"),
      ]),
    ]);
    const session = harness(provider, { slow: true }).run("do it", { cwd: root });
    setTimeout(() => session.control.abort(), 80);
    const events = await collect(session);
    await session.done;

    // a spawn with no matching end leaves a trace that can never say whether the child stopped
    expect(events.some((e) => e.type === "subagent.spawn")).toBe(true);
    const end = events.find((e) => e.type === "subagent.end") as { reason?: string } | undefined;
    expect(end?.reason).toBe("aborted");
  });

  it("keeps the answer when the child's last turn is a tool call, not a message", async () => {
    const provider = new ScriptedProvider([
      spawn("answer then tidy up"),
      // a child that states its conclusion and THEN calls one more tool is entirely normal
      [
        say("THE ANSWER IS 42"),
        { type: "tool_use" as const, id: "c1", name: "echo", input: { text: "tidy" } },
        usage(1, 1),
        stop("tool_use"),
      ],
      [usage(1, 1), stop("end_turn")],
      [usage(1, 1), stop("end_turn")],
    ]);
    const session = harness(provider).run("do it", { cwd: root });
    const events = await collect(session);
    await session.done;

    const result = events.find((e) => e.type === "tool.result") as { display: string };
    // keeping only the LAST turn's text told the parent the child had said nothing at all
    expect(result.display).toContain("THE ANSWER IS 42");
  });

  it("does not pass a preamble off as a conclusion", async () => {
    const provider = new ScriptedProvider([
      spawn("do the work"),
      // an opening remark, then real work, then a silent end: the remark is NOT the answer
      [
        say("Let me start by reading the files."),
        { type: "tool_use" as const, id: "c1", name: "echo", input: { text: "x" } },
        usage(1, 1),
        stop("tool_use"),
      ],
      [
        { type: "tool_use" as const, id: "c2", name: "echo", input: { text: "y" } },
        usage(1, 1),
        stop("tool_use"),
      ],
      [usage(1, 1), stop("end_turn")],
      [usage(1, 1), stop("end_turn")],
    ]);
    const session = harness(provider).run("do it", { cwd: root });
    const events = await collect(session);
    await session.done;

    const result = events.find((e) => e.type === "tool.result") as { display: string };
    // keeping the text is right — reporting it as the final word is not
    expect(result.display).toContain("Let me start by reading the files.");
    expect(result.display).toContain("final turn carried no message");
  });

  it("keeps what an aborted child said in the turn it never finished", async () => {
    // driven through the tool directly: when the PARENT is what aborted, its own tool result is
    // the abort, so this path is only visible to the tool's caller
    const provider = new ScriptedProvider([
      [
        say("PARTIAL FINDING: the bug is in parser.ts"),
        { type: "tool_use" as const, id: "c", name: "echo", input: { text: "x" } },
        usage(1, 1),
        stop("tool_use"),
      ],
      ...Array.from({ length: 10 }, () => [
        { type: "tool_use" as const, id: "c", name: "echo", input: { text: "x" } },
        usage(1, 1),
        stop("tool_use"),
      ]),
    ]);
    const { tool, ctx, controller } = bareTool(provider, { slow: true });
    const running = tool.execute({ task: "long job" }, ctx);
    // abort while the FIRST turn is still mid-tool, so that turn never reaches `turn.end` and the
    // text it carried exists only in the buffer the post-loop promotion reads
    setTimeout(() => controller.abort(), 25);
    const result = await running;

    expect(result.isError).toBe(true);
    // an interrupted child still reports what it had found: `turn.end` is emitted even for the
    // turn the abort landed in, so the text is not lost with it
    expect(result.display).toContain("PARTIAL FINDING");
  });

  it("a child that says nothing is reported as such rather than as an empty answer", async () => {
    const provider = new ScriptedProvider([
      spawn("say nothing"),
      [usage(1, 1), stop("end_turn")],
      [usage(1, 1), stop("end_turn")],
    ]);
    const session = harness(provider).run("do it", { cwd: root });
    const events = await collect(session);
    await session.done;
    const result = events.find((e) => e.type === "tool.result") as { display: string };
    expect(result.display).toContain("finished without a final message");
  });
});

describe("the subagent tool's own shape", () => {
  it("is exec: a child can do anything its tools can do", () => {
    const tool = subagentTool({ createAgent, childConfig: () => ({}) as AgentConfig });
    // claiming less would let `--allow read` run arbitrary writes through a child
    expect(tool.permission).toBe("exec");
    expect(tool.paths).toBeUndefined();
  });

  it("requires a non-empty task", () => {
    const tool = subagentTool({ createAgent, childConfig: () => ({}) as AgentConfig });
    expect(tool.inputSchema.safeParse({ task: "" }).success).toBe(false);
    expect(tool.inputSchema.safeParse({}).success).toBe(false);
    expect(tool.inputSchema.safeParse({ task: "do it" }).success).toBe(true);
  });
});
