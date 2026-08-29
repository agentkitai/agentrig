import type { Session } from "@agentkitai/agentrig-core";
import type { Detachable, Detector, Policy } from "./types.js";
import { initialState, reduce, type StateOptions, type SupervisorState } from "./state.js";
import { LadderPolicy, type Capabilities, type LadderOptions } from "./policy.js";
import { defaultDetectors, type DefaultDetectorOptions } from "./detectors/index.js";

export interface AttachOptions extends StateOptions {
  detectors: Detector[];
  policy: Policy;
  /**
   * Where an `escalate` intervention goes. Its presence is what makes the `escalate` rung
   * available at all — without a human on the other end the ladder skips straight to abort.
   */
  onEscalate?: (question: string) => void | Promise<void>;
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
 *  - **It never blocks the loop.** It reads a replayed buffer of the event stream (core's
 *    `EventStream` hands every consumer its own cursor), so a slow detector delays interventions
 *    and nothing else. Guidance is queued through `steer()` and lands at the next turn boundary,
 *    which is the only point where injecting a message is coherent.
 *
 * `force_replan`, `run_grader` and `checkpoint_rollback` are recorded but not applied in M4 —
 * they need the pre-tool hook, a grader, and git checkpoints respectively. The default policy
 * will not produce them unless the matching capability is declared, so in practice they do not
 * appear; a hand-written policy that emits one gets an `onError` report rather than silence.
 */
export function attach(session: Session, opts: AttachOptions): Detachable {
  const state = initialState();
  const stateOpts: StateOptions = {};
  if (opts.windowSize !== undefined) stateOpts.windowSize = opts.windowSize;
  if (opts.pricing !== undefined) stateOpts.pricing = opts.pricing;

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
        try {
          switch (intervention.type) {
            case "inject_guidance":
              session.control.steer(intervention.message, "supervisor");
              break;
            case "escalate":
              await opts.onEscalate?.(intervention.question);
              break;
            case "abort":
              session.control.abort();
              break;
            default:
              report(
                "apply",
                new Error(`intervention "${intervention.type}" is recorded but not applied until a later milestone`),
              );
          }
        } catch (err) {
          report(`apply:${intervention.type}`, err);
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
  capabilities?: Capabilities;
  onEscalate?: (question: string) => void | Promise<void>;
  onError?: (where: string, err: Error) => void;
  pricing?: StateOptions["pricing"];
  windowSize?: number;
}

/**
 * The batteries-included attachment: the six v1 detectors and the default ladder, with the
 * `escalate` rung enabled exactly when an `onEscalate` handler was supplied.
 */
export function supervise(session: Session, opts: SuperviseOptions = {}): Detachable {
  const capabilities: Capabilities = { escalate: opts.onEscalate !== undefined, ...(opts.capabilities ?? {}) };
  const attachOpts: AttachOptions = {
    detectors: defaultDetectors(opts),
    policy: new LadderPolicy({ ...(opts.ladder ?? {}), capabilities }),
  };
  if (opts.onEscalate !== undefined) attachOpts.onEscalate = opts.onEscalate;
  if (opts.onError !== undefined) attachOpts.onError = opts.onError;
  if (opts.pricing !== undefined) attachOpts.pricing = opts.pricing;
  if (opts.windowSize !== undefined) attachOpts.windowSize = opts.windowSize;
  return attach(session, attachOpts);
}

export type { SupervisorState };
