import type { HarnessEvent } from "@agentkitai/agentrig-core";
import type { Detector } from "../types.js";
import type { SupervisorState } from "../state.js";
import { signal } from "../types.js";

export interface ErrorBurstOptions {
  /** How many recent tool results form the window. */
  window?: number;
  /** Error fraction of that window that counts as a burst. */
  threshold?: number;
  /** Never fire on fewer than this many results — 1-of-1 is 100% and means nothing. */
  minSamples?: number;
}

/** PLAN §4.1: tool error rate over the last M calls above a threshold. */
export function errorBurstDetector(opts: ErrorBurstOptions = {}): Detector {
  const window = opts.window ?? 10;
  const threshold = opts.threshold ?? 0.5;
  const minSamples = opts.minSamples ?? 4;

  let results: boolean[] = [];

  return {
    id: "error_burst",
    observe(event: HarnessEvent, state: SupervisorState) {
      if (event.type !== "tool.result") return null;
      results.push(event.ok);
      if (results.length > window) results = results.slice(-window);
      if (results.length < minSamples) return null;

      const sampled = results.length;
      const failures = results.filter((ok) => !ok).length;
      const rate = failures / sampled;
      if (rate < threshold) return null;

      // reset so one burst is one signal; the rate has to be rebuilt from scratch to fire again
      results = [];
      return signal("error_burst", Math.min(1, rate), [
        `${failures} of the last ${sampled} tool calls failed (${Math.round(rate * 100)}%)`,
        `${state.toolErrors} tool error(s) this session`,
      ], [state.recent[0]?.seq ?? event.seq, event.seq]);
    },
  };
}
