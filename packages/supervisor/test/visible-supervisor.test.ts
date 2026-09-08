import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RulePolicy,
  SessionStore,
  contentHash,
  createAgent,
  type AnyTool,
  type EventOf,
  type HarnessEvent,
  type Intervention,
  type ModelEvent,
  type ModelProvider,
  type Session,
  type Signal,
} from "@agentkitai/agentrig-core";
import { attach, guidanceDigest, signal, supervise, type Detector, type Policy } from "@agentkitai/agentrig-supervisor";

/**
 * R17e. An intervention has to say what it noticed, what it did, and what that cost — and
 * "recorded" must never read as "applied". These run a real session on a fake provider: no
 * network, no model spend, and the assertions are on the records the observer actually wrote.
 */

class LoopingProvider implements ModelProvider {
  readonly id = "fake";
  readonly model = "fake-1";
  readonly capabilities = { tools: true, parallelTools: true, caching: false, contextWindow: 100_000 };
  readonly requests: string[] = [];
  turns = 0;
  constructor(private readonly limit = 12) {}
  async *stream(req: { messages: unknown }): AsyncIterable<ModelEvent> {
    this.requests.push(JSON.stringify(req.messages));
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
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "agentrig-r17e-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function run(provider: ModelProvider, maxTurns = 20): Session {
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

/** Fires once, on the first turn, so a hand-written policy can be asked for exactly one rung. */
function onceDetector(): Detector {
  let fired = false;
  return {
    id: "once",
    observe(event) {
      if (fired || event.type !== "turn.start") return null;
      fired = true;
      return signal("stall", 0.9, ["nothing changed in three turns"], [0, event.seq]);
    },
  };
}

const fixedPolicy = (intervention: Intervention): Policy => {
  let issued = false;
  return { decide: () => (issued ? [] : ((issued = true), [intervention])) };
};

const outcomes = (events: HarnessEvent[]): Array<EventOf<"supervisor.outcome">> =>
  events.filter((e): e is EventOf<"supervisor.outcome"> => e.type === "supervisor.outcome");

describe("visible supervisor", () => {
  it("never re-detects on the supervisor's own outcome bookkeeping", async () => {
    const seen: string[] = [];
    const session = run(new LoopingProvider(2));
    const observer = attach(session, {
      detectors: [{ id: "spy", observe(event) { seen.push(event.type); return null; } }, onceDetector()],
      policy: fixedPolicy({ type: "inject_guidance", message: "change approach" }),
    });
    try {
      const events = await drain(session);
      await session.done;
      await observer.done;
      expect(outcomes(events)).toHaveLength(1);
      expect(seen).toContain("model.request");
      expect(seen).not.toContain("supervisor.outcome");
      expect(seen).not.toContain("supervisor.intervention");
    } finally {
      session.control.abort();
      observer.detach();
      await session.done;
      await observer.done;
    }
  });

  it("records what it noticed, that guidance was only queued, and what the queueing cost", async () => {
    const provider = new LoopingProvider();
    const session = run(provider);
    const observer = supervise(session, { loop: { repeats: 3 }, ladder: { cooldownTurns: 1, ladder: ["inject_guidance"] } });
    const events = await drain(session);
    await observer.done;
    await session.done;

    const decision = events.find((e) => e.type === "supervisor.intervention")!;
    expect(decision.intervention.type).toBe("inject_guidance");
    expect(decision.id).toBeDefined();
    // exactly the signal the ladder acted on, not every signal in the batch
    expect(decision.noticed).toHaveLength(1);
    expect((decision.noticed as Signal[])[0]!.type).toBe("loop");

    const outcome = outcomes(events).find((e) => e.id === decision.id)!;
    expect(outcome.intervention).toBe("inject_guidance");
    // queued, NOT applied: the steer event below is the only proof it was delivered
    expect(outcome.outcome).toBe("queued");
    expect(outcome.cost.modelCalls).toBe("none");
    expect(outcome.cost.auxiliaryId).toBeUndefined();

    const steer = events.find((e) => e.type === "steer" && e.source === "supervisor")!;
    expect(steer.type === "steer" && steer.message).toBe(
      decision.intervention.type === "inject_guidance" ? decision.intervention.message : "",
    );
    // the digest the supervisor records is the one core's `/why` fold computes over the steer
    expect(outcome.cost.injected?.hash).toBe(contentHash(steer.type === "steer" ? steer.message : ""));
    expect(guidanceDigest(steer.type === "steer" ? steer.message : "")).toBe(outcome.cost.injected?.hash);
    expect(outcome.cost.injected?.bytes).toBe(Buffer.byteLength(steer.type === "steer" ? steer.message : "", "utf8"));
    // the bytes the outcome counted are bytes the provider actually received: the exact text, not
    // a paraphrase of it, appears in an outgoing request
    const exact = JSON.stringify(steer.type === "steer" ? steer.message : "").slice(1, -1);
    expect(provider.requests.some((request) => request.includes(exact))).toBe(true);
  });

  it("points an LLM-backed rung at its own usage record instead of restating what it cost", async () => {
    const session = run(new LoopingProvider());
    const observer = attach(session, {
      detectors: [onceDetector()],
      policy: fixedPolicy({ type: "run_reviewer", reason: "stalled" }),
      reviewer: {
        review: async () => ({ diagnosis: "stuck", directions: ["try b"], guidance: "read the error" }),
      },
    });
    const events = await drain(session);
    await observer.done;
    await session.done;

    const outcome = outcomes(events)[0]!;
    expect(outcome.intervention).toBe("run_reviewer");
    expect(outcome.outcome).toBe("queued");
    expect(outcome.cost.modelCalls).toBe("auxiliary");
    expect(outcome.cost.auxiliaryId).toBeDefined();
    // the id names an actual usage record; consumption stays there, where "unknown" can stay unknown
    const usage = events.filter((e) => e.type === "auxiliary.usage" && e.id === outcome.cost.auxiliaryId);
    expect(usage.length).toBeGreaterThan(0);
    expect(JSON.stringify(outcome.cost)).not.toContain("reportedUsage");
    const steered = events.find((e) => e.type === "steer" && e.source === "supervisor");
    expect(steered).toBeDefined();
    expect(outcome.cost.injected?.hash).toBe(contentHash(steered?.type === "steer" ? steered.message : ""));
  });

  it("reports a rung that produced nothing as no-action rather than as guidance", async () => {
    const session = run(new LoopingProvider());
    const observer = attach(session, {
      detectors: [onceDetector()],
      policy: fixedPolicy({ type: "run_reviewer", reason: "stalled" }),
      reviewer: { review: async () => ({ diagnosis: "fine", directions: [], guidance: "   " }) },
    });
    const events = await drain(session);
    await observer.done;
    await session.done;

    const outcome = outcomes(events)[0]!;
    expect(outcome.outcome).toBe("no-action");
    expect(outcome.cost.injected).toBeUndefined();
    expect(events.some((e) => e.type === "steer")).toBe(false);
  });

  it("reports rungs this harness cannot perform as unavailable, not as something that happened", async () => {
    for (const [intervention, detail] of [
      [{ type: "escalate", question: "now what?" } as Intervention, "onEscalate"],
      [{ type: "run_grader", rubric: "r" } as Intervention, "grader"],
      [{ type: "checkpoint_rollback", toSeq: 1 } as Intervention, "cannot perform"],
    ] as const) {
      const session = run(new LoopingProvider());
      const observer = attach(session, { detectors: [onceDetector()], policy: fixedPolicy(intervention) });
      const events = await drain(session);
      await observer.done;
      await session.done;

      const outcome = outcomes(events)[0]!;
      expect(outcome.intervention).toBe(intervention.type);
      expect(outcome.outcome).toBe("unavailable");
      expect(outcome.detail).toContain(detail);
      expect(outcome.cost.modelCalls).toBe("none");
      expect(outcome.cost.injected).toBeUndefined();
    }
  });

  it("records a gate as applied and says the reason is not prompt text", async () => {
    const session = run(new LoopingProvider());
    // no update_plan tool here, so `requirePlan` is still callable but the harness reports honestly
    const observer = attach(session, {
      detectors: [onceDetector()],
      policy: fixedPolicy({ type: "force_replan" }),
    });
    const events = await drain(session);
    await observer.done;
    await session.done;

    const outcome = outcomes(events)[0]!;
    expect(outcome.outcome).toBe("applied");
    expect(outcome.detail).toContain("tools gated until a fresh plan lands");
    expect(outcome.cost.injected).toBeUndefined();
  });

  it("falls back to the whole batch when a custom policy cannot attribute its cause", async () => {
    const session = run(new LoopingProvider());
    const observer = attach(session, {
      detectors: [onceDetector()],
      policy: fixedPolicy({ type: "inject_guidance", message: "hello" }),
    });
    const events = await drain(session);
    await observer.done;
    await session.done;

    const decision = events.find((e) => e.type === "supervisor.intervention")!;
    expect(decision.noticed?.map((s) => s.type)).toEqual(["stall"]);
  });
});
