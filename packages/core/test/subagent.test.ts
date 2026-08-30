import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  await rm(root, { recursive: true, force: true });
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

function harness(provider: ModelProvider, opts: { maxDepth?: number; depth?: number; slow?: boolean } = {}) {
  const childTool = opts.slow === true ? slowTool() : echoTool();
  const base = (): AgentConfig => ({
    provider,
    tools: [childTool],
    permissions: new RulePolicy([{ class: "read", decision: "allow" }]),
    systemPrompt: "child",
    store: new SessionStore({ root }),
    maxTokensPerTurn: 100,
  });
  const tool = subagentTool({
    createAgent,
    childConfig: base,
    maxTurns: 5,
    ...(opts.maxDepth === undefined ? {} : { maxDepth: opts.maxDepth }),
    ...(opts.depth === undefined ? {} : { depth: opts.depth }),
  });
  return createAgent({
    provider,
    tools: [childTool, tool],
    permissions: new RulePolicy([{ class: "read", decision: "allow" }, { class: "exec", decision: "allow" }]),
    systemPrompt: "parent",
    store: new SessionStore({ root }),
    budget: { maxTurns: 10 },
    maxTokensPerTurn: 100,
  });
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
  it("refuses to nest past the depth limit", async () => {
    const provider = new ScriptedProvider([spawn("recurse"), [usage(1, 1), stop("end_turn")]]);
    const session = harness(provider, { depth: 1, maxDepth: 1 }).run("do it", { cwd: root });
    const events = await collect(session);
    await session.done;

    const result = events.find((e) => e.type === "tool.result") as { ok: boolean; display: string };
    // unbounded recursion here is a fork bomb with a token budget attached
    expect(result.ok).toBe(false);
    expect(result.display).toContain("may not nest");
    expect(events.some((e) => e.type === "subagent.spawn")).toBe(false);
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
    expect(result.ok).toBe(false);
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
    if (spawned !== undefined) {
      const store = new SessionStore({ root });
      const childEvents: HarnessEvent[] = [];
      for await (const e of store.read(spawned.id)) childEvents.push(e);
      const end = childEvents.at(-1) as { type: string; reason?: string };
      expect(end.type).toBe("session.end");
      expect(["aborted", "budget", "done"]).toContain(end.reason);
    }
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
