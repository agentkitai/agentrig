import { describe, expect, it } from "vitest";
import type { Signal } from "@agentkitai/agentrig-core";
import { DEFAULT_LADDER, LadderPolicy, initialState, signal, type SupervisorState } from "@agentkitai/agentrig-supervisor";

const sig = (type: Signal["type"], confidence = 0.9): Signal => ({
  type,
  confidence,
  evidence: ["because"],
  window: [0, 1],
});

function state(turns: number): SupervisorState {
  const s = initialState();
  s.turns = turns;
  return s;
}

describe("LadderPolicy", () => {
  it("starts at inject_guidance and carries the signal's evidence into the message", () => {
    const p = new LadderPolicy({ cooldownTurns: 0 });
    const [i] = p.decide([sig("loop")], state(0));
    expect(i!.type).toBe("inject_guidance");
    expect((i as { message: string }).message).toContain("[supervisor: loop]");
    expect((i as { message: string }).message).toContain("because");
  });

  it("escalates a rung each time the same signal type comes back", () => {
    const p = new LadderPolicy({ cooldownTurns: 0, capabilities: { abort: true } });
    const types = [0, 1, 2].map((t) => p.decide([sig("loop")], state(t))[0]!.type);
    // no reviewer, no force_replan, no escalate handler → the ladder is guidance → abort
    expect(types).toEqual(["inject_guidance", "abort", "abort"]);
  });

  it("skips rungs whose capability is missing rather than parking on them", () => {
    const p = new LadderPolicy({ cooldownTurns: 0, capabilities: { escalate: true, abort: true } });
    const types = [0, 1, 2].map((t) => p.decide([sig("stall")], state(t))[0]!.type);
    expect(types).toEqual(["inject_guidance", "escalate", "abort"]);
  });

  it("runs the whole ladder when every capability is present and no progress follows interventions", () => {
    const p = new LadderPolicy({
      cooldownTurns: 0,
      capabilities: { forceReplan: true, reviewer: true, grader: true, escalate: true, abort: true },
      rubric: "the suite must pass",
    });
    const types = [0, 1, 2, 3, 4, 5].map((t) => p.decide([sig("drift")], state(t))[0]!.type);
    expect(types).toEqual([
      "inject_guidance",
      "force_replan",
      "run_reviewer",
      "run_grader",
      "escalate",
      "abort",
    ]);
    expect(DEFAULT_LADDER).toHaveLength(6);
  });

  it("restarts at guidance when progress followed the previous intervention", () => {
    const p = new LadderPolicy({
      cooldownTurns: 0,
      capabilities: { forceReplan: true, escalate: true, abort: true },
    });
    const types = [0, 1, 2, 3].map((t) => {
      const s = state(t);
      s.filesChanged = t;
      return p.decide([sig("stall")], s)[0]!.type;
    });
    expect(types).toEqual(["inject_guidance", "inject_guidance", "inject_guidance", "inject_guidance"]);
  });

  it("still climbs to abort when four signals recur without progress", () => {
    const p = new LadderPolicy({
      cooldownTurns: 0,
      capabilities: { forceReplan: true, escalate: true, abort: true },
    });
    const types = [0, 1, 2, 3].map((t) => p.decide([sig("stall")], state(t))[0]!.type);
    expect(types).toEqual(["inject_guidance", "force_replan", "escalate", "abort"]);
  });

  it("does not mistake varied commands in a periodic loop for durable progress", () => {
    const p = new LadderPolicy({
      cooldownTurns: 0,
      capabilities: { forceReplan: true, escalate: true, abort: true },
    });
    const types = [0, 1, 2, 3].map((t) => {
      // Models the unfixed global-activity counter: A/B calls increase it between every signal,
      // but no file changes, so the recurrence must keep climbing rather than be forgiven.
      const s = state(t) as SupervisorState & { progressEvents: number };
      s.progressEvents = t;
      s.toolCalls = t * 3;
      return p.decide([sig("loop")], s)[0]!.type;
    });
    expect(types).toEqual(["inject_guidance", "force_replan", "escalate", "abort"]);
  });

  it("does not include abort unless the capability is explicitly enabled", () => {
    const p = new LadderPolicy({ cooldownTurns: 0, capabilities: { escalate: true } });
    const types = [0, 1, 2, 3].map((t) => p.decide([sig("stall")], state(t))[0]!.type);
    expect(types).toEqual(["inject_guidance", "escalate", "escalate", "escalate"]);
  });

  it("degrades an expired escalation signature to guidance for the rest of the session", () => {
    const p = new LadderPolicy({ cooldownTurns: 0, capabilities: { escalate: true } });
    const recurring = { ...sig("loop"), evidence: ["inputHash=b84894960a62a845"] };
    p.decide([recurring], state(0));
    const escalation = p.decide([recurring], state(1))[0]!;
    expect(escalation.type).toBe("escalate");
    p.onEscalationOutcome(escalation, "expired");

    expect(p.decide([recurring], state(2))[0]!.type).toBe("inject_guidance");
    expect(p.decide([recurring], state(3))[0]!.type).toBe("inject_guidance");
  });

  it("still escalates a different signature after another escalation expired", () => {
    const p = new LadderPolicy({ cooldownTurns: 0, capabilities: { escalate: true } });
    const first = { ...sig("loop"), evidence: ["called bash repeatedly", "inputHash=same-hash"] };
    // Even an input-hash collision must not merge loops from different tools/descriptions.
    const second = { ...sig("loop"), evidence: ["called read_file repeatedly", "inputHash=same-hash"] };
    p.decide([first], state(0));
    const escalation = p.decide([first], state(1))[0]!;
    p.onEscalationOutcome(escalation, "expired");

    expect(p.decide([second], state(2))[0]!.type).toBe("escalate");
  });

  it("an answered escalation suppresses nothing", () => {
    const p = new LadderPolicy({ cooldownTurns: 0, capabilities: { escalate: true } });
    const recurring = { ...sig("error_burst"), evidence: ["15 identical failing bash calls"] };
    p.decide([recurring], state(0));
    const escalation = p.decide([recurring], state(1))[0]!;
    p.onEscalationOutcome(escalation, "answered");

    expect(p.decide([recurring], state(2))[0]!.type).toBe("escalate");
  });

  it("run_grader is unreachable without a rubric, even with a grader attached", () => {
    // the rung had no place on the ladder at all in the first cut, so the CLI's grader was
    // dead code: a user could opt in, pay nothing, and get no grading
    const noRubric = new LadderPolicy({ cooldownTurns: 0, capabilities: { grader: true, abort: false } });
    const types = [0, 1, 2].map((t) => noRubric.decide([sig("loop")], state(t))[0]!.type);
    expect(types).not.toContain("run_grader");

    const withRubric = new LadderPolicy({
      cooldownTurns: 0,
      capabilities: { grader: true, abort: false },
      rubric: "r",
    });
    const got = [0, 1, 2].map((t) => withRubric.decide([sig("loop")], state(t))[0]!.type);
    expect(got).toContain("run_grader");
  });

  it("carries the rubric into the intervention it builds", () => {
    const p = new LadderPolicy({
      cooldownTurns: 0,
      capabilities: { grader: true, abort: false },
      rubric: "every public function has a test",
    });
    p.decide([sig("loop")], state(0));
    const graded = p.decide([sig("loop")], state(1))[0] as { type: string; rubric: string };
    expect(graded.type).toBe("run_grader");
    expect(graded.rubric).toBe("every public function has a test");
  });

  it("a caller can replace the rung order outright", () => {
    const p = new LadderPolicy({ cooldownTurns: 0, ladder: ["abort"], capabilities: { abort: true } });
    expect(p.decide([sig("loop")], state(0))[0]!.type).toBe("abort");
  });

  it("never aborts when the abort capability is withheld", () => {
    const p = new LadderPolicy({ cooldownTurns: 0, capabilities: { abort: false } });
    const types = [0, 1, 2, 3, 4].map((t) => p.decide([sig("loop")], state(t))[0]!.type);
    expect(types.every((t) => t === "inject_guidance")).toBe(true);
  });

  it("holds a signal type off during its cooldown", () => {
    const p = new LadderPolicy({ cooldownTurns: 2 });
    expect(p.decide([sig("loop")], state(0))).toHaveLength(1);
    expect(p.decide([sig("loop")], state(1))).toHaveLength(0); // 1 turn later: still cooling
    expect(p.decide([sig("loop")], state(2))).toHaveLength(1);
  });

  it("a signal suppressed by cooldown does not burn a rung", () => {
    const p = new LadderPolicy({ cooldownTurns: 2, capabilities: { abort: true } });
    expect(p.decide([sig("loop")], state(0))[0]!.type).toBe("inject_guidance");
    p.decide([sig("loop")], state(1)); // suppressed
    p.decide([sig("loop")], state(1)); // suppressed
    // if suppressed signals advanced the level, this would already be past abort
    expect(p.decide([sig("loop")], state(2))[0]!.type).toBe("abort");
  });

  it("cooldowns are per signal type, so one type cannot mute another", () => {
    const p = new LadderPolicy({ cooldownTurns: 5 });
    const out = p.decide([sig("loop"), sig("stall")], state(0));
    expect(out).toHaveLength(2);
  });

  it("ignores signals below the confidence floor", () => {
    const p = new LadderPolicy({ cooldownTurns: 0, minConfidence: 0.6 });
    expect(p.decide([sig("drift", 0.4)], state(0))).toHaveLength(0);
    expect(p.decide([sig("drift", 0.7)], state(0))).toHaveLength(1);
  });

  it("stops issuing past maxInterventions", () => {
    const p = new LadderPolicy({ cooldownTurns: 0, maxInterventions: 3, capabilities: { abort: false } });
    const issued = [0, 1, 2, 3, 4, 5].flatMap((t) => p.decide([sig("loop")], state(t)));
    expect(issued).toHaveLength(3);
  });

  it("takes custom guidance text for a signal type", () => {
    const p = new LadderPolicy({ cooldownTurns: 0, guidance: { loop: "STOP THAT" } });
    expect((p.decide([sig("loop")], state(0))[0] as { message: string }).message).toContain("STOP THAT");
  });

  it("every signal type has guidance — a new SignalType must not produce an empty steer", () => {
    const p = new LadderPolicy({ cooldownTurns: 0 });
    const types: Array<Signal["type"]> = ["loop", "stall", "error_burst", "drift", "budget", "test_regression"];
    for (const t of types) {
      const i = p.decide([sig(t)], state(0))[0] as { type: string; message: string };
      expect(i.type).toBe("inject_guidance");
      expect(i.message.length).toBeGreaterThan(60);
      expect(i.message).not.toContain("undefined");
    }
  });
});

describe("signal()", () => {
  it("clamps confidence into the range the schema accepts", () => {
    // the schema rejects anything outside [0,1], and a rejected record is a dropped signal —
    // so a detector doing its own arithmetic must not be able to produce one
    expect(signal("loop", 1.4, [], [0, 1]).confidence).toBe(1);
    expect(signal("loop", -3, [], [0, 1]).confidence).toBe(0);
    expect(signal("loop", 0.42, [], [0, 1]).confidence).toBe(0.42);
  });

  it("orders the window, so a detector cannot emit a backwards span", () => {
    expect(signal("stall", 0.5, [], [9, 4]).window).toEqual([4, 9]);
    expect(signal("stall", 0.5, [], [4, 9]).window).toEqual([4, 9]);
  });

  it("produces a signal the event schema accepts", async () => {
    const { Signal } = await import("@agentkitai/agentrig-core");
    expect(Signal.safeParse(signal("drift", 2, ["e"], [5, 1])).success).toBe(true);
  });
});
