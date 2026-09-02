import type { Session } from "@agentkitai/agentrig-core";
import type { Detachable, Detector, EscalationOutcome, Policy } from "./types.js";
import { initialState, reduce, type StateOptions, type SupervisorState } from "./state.js";
import { LadderPolicy, type Capabilities, type LadderOptions } from "./policy.js";
import { defaultDetectors, type DefaultDetectorOptions } from "./detectors/index.js";
import type { Attempt, Reviewer } from "./reviewer.js";
import type { Grader } from "./grader.js";

export const DEFAULT_ESCALATE_TIMEOUT_MS = 60_000;
/** An LLM-backed rung is bounded like any other blocking call in the observer's loop. */
export const DEFAULT_REVIEW_TIMEOUT_MS = 90_000;

class ObserverTimeoutError extends Error {}

/**
 * Races `work` against a timer. The timer is unref'd so a pending escalation cannot by itself
 * hold the process open, and cleared on the winning path so it does not leak per intervention.
 */
async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ObserverTimeoutError(`${label} did not answer within ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface AttachOptions extends StateOptions {
  detectors: Detector[];
  policy: Policy;
  /**
   * Where an `escalate` intervention goes. Its presence is what makes the `escalate` rung
   * available at all — without a human on the other end the ladder skips straight to abort.
   */
  onEscalate?: (question: string) => EscalationOutcome | void | Promise<EscalationOutcome | void>;
  /**
   * How long to wait on `onEscalate` before giving up on it. The handler runs inside the event
   * loop, so an unbounded wait does not merely delay one intervention — the observer stops
   * consuming events, never reaches the `abort` rung, and the looping agent it was supposed to
   * stop burns its whole budget. The natural handler (prompt a human) blocks until someone
   * types, so this bound is the difference between a supervisor and a deadlock.
   */
  escalateTimeoutMs?: number;
  /**
   * PLAN §4.3/§4.4. Supplying a reviewer makes the `run_reviewer` rung reachable; its guidance
   * is steered into the session the same way `inject_guidance` is, so the rung is "a *better*
   * message", not a different mechanism.
   */
  reviewer?: Reviewer;
  /** Supplying a grader makes `run_grader` reachable. A failing grade becomes guidance. */
  grader?: Grader;
  /** The task under review, needed for reviewer prompts. */
  task?: string;
  /** The wiki digest the agent is working from, passed through to the reviewer. */
  memoryIndex?: string;
  /** Read lazily when the reviewer runs — the ledger is on disk and usually not needed. */
  attempts?: () => Promise<Attempt[]> | Attempt[];
  /** Files the grader should judge. Called only when a grade is actually requested. */
  artifacts?: () => Promise<Array<{ path: string; content?: string }>>;
  /** Bounds an LLM-backed rung the same way `escalate` is bounded. */
  reviewTimeoutMs?: number;
  /** Reported rather than thrown: a detector that throws must not take the session with it. */
  onError?: (where: string, err: Error) => void;
}

/**
 * PLAN §4.4. Consumes `session.events`, emits `supervisor.signal` / `supervisor.intervention`
 * back into the same log, and applies interventions through `session.control`.
 *
 * Two properties matter more than anything else here:
 *
 *  - **It cannot break the session.** Every detector and policy call is wrapped; a throw is
 *    reported and the observer keeps going. The supervisor is an observer, and an observer that
 *    can kill what it observes is worse than no observer.
 *  - **It never applies backpressure to the loop.** It reads a replayed buffer of the event
 *    stream (core's `EventStream` hands every consumer its own cursor), so an observer that is
 *    slow *asynchronously* delays interventions and nothing else. Note the limit of that
 *    guarantee: the observer shares one JS thread with the agent, so a detector that burns CPU
 *    does stall the run. Detectors are expected to be cheap — that is what "heuristic, LLM-free"
 *    buys. Guidance is queued through `steer()` and lands at the next turn boundary, which is
 *    the only point where injecting a message is coherent.
 *
 * As of M6 every rung is applied except `checkpoint_rollback`, which needs git checkpoints that
 * nothing creates yet. The default policy will not produce a rung unless its capability is
 * derived as available, and a hand-written policy that emits an unserviceable one gets an
 * `onError` report rather than silence.
 */
export function attach(session: Session, opts: AttachOptions): Detachable {
  const state = initialState();
  const stateOpts: StateOptions = {};
  if (opts.windowSize !== undefined) stateOpts.windowSize = opts.windowSize;
  if (opts.pricing !== undefined) stateOpts.pricing = opts.pricing;
  if (opts.cacheReadDiscount !== undefined) stateOpts.cacheReadDiscount = opts.cacheReadDiscount;
  if (opts.cacheWriteMultiplier !== undefined) stateOpts.cacheWriteMultiplier = opts.cacheWriteMultiplier;

  let detached = false;
  const report = (where: string, err: unknown): void => {
    try {
      opts.onError?.(where, err instanceof Error ? err : new Error(String(err)));
    } catch {
      // a throwing reporter must not become the failure it was reporting
    }
  };

  const done = (async () => {
    for await (const event of session.events) {
      if (detached) return;
      try {
        reduce(state, event, stateOpts);
      } catch (err) {
        report("state", err);
        continue;
      }
      // the supervisor's own records come back through the stream; folding them is right
      // (lastInterventionSeq) but re-detecting on them is not
      if (event.type === "supervisor.signal" || event.type === "supervisor.intervention") continue;

      const signals = [];
      for (const d of opts.detectors) {
        try {
          const s = d.observe(event, state);
          if (s !== null) signals.push(s);
        } catch (err) {
          report(`detector:${d.id}`, err);
        }
      }
      if (signals.length === 0) continue;
      for (const s of signals) session.control.record({ type: "supervisor.signal", signal: s });

      let interventions;
      try {
        interventions = opts.policy.decide(signals, state);
      } catch (err) {
        report("policy", err);
        continue;
      }

      for (const intervention of interventions) {
        if (detached || state.ended) break;

        session.control.record({ type: "supervisor.intervention", intervention });
        const active = intervention;
        try {
          switch (active.type) {
            case "inject_guidance":
              session.control.steer(active.message, "supervisor");
              break;
            case "escalate": {
              if (opts.onEscalate === undefined) {
                // the policy reached a rung the harness cannot perform: say so rather than
                // recording an intervention that quietly does nothing
                opts.policy.onEscalationOutcome?.(active, "closed");
                report("apply", new Error("escalate was reached with no onEscalate handler; nobody was asked"));
                break;
              }
              try {
                const outcome = await withTimeout(
                  Promise.resolve(opts.onEscalate(active.question)),
                  opts.escalateTimeoutMs ?? DEFAULT_ESCALATE_TIMEOUT_MS,
                  "onEscalate",
                );
                // Legacy non-interactive handlers only report that delivery returned; they do not
                // prove a human answered. Treat void as closed (which, like answered, suppresses
                // nothing) and reserve answered for an explicit outcome from an interactive seam.
                opts.policy.onEscalationOutcome?.(active, outcome ?? "closed");
              } catch (err) {
                opts.policy.onEscalationOutcome?.(
                  active,
                  err instanceof ObserverTimeoutError ? "expired" : "closed",
                );
                throw err;
              }
              break;
            }
            case "abort":
              session.control.abort();
              break;
            case "force_replan":
              // real as of M6: the loop refuses every tool except `update_plan` until a fresh
              // plan lands. This is why the rung sits above inject_guidance — guidance can be
              // ignored, a gate cannot.
              session.control.requirePlan(
                signals.length === 1 && signals[0] !== undefined
                  ? `${signals[0].type}: ${signals[0].evidence[0] ?? ""}`
                  : `the supervisor asked for a fresh plan (${signals.map((s) => s.type).join(", ")})`,
              );
              break;
            case "run_reviewer": {
              if (opts.reviewer === undefined) {
                report("apply", new Error("run_reviewer was reached with no reviewer attached; nothing was reviewed"));
                break;
              }
              const review = await withTimeout(
                // the loader is INSIDE the timeout: a hanging attempts read would wedge the
                // observer exactly as a hanging reviewer would
                (async () =>
                  opts.reviewer!.review({
                    task: opts.task ?? "(task not supplied to the supervisor)",
                    trajectory: state.recent,
                    attempts: opts.attempts === undefined ? [] : await opts.attempts(),
                    ...(opts.memoryIndex === undefined ? {} : { memoryIndex: opts.memoryIndex }),
                  }))(),
                opts.reviewTimeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
                "reviewer",
              );
              if (review.guidance.trim() === "") break;
              // the reviewer's product is guidance, so it lands through the same `steer` channel
              // as inject_guidance — a better message, not a different mechanism
              const options =
                review.directions.length === 0
                  ? ""
                  : `\n\nCandidate directions:\n${review.directions.map((d) => `- ${d}`).join("\n")}`;
              session.control.steer(
                `[supervisor: reviewer] ${review.diagnosis}\n\n${review.guidance}${options}`,
                "supervisor",
              );
              break;
            }
            case "run_grader": {
              if (opts.grader === undefined) {
                report("apply", new Error("run_grader was reached with no grader attached; nothing was graded"));
                break;
              }
              const grade = await withTimeout(
                (async () =>
                  opts.grader!.grade({
                    rubric: active.rubric,
                    artifacts: opts.artifacts === undefined ? [] : await opts.artifacts(),
                    trajectory: state.recent,
                  }))(),
                opts.reviewTimeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
                "grader",
              );
              if (!grade.pass && grade.gaps.length > 0) {
                session.control.steer(
                  `[supervisor: grader] The work does not yet meet the rubric:\n` +
                    grade.gaps.map((g) => `- ${g}`).join("\n"),
                  "supervisor",
                );
              }
              break;
            }
            default:
              report(
                "apply",
                new Error(`intervention "${active.type}" is recorded but not applied until a later milestone`),
              );
          }
        } catch (err) {
          report(`apply:${active.type}`, err);
        }
      }
    }
  })().catch((err: unknown) => {
    report("observer", err);
  });

  return {
    detach: () => {
      detached = true;
    },
    done,
  };
}

export interface SuperviseOptions extends DefaultDetectorOptions {
  ladder?: Omit<LadderOptions, "capabilities">;
  /** Rubric for the `run_grader` rung; without it the rung stays unreachable. */
  rubric?: string;
  capabilities?: Capabilities;
  onEscalate?: (question: string) => EscalationOutcome | void | Promise<EscalationOutcome | void>;
  escalateTimeoutMs?: number;
  reviewer?: Reviewer;
  grader?: Grader;
  task?: string;
  memoryIndex?: string;
  attempts?: () => Promise<Attempt[]> | Attempt[];
  artifacts?: () => Promise<Array<{ path: string; content?: string }>>;
  reviewTimeoutMs?: number;
  onError?: (where: string, err: Error) => void;
  pricing?: StateOptions["pricing"];
  cacheReadDiscount?: number;
  cacheWriteMultiplier?: number;
  windowSize?: number;
}

/**
 * The batteries-included attachment: the six v1 detectors and the default ladder, with the
 * `escalate` rung enabled exactly when an `onEscalate` handler was supplied.
 */
export function supervise(session: Session, opts: SuperviseOptions = {}): Detachable {
  // the handler's presence is ground truth for the escalate rung, so it is applied *after* any
  // caller-declared capabilities rather than before — declaring `escalate: true` with no handler
  // would otherwise buy a rung that silently does nothing
  // Capabilities are derived from what was actually supplied, applied AFTER any caller-declared
  // ones: declaring a rung whose machinery is absent buys an intervention that silently does
  // nothing, which is the failure mode the M4 review caught for `escalate`.
  const capabilities: Capabilities = {
    ...(opts.capabilities ?? {}),
    escalate: opts.onEscalate !== undefined,
    reviewer: opts.reviewer !== undefined,
    grader: opts.grader !== undefined,
    // `force_replan` DOES need a collaborator: the session must have a tool that can satisfy the
    // gate. Asserting otherwise meant raising a gate on a session that could never clear it, so
    // the ladder walked to abort — or, with abort disabled, the run burned its whole budget being
    // refused. A rung that can wedge the loop is worse than the loop it was catching.
    forceReplan: session.control.canRequirePlan(),
  };
  if (opts.capabilities?.forceReplan === true && !session.control.canRequirePlan()) {
    opts.onError?.(
      "capabilities",
      new Error("force_replan was requested but this session has no update_plan tool; the rung is disabled"),
    );
  }
  const attachOpts: AttachOptions = {
    detectors: defaultDetectors(opts),
    policy: new LadderPolicy({
      ...(opts.ladder ?? {}),
      capabilities,
      ...(opts.rubric === undefined ? {} : { rubric: opts.rubric }),
    }),
  };
  if (opts.onEscalate !== undefined) attachOpts.onEscalate = opts.onEscalate;
  if (opts.reviewer !== undefined) attachOpts.reviewer = opts.reviewer;
  if (opts.grader !== undefined) attachOpts.grader = opts.grader;
  if (opts.task !== undefined) attachOpts.task = opts.task;
  if (opts.memoryIndex !== undefined) attachOpts.memoryIndex = opts.memoryIndex;
  if (opts.attempts !== undefined) attachOpts.attempts = opts.attempts;
  if (opts.artifacts !== undefined) attachOpts.artifacts = opts.artifacts;
  if (opts.reviewTimeoutMs !== undefined) attachOpts.reviewTimeoutMs = opts.reviewTimeoutMs;
  if (opts.escalateTimeoutMs !== undefined) attachOpts.escalateTimeoutMs = opts.escalateTimeoutMs;
  if (opts.onError !== undefined) attachOpts.onError = opts.onError;
  if (opts.pricing !== undefined) attachOpts.pricing = opts.pricing;
  if (opts.cacheReadDiscount !== undefined) attachOpts.cacheReadDiscount = opts.cacheReadDiscount;
  if (opts.cacheWriteMultiplier !== undefined) attachOpts.cacheWriteMultiplier = opts.cacheWriteMultiplier;
  if (opts.windowSize !== undefined) attachOpts.windowSize = opts.windowSize;
  return attach(session, attachOpts);
}

export type { SupervisorState };
