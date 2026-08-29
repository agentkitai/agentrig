import type { HarnessEvent } from "@agentkitai/agentrig-core";
import type { Detector } from "../types.js";
import type { SupervisorState } from "../state.js";
import { signal } from "../types.js";

export interface LoopOptions {
  /** How many identical repeats inside the window count as a loop. */
  repeats?: number;
  /** How many recent tool calls / errors to consider. */
  window?: number;
  /** Edit→revert round trips on one file before it counts as thrash. */
  reverts?: number;
}

/**
 * Normalizes an error message so two runs of the same failure compare equal: durations, line
 * offsets, pids, hex ids and temp paths differ every time and would otherwise make a tight loop
 * look like a stream of distinct errors.
 */
export function errorFingerprint(display: string): string {
  return display
    .slice(0, 400)
    .replace(/0x[0-9a-f]+/gi, "0x")
    .replace(/\b[0-9a-f]{8,}\b/gi, "#")
    .replace(/\d+(\.\d+)?(ms|s\b)/g, "T")
    .replace(/\d+/g, "N")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * PLAN §4.1: fires on any of three shapes of going in circles —
 *  1. the same `tool.call.inputHash` repeated k times in the window,
 *  2. the same normalized tool error repeated k times,
 *  3. a file edited back to a content it already had, k times (edit→revert thrash).
 *
 * Each trigger re-arms after firing (its tally resets), so one loop produces one signal rather
 * than a signal per subsequent event; the policy's cooldown is a second line of defence, not the
 * only one.
 */
export function loopDetector(opts: LoopOptions = {}): Detector {
  const repeats = opts.repeats ?? 3;
  const window = opts.window ?? 30;
  const reverts = opts.reverts ?? 2;

  const hashes: string[] = [];
  const errors: string[] = [];
  /** path -> content hashes seen, in order */
  const history = new Map<string, string[]>();
  const revertCount = new Map<string, number>();

  const tally = (list: string[], value: string): number => {
    list.push(value);
    if (list.length > window) list.splice(0, list.length - window);
    return list.filter((v) => v === value).length;
  };

  const drop = (list: string[], value: string): void => {
    for (let i = list.length - 1; i >= 0; i -= 1) if (list[i] === value) list.splice(i, 1);
  };

  return {
    id: "loop",
    observe(event: HarnessEvent, state: SupervisorState) {
      const from = state.recent[0]?.seq ?? event.seq;

      if (event.type === "tool.call") {
        const n = tally(hashes, event.inputHash);
        if (n >= repeats) {
          drop(hashes, event.inputHash);
          return signal("loop", Math.min(1, n / (repeats * 2) + 0.5), [
            `called ${event.name} with identical input ${n} times in the last ${window} tool calls`,
            `inputHash=${event.inputHash}`,
          ], [from, event.seq]);
        }
        return null;
      }

      if (event.type === "tool.result" && !event.ok) {
        const print = errorFingerprint(event.display);
        if (print === "") return null;
        const n = tally(errors, print);
        if (n >= repeats) {
          drop(errors, print);
          return signal("loop", Math.min(1, n / (repeats * 2) + 0.5), [
            `the same tool error came back ${n} times`,
            event.display.slice(0, 200),
          ], [from, event.seq]);
        }
        return null;
      }

      if (event.type === "file.changed") {
        const seen = history.get(event.path) ?? [];
        // a revert is landing on a content this file already had at some earlier point
        const isRevert = seen.slice(0, -1).includes(event.contentHash);
        seen.push(event.contentHash);
        history.set(event.path, seen);
        if (!isRevert) return null;
        const n = (revertCount.get(event.path) ?? 0) + 1;
        revertCount.set(event.path, n);
        if (n >= reverts) {
          revertCount.set(event.path, 0);
          return signal("loop", 0.8, [
            `${event.path} was edited back to a previous version ${n} times`,
            "edit→revert thrash usually means two constraints are being satisfied alternately",
          ], [from, event.seq]);
        }
        return null;
      }

      return null;
    },
  };
}
