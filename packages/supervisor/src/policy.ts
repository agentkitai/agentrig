import type { Intervention, Signal } from "@agentkitai/agentrig-core";
import type { Policy, SignalType } from "./types.js";
import type { SupervisorState } from "./state.js";

/** The rungs a signal type climbs. `run_reviewer` is M6's; it is listed so the ladder is whole. */
export type Rung = "inject_guidance" | "force_replan" | "run_reviewer" | "run_grader" | "escalate" | "abort";

export const DEFAULT_LADDER: Rung[] = ["inject_guidance", "force_replan", "run_reviewer", "run_grader", "escalate", "abort"];

/**
 * What the harness can actually *do* right now. A rung whose capability is missing is skipped,
 * not stalled on — so the same ladder definition behaves correctly in M4 (guidance → abort,
 * because nothing else is wired) and in M6 (the full five rungs) with no edit. Crucially, a
 * headless run has no human, so `escalate` is skipped there and the ladder does not park itself
 * on a question nobody will ever answer.
 */
export interface Capabilities {
  forceReplan?: boolean;
  reviewer?: boolean;
  grader?: boolean;
  escalate?: boolean;
  abort?: boolean;
}

export interface LadderOptions {
  capabilities?: Capabilities;
  /** Minimum turns between two interventions for the same signal type. */
  cooldownTurns?: number;
  /** Below this confidence a signal is recorded but never acted on. */
  minConfidence?: number;
  /** Hard cap on interventions per session, so a pathological stream cannot bury the agent. */
  maxInterventions?: number;
  /** Overrides the guidance text for a signal type. */
  guidance?: Partial<Record<SignalType, string>>;
  /**
   * The rubric `run_grader` checks against. Without one the rung has nothing to grade, so it is
   * skipped even when a grader is attached.
   */
  rubric?: string;
  /** Replaces the rung order outright. */
  ladder?: Rung[];
}

const GUIDANCE: Record<SignalType, string> = {
  loop: "You are repeating yourself: the same call or the same failure has come back several times. Stop and change approach — re-read the thing you are assuming, or attack the problem from a different direction. Do not retry that call again unchanged.",
  stall: "The last several turns changed nothing. Say plainly what you are stuck on, then either take a concrete step that changes a file or run something that gives you new information. If you are blocked, say so rather than continuing to circle.",
  error_burst: "Most of your recent tool calls are failing. Stop and read one error carefully before making another call — the failures are probably one cause, not many.",
  budget: "You are near the budget for this session. Prioritise: finish and verify what is nearly done, and skip what is optional. Leave the work in a coherent state rather than half-way through a refactor.",
  test_regression: "The pass count went down — something that used to work is broken now. Fix that before doing anything else; a regression is more urgent than the feature you were adding.",
  drift: "You are changing files outside what your plan declared. Either update the plan to say why these files are in scope, or leave them alone and stay on the declared path.",
};

/**
 * PLAN §4.2's default ladder, escalating per signal *type* on repeat, with cooldowns.
 *
 * Two things keep it from nagging: a per-type cooldown measured in turns (an intervention only
 * helps once the agent has had a turn to act on it), and a session-wide cap. The rung advances
 * only when a type actually produces an intervention, so a signal suppressed by cooldown does
 * not silently burn a rung and land the session on `abort`.
 */
export class LadderPolicy implements Policy {
  private readonly rungs: Rung[];
  private readonly cooldownTurns: number;
  private readonly minConfidence: number;
  private readonly maxInterventions: number;
  private readonly guidance: Record<SignalType, string>;
  private readonly level = new Map<SignalType, number>();
  private readonly lastTurn = new Map<SignalType, number>();
  private readonly filesChangedAtIntervention = new Map<SignalType, number>();
  private issued = 0;

  private readonly rubric: string | undefined;

  constructor(opts: LadderOptions = {}) {
    const caps = opts.capabilities ?? {};
    this.rubric = opts.rubric;
    this.rungs = (opts.ladder ?? DEFAULT_LADDER).filter((r) => {
      if (r === "force_replan") return caps.forceReplan === true;
      if (r === "run_reviewer") return caps.reviewer === true;
      if (r === "run_grader") return caps.grader === true && opts.rubric !== undefined;
      if (r === "escalate") return caps.escalate === true;
      if (r === "abort") return caps.abort === true;
      return true;
    });
    this.cooldownTurns = opts.cooldownTurns ?? 2;
    this.minConfidence = opts.minConfidence ?? 0.5;
    this.maxInterventions = opts.maxInterventions ?? 12;
    this.guidance = { ...GUIDANCE, ...(opts.guidance ?? {}) };
  }

  decide(signals: Signal[], state: SupervisorState): Intervention[] {
    const out: Intervention[] = [];
    for (const s of signals) {
      if (s.confidence < this.minConfidence) continue;
      if (this.issued >= this.maxInterventions) break;

      const last = this.lastTurn.get(s.type);
      if (last !== undefined && state.turns - last < this.cooldownTurns) continue;

      const priorFilesChanged = this.filesChangedAtIntervention.get(s.type);
      if (priorFilesChanged !== undefined && state.filesChanged > priorFilesChanged) {
        // A file change is durable progress: the previous intervention worked. Mere command
        // variation is not enough here, because a periodic A/B loop must still climb the ladder.
        this.level.set(s.type, 0);
      }

      const rung = this.rungs[Math.min(this.level.get(s.type) ?? 0, this.rungs.length - 1)];
      if (rung === undefined) continue;

      const intervention = this.build(rung, s);
      if (intervention === null) continue;

      out.push(intervention);
      this.issued += 1;
      this.lastTurn.set(s.type, state.turns);
      this.filesChangedAtIntervention.set(s.type, state.filesChanged);
      this.level.set(s.type, (this.level.get(s.type) ?? 0) + 1);
    }
    return out;
  }

  private build(rung: Rung, s: Signal): Intervention | null {
    const why = s.evidence.join("; ");
    switch (rung) {
      case "inject_guidance":
        return { type: "inject_guidance", message: `[supervisor: ${s.type}] ${this.guidance[s.type]}\n\nWhat I observed: ${why}` };
      case "force_replan":
        return { type: "force_replan" };
      case "run_reviewer":
        return { type: "run_reviewer", reason: `${s.type}: ${why}` };
      case "run_grader":
        // filtered out when no rubric exists, so this is only reached with one
        return this.rubric === undefined ? null : { type: "run_grader", rubric: this.rubric };
      case "escalate":
        return { type: "escalate", question: `The supervisor detected ${s.type}: ${why}. How should the agent proceed?` };
      case "abort":
        return { type: "abort", reason: `${s.type} persisted through every lesser intervention: ${why}` };
      default:
        return null;
    }
  }
}
