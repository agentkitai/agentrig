import type { HarnessEvent, Intervention, Signal } from "@agentkitai/agentrig-core";
import type { SupervisorState } from "./state.js";

export type { Signal, Intervention };
export type SignalType = Signal["type"];

export interface Detector {
  id: string;
  /** Optional read-only preparation; attach joins it before observe and passes cancellation. */
  prepare?(event: HarnessEvent, state: SupervisorState, signal: AbortSignal): Promise<void>;
  observe(event: HarnessEvent, state: SupervisorState): Signal | null;
}

export type EscalationOutcome = "answered" | "expired" | "closed";

export interface Policy {
  decide(signals: Signal[], state: SupervisorState): Intervention[];
  /** Optional feedback seam for policies whose future choice depends on whether a human answered. */
  onEscalationOutcome?(intervention: Intervention, outcome: EscalationOutcome): void;
}

export interface Detachable {
  detach(): void;
  /** Joins observation and any already-requested post-abort restore, including after detach. */
  done: Promise<void>;
}

/** Constructor with the clamping the schema demands, so a detector cannot emit confidence 1.4. */
export function signal(
  type: SignalType,
  confidence: number,
  evidence: string[],
  window: [number, number],
): Signal {
  return {
    type,
    confidence: Math.max(0, Math.min(1, confidence)),
    evidence,
    window: [Math.min(window[0], window[1]), Math.max(window[0], window[1])],
  };
}
