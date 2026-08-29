/**
 * @harness/supervisor — out-of-band observer over the event stream. See docs/PLAN.md §4.
 *
 * M0: interfaces only. Heuristic detectors + policy ladder land in M4; reviewer + grader in M6.
 * Depends only on core's event types.
 */
import type { HarnessEvent, Intervention, Signal } from "@harness/core";

export type { Signal, Intervention };

export interface SupervisorState {
  /** Rolling window of recent events; detectors decide how much they need. */
  recent: HarnessEvent[];
  turns: number;
  filesChanged: number;
  toolErrors: number;
  lastInterventionSeq: number | null;
}

export interface Detector {
  id: string;
  observe(event: HarnessEvent, state: SupervisorState): Signal | null;
}

export interface Policy {
  decide(signals: Signal[], state: SupervisorState): Intervention[];
}

export interface Detachable {
  detach(): void;
}
