import type { AuxiliaryReport, Session } from "@agentkitai/agentrig-core";
import { randomUUID } from "node:crypto";
import { AuxiliaryLimitError, auxiliaryDiagnostic, positiveLimit, DEFAULT_AUXILIARY_LIMITS, type AuxiliaryOptions, type AuxiliaryLimits } from "./auxiliary.js";
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

async function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  try {
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    return await Promise.race([work, stopped]);
  } finally { signal.removeEventListener("abort", abort); }
}

/**
 * Races `work` against a timer. The timer is unref'd so a pending escalation cannot by itself
 * hold the process open, and cleared on the winning path so it does not leak per intervention.
 */
async function withTimeout<T>(work: Promise<T>, ms: number, label: string, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending = Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ObserverTimeoutError(`${label} did not answer within ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
    return await (signal === undefined ? pending : untilAborted(pending, signal));
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
  attempts?: (sessionId: string, signal: AbortSignal) => Promise<Attempt[]> | Attempt[];
  /** Files the grader should judge. Called only when a grade is actually requested. */
  artifacts?: (sessionId: string, signal: AbortSignal) => Promise<Array<{ path: string; content?: string }>>;
  /** Bounds an LLM-backed rung the same way `escalate` is bounded. */
  reviewTimeoutMs?: number;
  auxiliaryLimits?: Partial<AuxiliaryLimits>;
  onUsage?: (report: AuxiliaryReport) => void;
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
  positiveLimit("reviewTimeoutMs", opts.reviewTimeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS);
  for (const [key, value] of Object.entries(opts.auxiliaryLimits ?? {})) positiveLimit(key, value);
  const state = initialState();
  const stateOpts: StateOptions = {};
  if (opts.windowSize !== undefined) stateOpts.windowSize = opts.windowSize;
  if (opts.pricing !== undefined) stateOpts.pricing = opts.pricing;
  if (opts.cacheReadDiscount !== undefined) stateOpts.cacheReadDiscount = opts.cacheReadDiscount;
  if (opts.cacheWriteMultiplier !== undefined) stateOpts.cacheWriteMultiplier = opts.cacheWriteMultiplier;

  let detached = false;
  const lifetime = new AbortController();
  const stop = () => lifetime.abort(new DOMException("supervisor detached or session ended", "AbortError"));
  session.control.auxiliarySignal?.addEventListener("abort", stop, { once: true });
  if (session.control.auxiliarySignal?.aborted) stop();
  void session.done.then(stop, stop);
  const report = (where: string, err: unknown): void => {
    auxiliaryDiagnostic(() => {
      opts.onError?.(where, err instanceof Error ? err : new Error(String(err)));
    });
  };

  const runAuxiliary = async <T>(operation: "reviewer" | "grader", work: (call: AuxiliaryOptions, start: () => void) => Promise<T>): Promise<T> => {
    lifetime.signal.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(lifetime.signal.reason);
    lifetime.signal.addEventListener("abort", abort, { once: true });
    const ms = opts.reviewTimeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;
    const started = performance.now();
    const timer = setTimeout(() => controller.abort(new DOMException(`${operation} did not answer within ${ms}ms`, "TimeoutError")), ms);
    const id = randomUUID();
    let accepting = true;
    let opaque = false;
    let failure: unknown;
    let latest: AuxiliaryReport = { operation, outcome: "completed", durationMs: 0, calls: [],
      reportedUsage: { input: 0, output: 0 }, unknownUsageCalls: 0, costUsd: 0 };
    const progress = (value: AuxiliaryReport): void => {
      if (!accepting) return;
      opaque = false;
      latest = structuredClone(value);
      session.control.record({ type: "auxiliary.usage", id, report: latest, final: false });
    };
    try {
      const pending = Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return work({ signal: controller.signal, ...(opts.auxiliaryLimits === undefined ? {} : { limits: opts.auxiliaryLimits }),
          onProgress: progress, onUsage: value => { if (accepting) { opaque = false; latest = structuredClone(value); } } }, () => {
          // A custom reviewer need not use our model adapter. Its opaque work has unknown cost,
          // not a fabricated zero. Built-in model snapshots replace this conservative marker.
          controller.signal.throwIfAborted();
          progress({ ...latest, calls: [{ operation, provider: "custom", outcome: "failed", durationMs: 0, usageComplete: false }],
            unknownUsageCalls: 1, costUsd: null });
          opaque = true;
        });
      });
      const result = await untilAborted(pending, controller.signal);
      if (performance.now() - started >= ms) controller.abort(new DOMException(`${operation} did not answer within ${ms}ms`, "TimeoutError"));
      controller.signal.throwIfAborted();
      if (JSON.stringify(result).length > (opts.auxiliaryLimits?.maxOutputChars ?? DEFAULT_AUXILIARY_LIMITS.maxOutputChars)) throw new AuxiliaryLimitError(`${operation} result exceeds output limit`);
      return result;
    } catch (error) { failure = error ?? new Error(String(error)); throw error; }
    finally {
      accepting = false;
      clearTimeout(timer);
      lifetime.signal.removeEventListener("abort", abort);
      const name = (failure as Error | undefined)?.name;
      const final: AuxiliaryReport = { ...latest, operation, durationMs: Math.max(0, performance.now() - started),
        outcome: failure === undefined ? latest.outcome : name === "TimeoutError" ? "timeout" : name === "AbortError" ? "aborted" : name === "AuxiliaryLimitError" ? "limit" : "failed" };
      if (opaque) final.calls = final.calls.map(call => ({ ...call, outcome: final.outcome, durationMs: final.durationMs }));
      controller.abort(new DOMException("auxiliary intervention closed", "AbortError"));
      auxiliaryDiagnostic(() => session.control.record({ type: "auxiliary.usage", id, report: final, final: true }));
      auxiliaryDiagnostic(() => opts.onUsage?.(structuredClone(final)));
    }
  };

  const done = (async () => {
    const iterator = session.events[Symbol.asyncIterator]();
    try { for (;;) {
      const next = await untilAborted(iterator.next(), lifetime.signal);
      if (next.done || detached || lifetime.signal.aborted) return;
      const event = next.value;
      try {
        reduce(state, event, stateOpts);
      } catch (err) {
        report("state", err);
        continue;
      }
      // the supervisor's own records come back through the stream; folding them is right
      // (lastInterventionSeq) but re-detecting on them is not
      if (event.type === "supervisor.signal" || event.type === "supervisor.intervention" || event.type === "auxiliary.usage") continue;

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
        if (detached || state.ended || lifetime.signal.aborted) break;

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
                  lifetime.signal,
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
              const review = await runAuxiliary("reviewer", async (call, start) => {
                const attempts = opts.attempts === undefined ? [] : await opts.attempts(session.id, call.signal!);
                start();
                return opts.reviewer!.review({
                    task: opts.task ?? "(task not supplied to the supervisor)",
                    trajectory: state.recent,
                    attempts,
                    ...(opts.memoryIndex === undefined ? {} : { memoryIndex: opts.memoryIndex }),
                  }, call);
              });
              if (detached || state.ended || lifetime.signal.aborted) break;
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
              const grade = await runAuxiliary("grader", async (call, start) => {
                const artifacts = opts.artifacts === undefined ? [] : await opts.artifacts(session.id, call.signal!);
                start();
                return opts.grader!.grade({
                    rubric: active.rubric,
                    artifacts,
                    trajectory: state.recent,
                  }, call);
              });
              if (detached || state.ended || lifetime.signal.aborted) break;
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
    } } finally {
      session.control.auxiliarySignal?.removeEventListener("abort", stop);
      auxiliaryDiagnostic(() => iterator.return?.());
    }
  })().catch((err: unknown) => {
    if (!lifetime.signal.aborted) report("observer", err);
  });

  return {
    detach: () => {
      detached = true;
      stop();
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
  attempts?: (sessionId: string, signal: AbortSignal) => Promise<Attempt[]> | Attempt[];
  artifacts?: (sessionId: string, signal: AbortSignal) => Promise<Array<{ path: string; content?: string }>>;
  reviewTimeoutMs?: number;
  auxiliaryLimits?: Partial<AuxiliaryLimits>;
  onUsage?: (report: AuxiliaryReport) => void;
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
    auxiliaryDiagnostic(() => opts.onError?.(
      "capabilities",
      new Error("force_replan was requested but this session has no update_plan tool; the rung is disabled"),
    ));
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
  if (opts.auxiliaryLimits !== undefined) attachOpts.auxiliaryLimits = opts.auxiliaryLimits;
  if (opts.onUsage !== undefined) attachOpts.onUsage = opts.onUsage;
  if (opts.escalateTimeoutMs !== undefined) attachOpts.escalateTimeoutMs = opts.escalateTimeoutMs;
  if (opts.onError !== undefined) attachOpts.onError = opts.onError;
  if (opts.pricing !== undefined) attachOpts.pricing = opts.pricing;
  if (opts.cacheReadDiscount !== undefined) attachOpts.cacheReadDiscount = opts.cacheReadDiscount;
  if (opts.cacheWriteMultiplier !== undefined) attachOpts.cacheWriteMultiplier = opts.cacheWriteMultiplier;
  if (opts.windowSize !== undefined) attachOpts.windowSize = opts.windowSize;
  return attach(session, attachOpts);
}

export type { SupervisorState };
