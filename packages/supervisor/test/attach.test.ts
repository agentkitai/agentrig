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
  supervise,
  type Detector,
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
    tools: [spinTool()],
    permissions: new RulePolicy([{ class: "read", decision: "allow" }]),
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
