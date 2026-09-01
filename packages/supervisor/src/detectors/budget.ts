import type { HarnessEvent } from "@agentkitai/agentrig-core";
import type { Detector } from "../types.js";
import type { SupervisorState } from "../state.js";
import { signal } from "../types.js";

export interface BudgetOptions {
  /** Fraction of each hard limit at which the soft threshold trips. */
  soft?: number;
  /** Absolute turn window that also trips the warning, whichever threshold is reached first. */
  turnsRemaining?: number;
  maxTurns?: number;
  maxTokens?: number;
  maxUsd?: number;
  maxMinutes?: number;
}

/**
 * PLAN §4.1: "turns / tokens / USD / minutes past soft threshold (hard threshold is core's job)".
 *
 * The point of the soft threshold is that core's hard limit just stops the session; crossing the
 * soft one is a chance to say "you have a quarter of the budget left, land what you have".
 * Each dimension fires once — re-warning every turn past 80% is the nagging cooldowns exist to
 * prevent, and here it is free to just not do it.
 */
export function budgetDetector(opts: BudgetOptions = {}): Detector {
  const soft = opts.soft ?? 0.8;
  const turnsRemaining = opts.turnsRemaining ?? 15;
  const fired = new Set<string>();

  return {
    id: "budget",
    observe(event: HarnessEvent, state: SupervisorState) {
      const from = state.recent[0]?.seq ?? event.seq;
      const minutes =
        state.startedAt === null ? 0 : Math.max(0, (state.lastTs - state.startedAt) / 60_000);

      const dims: Array<{ name: string; used: number; limit: number | undefined; fmt: (n: number) => string }> = [
        { name: "turns", used: state.turns, limit: opts.maxTurns, fmt: (n) => `${n}` },
        { name: "tokens", used: state.usage.input + state.usage.output, limit: opts.maxTokens, fmt: (n) => `${n}` },
        { name: "usd", used: state.usd, limit: opts.maxUsd, fmt: (n) => `$${n.toFixed(2)}` },
        { name: "minutes", used: minutes, limit: opts.maxMinutes, fmt: (n) => `${n.toFixed(1)}m` },
      ];

      for (const d of dims) {
        if (d.limit === undefined || d.limit <= 0 || fired.has(d.name)) continue;
        const frac = d.used / d.limit;
        const remaining = d.limit - d.used;
        const inTurnLandingWindow = d.name === "turns" && remaining <= turnsRemaining;
        if (frac < soft && !inTurnLandingWindow) continue;
        fired.add(d.name);
        const thresholdEvidence = inTurnLandingWindow
          ? `${Math.max(0, remaining)} turns remain (configured wrap-up window: ${turnsRemaining})`
          : `soft threshold ${Math.round(soft * 100)}% reached`;
        // A landing-window signal can arrive below the policy's default 0.5 confidence floor on a
        // small budget. Score the configured condition itself, not merely spend, or the policy will
        // discard the signal after this detector has latched it as fired.
        const confidence = inTurnLandingWindow ? Math.max(frac, soft, 0.5) : frac;
        return signal("budget", Math.min(1, confidence), [
          `${d.name} budget ${Math.round(frac * 100)}% spent: ${d.fmt(d.used)} of ${d.fmt(d.limit)}; ${thresholdEvidence}`,
          "core will stop the session at the hard limit; there is still room to finish deliberately",
        ], [from, event.seq]);
      }
      return null;
    },
  };
}
