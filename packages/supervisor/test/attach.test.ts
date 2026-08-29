import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAgent,
  RulePolicy,
  SessionStore,
  type AnyTool,
  type HarnessEvent,
  type Intervention,
  type ModelEvent,
  type ModelProvider,
  type ModelRequest,
  type Session,
  type Signal,
} from "@agentkitai/agentrig-core";
import {
  attach,
  initialState,
  LadderPolicy,
  loopDetector,
  reduce,
  RubricGrader,
  supervise,
  TrajectoryReviewer,
  type Detector,
  type Reviewer,
} from "@agentkitai/agentrig-supervisor";

/** Repeats the same tool call forever, which is exactly what `loop` exists to catch. No network. */
class LoopingProvider implements ModelProvider {
  readonly id = "fake";
  readonly model = "fake-1";
  readonly capabilities = { tools: true, parallelTools: true, caching: false, contextWindow: 100_000 };
  readonly systems: string[] = [];
  turns = 0;
  constructor(private readonly limit = 50) {}
  async *stream(req: ModelRequest, _signal: AbortSignal): AsyncIterable<ModelEvent> {
    this.systems.push(JSON.stringify(req.messages));
    this.turns += 1;
    if (this.turns > this.limit) {
      yield { type: "stop", reason: "end_turn" };
      return;
    }
    yield { type: "tool_use", id: `t${this.turns}`, name: "spin", input: { same: "input" } };
    yield { type: "usage", usage: { input: 10, output: 5 } };
    yield { type: "stop", reason: "tool_use" };
  }
}

/**
 * Does real work every turn: re-reads one spec file (identical tool input, on purpose) and
 * writes a NEW file. This is the shape that a naive `loop` detector aborted at turn 6.
 */
class ProductiveProvider implements ModelProvider {
  readonly id = "fake";
  readonly model = "fake-1";
  readonly capabilities = { tools: true, parallelTools: true, caching: false, contextWindow: 100_000 };
  turns = 0;
  constructor(private readonly limit = 8) {}
  async *stream(_req: ModelRequest, _signal: AbortSignal): AsyncIterable<ModelEvent> {
    this.turns += 1;
    if (this.turns > this.limit) {
      yield { type: "stop", reason: "end_turn" };
      return;
    }
    yield { type: "tool_use", id: `r${this.turns}`, name: "reread", input: { path: "SPEC.md" } };
    yield { type: "tool_use", id: `w${this.turns}`, name: "advance", input: { n: this.turns } };
    yield { type: "usage", usage: { input: 10, output: 5 } };
    yield { type: "stop", reason: "tool_use" };
  }
}

const rereadTool = (): AnyTool => ({
  name: "reread",
  description: "re-reads the same file",
  inputSchema: z.object({ path: z.string() }),
  permission: "read",
  execute: async () => ({ output: "spec text", display: "spec text" }),
});

/** Writes genuinely new content each call, emitting file.changed like a real write tool. */
const advanceTool = (): AnyTool => ({
  name: "advance",
  description: "writes a new file",
  inputSchema: z.object({ n: z.number() }),
  permission: "write",
  execute: async (input: { n: number }, ctx) => {
    ctx.emit({ type: "file.changed", path: `src/f${input.n}.ts`, op: "create", contentHash: `h${input.n}` });
    return { output: "written", display: `wrote src/f${input.n}.ts` };
  },
});

const spinTool = (): AnyTool => ({
  name: "spin",
  description: "does nothing, identically, forever",
  inputSchema: z.object({ same: z.string() }),
  permission: "read",
  execute: async () => ({ output: "nothing changed", display: "nothing changed" }),
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentrig-sup-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function run(provider: ModelProvider, maxTurns = 40): Session {
  const agent = createAgent({
    provider,
    tools: [spinTool(), rereadTool(), advanceTool()],
    permissions: new RulePolicy([
      { class: "read", decision: "allow" },
      { class: "write", decision: "allow" },
    ]),
    systemPrompt: "test",
    store: new SessionStore({ root }),
    budget: { maxTurns },
    maxTokensPerTurn: 100,
  });
  return agent.run("spin", { cwd: root });
}

async function drain(session: Session): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const e of session.events) out.push(e);
  return out;
}

describe("attach", () => {
  it("catches a real looping session and aborts it well short of the turn budget", async () => {
    const provider = new LoopingProvider();
    const session = run(provider, 40);
    const sup = supervise(session, { loop: { repeats: 3 }, ladder: { cooldownTurns: 1 } });
    const events = await drain(session);
    await sup.done;
    const summary = await session.done;

    expect(summary.reason).toBe("aborted");
    // the point of the milestone: a loop costs a handful of turns, not the whole budget
    expect(summary.turns).toBeLessThan(20);
    expect(events.filter((e) => e.type === "supervisor.signal").length).toBeGreaterThan(0);
    const applied = events.filter((e) => e.type === "supervisor.intervention");
    expect(applied.map((e) => (e as { intervention: Intervention }).intervention.type)).toContain("inject_guidance");
    expect(applied.map((e) => (e as { intervention: Intervention }).intervention.type)).toContain("abort");
  });

  it("steers the agent through the real message list before it resorts to aborting", async () => {
    const provider = new LoopingProvider();
    const session = run(provider, 40);
    const sup = supervise(session, { loop: { repeats: 3 }, ladder: { cooldownTurns: 1 } });
    const events = await drain(session);
    await sup.done;
    await session.done;

    const steers = events.filter((e) => e.type === "steer");
    expect(steers.length).toBeGreaterThan(0);
    expect(steers.every((e) => (e as { source: string }).source === "supervisor")).toBe(true);
    // guidance has to actually reach the model, not just the log
    expect(provider.systems.some((s) => s.includes("[supervisor: loop]"))).toBe(true);
  });

  it("writes its signals and interventions into the same JSONL log, before session.end", async () => {
    const session = run(new LoopingProvider(), 40);
    const sup = supervise(session, { loop: { repeats: 3 }, ladder: { cooldownTurns: 1 } });
    await drain(session);
    await sup.done;
    const summary = await session.done;

    const lines = (await readFile(join(root, `${summary.id}.jsonl`), "utf8")).trim().split("\n");
    const parsed = lines.map((l) => JSON.parse(l) as HarnessEvent);
    expect(parsed.some((e) => e.type === "supervisor.signal")).toBe(true);
    expect(parsed.some((e) => e.type === "supervisor.intervention")).toBe(true);
    expect(parsed.at(-1)!.type).toBe("session.end");
    // seq is one total order across the agent's events and the supervisor's
    expect(parsed.map((e) => e.seq)).toEqual(parsed.map((_, i) => i));
  });

  it("a session that behaves is never touched", async () => {
    const quiet: ModelProvider = {
      id: "fake",
      model: "fake-1",
      capabilities: { tools: true, parallelTools: true, caching: false, contextWindow: 100_000 },
      // eslint-disable-next-line require-yield
      async *stream(): AsyncIterable<ModelEvent> {
        yield { type: "text_delta", text: "done" };
        yield { type: "stop", reason: "end_turn" };
      },
    };
    const session = run(quiet, 40);
    const sup = supervise(session);
    const events = await drain(session);
    await sup.done;
    const summary = await session.done;

    expect(summary.reason).toBe("done");
    expect(events.filter((e) => e.type === "supervisor.signal")).toHaveLength(0);
    expect(events.filter((e) => e.type === "supervisor.intervention")).toHaveLength(0);
  });

  it("a detector that throws is reported and does not take the session with it", async () => {
    const exploding: Detector = {
      id: "boom",
      observe() {
        throw new Error("detector bug");
      },
    };
    const errors: string[] = [];
    const session = run(new LoopingProvider(2), 40);
    const sup = attach(session, {
      detectors: [exploding],
      policy: new LadderPolicy(),
      onError: (where, err) => errors.push(`${where}: ${err.message}`),
    });
    await drain(session);
    await sup.done;
    const summary = await session.done;

    expect(summary.reason).toBe("done");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("detector:boom");
  });

  it("a policy that throws is reported and does not take the session with it", async () => {
    const errors: string[] = [];
    const session = run(new LoopingProvider(6), 40);
    const sup = attach(session, {
      detectors: [loopDetector({ repeats: 2 })],
      policy: {
        decide() {
          throw new Error("policy bug");
        },
      },
      onError: (where, err) => errors.push(`${where}: ${err.message}`),
    });
    await drain(session);
    await sup.done;
    const summary = await session.done;

    expect(summary.reason).toBe("done");
    expect(errors.some((e) => e.startsWith("policy:"))).toBe(true);
  });

  it("a throwing onError does not become the failure it was reporting", async () => {
    const session = run(new LoopingProvider(2), 40);
    const sup = attach(session, {
      detectors: [
        {
          id: "boom",
          observe() {
            throw new Error("detector bug");
          },
        },
      ],
      policy: new LadderPolicy(),
      onError: () => {
        throw new Error("logger blew up");
      },
    });
    await drain(session);
    await expect(sup.done).resolves.toBeUndefined();
    expect((await session.done).reason).toBe("done");
  });

  it("detach stops the observer", async () => {
    const session = run(new LoopingProvider(), 40);
    const sup = supervise(session, { loop: { repeats: 3 }, ladder: { cooldownTurns: 0 } });
    sup.detach();
    const events = await drain(session);
    await sup.done;
    await session.done;
    expect(events.filter((e) => e.type === "supervisor.intervention")).toHaveLength(0);
  });

  it("escalate is only reachable when a handler exists, and the question reaches it", async () => {
    const asked: string[] = [];
    const session = run(new LoopingProvider(), 40);
    const sup = supervise(session, {
      loop: { repeats: 3 },
      ladder: { cooldownTurns: 1 },
      onEscalate: (q) => {
        asked.push(q);
      },
    });
    await drain(session);
    await sup.done;
    await session.done;
    expect(asked.length).toBeGreaterThan(0);
    expect(asked[0]).toContain("loop");
  });

  it("an intervention this milestone cannot apply is reported rather than silently dropped", async () => {
    const errors: string[] = [];
    let issued = false;
    const session = run(new LoopingProvider(4), 40);
    const sup = attach(session, {
      detectors: [
        {
          id: "always",
          observe: (e): Signal | null =>
            e.type === "tool.call" && !issued
              ? ((issued = true), { type: "loop", confidence: 1, evidence: ["x"], window: [0, 1] })
              : null,
        },
      ],
      policy: { decide: (): Intervention[] => [{ type: "checkpoint_rollback", toSeq: 0 }] },
      onError: (where, err) => errors.push(`${where}: ${err.message}`),
    });
    await drain(session);
    await sup.done;
    expect(errors.some((e) => e.includes("checkpoint_rollback") && e.includes("not applied"))).toBe(true);
  });

  it("does not re-detect on its own recorded events", async () => {
    // a detector that fired on supervisor.* would feed itself; assert it never sees one
    const seen: string[] = [];
    const session = run(new LoopingProvider(), 40);
    const sup = attach(session, {
      detectors: [
        {
          id: "spy",
          observe: (e): Signal | null => {
            seen.push(e.type);
            return e.type === "tool.call" ? { type: "loop", confidence: 1, evidence: ["x"], window: [0, 1] } : null;
          },
        },
      ],
      policy: new LadderPolicy({ cooldownTurns: 0, capabilities: { abort: true } }),
    });
    await drain(session);
    await sup.done;
    await session.done;
    expect(seen).not.toContain("supervisor.signal");
    expect(seen).not.toContain("supervisor.intervention");
  });

  it("still folds its own interventions into state, so lastInterventionSeq is real", () => {
    const s = initialState();
    reduce(s, {
      seq: 7,
      sessionId: "s",
      ts: 1,
      type: "supervisor.intervention",
      intervention: { type: "force_replan" },
    } as HarnessEvent);
    expect(s.lastInterventionSeq).toBe(7);
  });
});

describe("review regressions", () => {
  it("a productive session that repeats one tool call is never touched", async () => {
    // the reported failure: five files of real progress, aborted at turn 6, because re-reading
    // one spec file between edits produced three identical input hashes
    const provider = new ProductiveProvider(8);
    const session = run(provider, 40);
    const sup = supervise(session);
    const events = await drain(session);
    await sup.done;
    const summary = await session.done;

    expect(summary.reason).toBe("done");
    expect(events.filter((e) => e.type === "file.changed").length).toBeGreaterThanOrEqual(5);
    expect(events.filter((e) => e.type === "supervisor.intervention")).toHaveLength(0);
  });

  it("a hanging onEscalate cannot wedge the observer or save the looping session", async () => {
    // the reported failure: an escalation handler that never resolves stopped the observer
    // consuming events, so the ladder never reached abort and the loop burned all 40 turns
    const errors: string[] = [];
    const session = run(new LoopingProvider(), 40);
    const sup = supervise(session, {
      loop: { repeats: 3 },
      ladder: { cooldownTurns: 1 },
      onEscalate: () => new Promise<void>(() => {}), // never resolves
      escalateTimeoutMs: 50,
      onError: (where, err) => errors.push(`${where}: ${err.message}`),
    });
    await drain(session);
    await sup.done;
    const summary = await session.done;

    // before the timeout, this ran to `budget` at the full 40 turns: the observer stopped
    // consuming events at the first escalation and never reached the abort rung
    expect(summary.reason).toBe("aborted");
    expect(summary.turns).toBeLessThan(40);
    expect(errors.some((e) => e.includes("did not answer within"))).toBe(true);
  });

  it("a rejecting onEscalate is reported and the ladder keeps climbing", async () => {
    const errors: string[] = [];
    const session = run(new LoopingProvider(), 40);
    const sup = supervise(session, {
      loop: { repeats: 3 },
      ladder: { cooldownTurns: 1 },
      onEscalate: () => Promise.reject(new Error("no human here")),
      onError: (where, err) => errors.push(`${where}: ${err.message}`),
    });
    await drain(session);
    await sup.done;
    expect((await session.done).reason).toBe("aborted");
    expect(errors.some((e) => e.includes("no human here"))).toBe(true);
  });

  it("declaring the escalate capability with no handler is reported, not silently skipped", async () => {
    const errors: string[] = [];
    const session = run(new LoopingProvider(), 40);
    const sup = attach(session, {
      detectors: [loopDetector({ repeats: 3 })],
      // a hand-written policy that reaches a rung the harness cannot perform
      policy: { decide: (signals) => (signals.length > 0 ? [{ type: "escalate", question: "?" }] : []) },
      onError: (where, err) => errors.push(`${where}: ${err.message}`),
    });
    await drain(session);
    await sup.done;
    await session.done;
    expect(errors.some((e) => e.includes("no onEscalate handler"))).toBe(true);
  });

  it("supervise() will not enable the escalate rung without a handler, even if asked", async () => {
    const session = run(new LoopingProvider(), 40);
    const sup = supervise(session, {
      loop: { repeats: 3 },
      ladder: { cooldownTurns: 1 },
      capabilities: { escalate: true }, // no onEscalate supplied
    });
    const events = await drain(session);
    await sup.done;
    await session.done;
    const kinds = events
      .filter((e) => e.type === "supervisor.intervention")
      .map((e) => (e as { intervention: Intervention }).intervention.type);
    expect(kinds).not.toContain("escalate");
    expect(kinds).toContain("abort");
  });

  it("a detector emitting an out-of-range confidence cannot corrupt the log", async () => {
    // Detector is a public interface and signal()'s clamp is optional, so a third-party detector
    // can hand back confidence 1.4 — which JSON.stringify writes happily and SessionStore.read
    // then refuses forever, with no repair path because raw/ is immutable.
    const session = run(new LoopingProvider(2), 40);
    const sup = attach(session, {
      detectors: [
        {
          id: "rogue",
          observe: (e): Signal | null =>
            e.type === "tool.call" ? { type: "loop", confidence: 1.4, evidence: ["x"], window: [0, 1] } : null,
        },
      ],
      policy: { decide: () => [] },
    });
    await drain(session);
    await sup.done;
    const summary = await session.done;

    const store = new SessionStore({ root });
    const read: HarnessEvent[] = [];
    for await (const e of store.read(summary.id)) read.push(e);
    expect(read.at(-1)!.type).toBe("session.end");
    expect(read.some((e) => e.type === "error" && e.message.includes("record rejected"))).toBe(true);
    expect(read.some((e) => e.type === "supervisor.signal")).toBe(false);
  });

  it("a NaN confidence is rejected too, rather than serializing to null", async () => {
    const session = run(new LoopingProvider(2), 40);
    const sup = attach(session, {
      detectors: [
        {
          id: "rogue",
          observe: (e): Signal | null =>
            e.type === "tool.call" ? { type: "loop", confidence: NaN, evidence: [], window: [0, 1] } : null,
        },
      ],
      policy: { decide: () => [] },
    });
    await drain(session);
    await sup.done;
    const summary = await session.done;

    const store = new SessionStore({ root });
    const read: HarnessEvent[] = [];
    for await (const e of store.read(summary.id)) read.push(e);
    expect(read.some((e) => e.type === "error" && e.message.includes("record rejected"))).toBe(true);
  });

  it("interventions are not applied once the session has ended", async () => {
    // the state.ended guard: a policy that keeps producing aborts must not act on a dead session
    const provider = new LoopingProvider(1);
    const session = run(provider, 40);
    let applied = 0;
    const sup = attach(session, {
      detectors: [
        {
          id: "late",
          observe: (e): Signal | null =>
            e.type === "session.end" ? { type: "loop", confidence: 1, evidence: ["after the end"], window: [0, 1] } : null,
        },
      ],
      policy: {
        decide: (signals) => {
          if (signals.length === 0) return [];
          applied += 1;
          return [{ type: "abort", reason: "too late" }];
        },
      },
    });
    await drain(session);
    await sup.done;
    const summary = await session.done;

    // the detector did fire on session.end, but nothing was applied or recorded past it
    expect(applied).toBe(1);
    const store = new SessionStore({ root });
    const read: HarnessEvent[] = [];
    for await (const e of store.read(summary.id)) read.push(e);
    expect(read.at(-1)!.type).toBe("session.end");
    expect(read.some((e) => e.type === "supervisor.intervention")).toBe(false);
  });
});

describe("M6: the LLM-backed rungs and force_replan", () => {
  const reviewerReply = {
    diagnosis: "it is retrying an operation that cannot succeed",
    directions: ["read the error", "try a different tool"],
    guidance: "Stop repeating that call and read the failure first.",
  };

  function replying(body: unknown): ModelProvider {
    return {
      id: "fake",
      model: "fake-1",
      capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 },
      async *stream(): AsyncIterable<ModelEvent> {
        yield { type: "text_delta", text: JSON.stringify(body) };
        yield { type: "stop", reason: "end_turn" };
      },
    };
  }

  it("run_reviewer steers the reviewer's guidance and its candidate directions", async () => {
    const session = run(new LoopingProvider(), 40);
    const sup = supervise(session, {
      loop: { repeats: 3 },
      ladder: { cooldownTurns: 1 },
      task: "spin forever",
      reviewer: new TrajectoryReviewer({ provider: replying(reviewerReply) }),
    });
    const events = await drain(session);
    await sup.done;
    await session.done;

    const steers = events.filter((e) => e.type === "steer").map((e) => (e as { message: string }).message);
    const fromReviewer = steers.find((m) => m.includes("[supervisor: reviewer]"));
    expect(fromReviewer).toBeDefined();
    expect(fromReviewer).toContain("retrying an operation that cannot succeed");
    expect(fromReviewer).toContain("Candidate directions:");
    expect(fromReviewer).toContain("try a different tool");
    // and the decision itself is in the log
    const kinds = events
      .filter((e) => e.type === "supervisor.intervention")
      .map((e) => (e as { intervention: Intervention }).intervention.type);
    expect(kinds).toContain("run_reviewer");
  });

  it("attaching a reviewer makes the rung reachable; without one it is skipped", async () => {
    const withoutReviewer = run(new LoopingProvider(), 40);
    const s1 = supervise(withoutReviewer, { loop: { repeats: 3 }, ladder: { cooldownTurns: 1 } });
    const e1 = await drain(withoutReviewer);
    await s1.done;
    await withoutReviewer.done;
    const kinds1 = e1
      .filter((e) => e.type === "supervisor.intervention")
      .map((e) => (e as { intervention: Intervention }).intervention.type);
    expect(kinds1).not.toContain("run_reviewer");
  });

  it("a reviewer that hangs cannot wedge the observer", async () => {
    const hanging: Reviewer = { review: () => new Promise(() => {}) };
    const errors: string[] = [];
    const session = run(new LoopingProvider(), 40);
    const sup = supervise(session, {
      loop: { repeats: 3 },
      ladder: { cooldownTurns: 1 },
      reviewer: hanging,
      reviewTimeoutMs: 50,
      onError: (where, err) => errors.push(`${where}: ${err.message}`),
    });
    await drain(session);
    await sup.done;
    const summary = await session.done;
    expect(summary.reason).toBe("aborted");
    expect(errors.some((e) => e.includes("did not answer within"))).toBe(true);
  });

  it("run_grader steers the gaps when the work fails the rubric", async () => {
    const session = run(new LoopingProvider(), 40);
    const sup = attach(session, {
      detectors: [loopDetector({ repeats: 2 })],
      policy: {
        decide: (signals) =>
          signals.length > 0 ? [{ type: "run_grader", rubric: "the suite must pass" }] : [],
      },
      grader: new RubricGrader({ provider: replying({ pass: false, gaps: ["no test was added"] }) }),
      artifacts: async () => [{ path: "src/a.ts", content: "x" }],
    });
    const events = await drain(session);
    await sup.done;
    await session.done;
    const steers = events.filter((e) => e.type === "steer").map((e) => (e as { message: string }).message);
    expect(steers.some((m) => m.includes("[supervisor: grader]") && m.includes("no test was added"))).toBe(true);
  });

  it("a passing grade steers nothing", async () => {
    const session = run(new LoopingProvider(), 40);
    const sup = attach(session, {
      detectors: [loopDetector({ repeats: 2 })],
      policy: {
        decide: (signals) => (signals.length > 0 ? [{ type: "run_grader", rubric: "r" }] : []),
      },
      grader: new RubricGrader({ provider: replying({ pass: true, gaps: [] }) }),
    });
    const events = await drain(session);
    await sup.done;
    await session.done;
    expect(events.filter((e) => e.type === "steer")).toHaveLength(0);
  });

  it("a rung whose machinery is absent is reported, not silently skipped", async () => {
    const errors: string[] = [];
    const session = run(new LoopingProvider(4), 40);
    const sup = attach(session, {
      detectors: [loopDetector({ repeats: 2 })],
      policy: { decide: (s) => (s.length > 0 ? [{ type: "run_reviewer", reason: "loop" }] : []) },
      onError: (where, err) => errors.push(`${where}: ${err.message}`),
    });
    await drain(session);
    await sup.done;
    await session.done;
    expect(errors.some((e) => e.includes("no reviewer attached"))).toBe(true);
  });
});
