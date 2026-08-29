import type { HarnessEvent, Intervention, Signal } from "@agentkitai/agentrig-core";
import type { SupervisorState } from "./state.js";

export type { Signal, Intervention };
export type SignalType = Signal["type"];

export interface Detector {
  id: string;
  observe(event: HarnessEvent, state: SupervisorState): Signal | null;
}

export interface Policy {
  decide(signals: Signal[], state: SupervisorState): Intervention[];
}

export interface Detachable {
  detach(): void;
  /** Resolves once the observer has drained the stream — tests and shutdown paths need a join. */
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
