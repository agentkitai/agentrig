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
  /** Content hashes retained per file, and files tracked, so a long session stays bounded. */
  historyPerPath?: number;
  maxPaths?: number;
}

/**
 * Normalizes an error message so two runs of the same failure compare equal: durations, line
 * offsets, pids, hex ids and temp paths differ every time and would otherwise make a tight loop
 * look like a stream of distinct errors.
 *
 * It over-collapses by construction — "expected 1 but got 2" and "expected 41 but got 99"
 * fingerprint the same. That is tolerable only because the tally now resets on real progress
 * (see below): three *different* assertion failures with edits between them no longer read as a
 * loop, while the same command re-run three times with nothing changed still does.
 */
export function errorFingerprint(display: string): string {
  return display
    .slice(0, 400)
    // hex ids, but only ones containing a digit — otherwise ordinary words like "deadbeef"
    // and "faceless" collapse into each other
    .replace(/\b0x[0-9a-f]+\b/gi, "0x")
    .replace(/\b(?=[0-9a-f]{8,}\b)(?=[a-f]*\d)[0-9a-f]{8,}\b/gi, "#")
    // durations: \b so the rule cannot fire inside an identifier ("p5s" is not 5 seconds)
    .replace(/\b\d+(\.\d+)?(ms|s)\b/g, "T")
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
 * **Progress clears the tally.** A file changing to content it has not held before means the
 * session moved, so the repeat counters reset. Without this, re-reading one spec file between
 * edits — textbook agent behaviour, three identical `read_file` inputs — read as a loop, and a
 * session writing a new file every turn was aborted at turn 6 with five files of real progress
 * behind it. "Going in circles" has to mean circles, not repetition.
 *
 * Each trigger also re-arms after firing (its tally resets), so one loop produces one signal
 * rather than a signal per subsequent event; the policy's cooldown is a second line of defence,
 * not the only one.
 */
export function loopDetector(opts: LoopOptions = {}): Detector {
  const repeats = opts.repeats ?? 3;
  const window = opts.window ?? 30;
  const reverts = opts.reverts ?? 2;
  const historyPerPath = opts.historyPerPath ?? 64;
  const maxPaths = opts.maxPaths ?? 512;

  /** value + the seq it was seen at, so a fired signal can report the span it actually covers. */
  interface Seen {
    value: string;
    seq: number;
  }
  let hashes: Seen[] = [];
  let errors: Seen[] = [];
  const toolNames = new Set<string>();
  /** path -> content hashes seen, in order, capped. */
  const history = new Map<string, string[]>();
  const revertCount = new Map<string, number>();

  /** Keeps a per-path map bounded by evicting in insertion order. */
  const capPaths = <T>(m: Map<string, T>): void => {
    while (m.size > maxPaths) {
      const oldest = m.keys().next();
      if (oldest.done === true) break;
      m.delete(oldest.value);
    }
  };

  const tally = (list: Seen[], value: string, seq: number): Seen[] => {
    list.push({ value, seq });
    if (list.length > window) list.splice(0, list.length - window);
    return list.filter((v) => v.value === value);
  };

  const clearProgress = (): void => {
    hashes = [];
    errors = [];
  };

  return {
    id: "loop",
    observe(event: HarnessEvent, state: SupervisorState) {
      if (event.type === "tool.call") {
        // a tool it has never reached for before is exploration, not repetition
        if (!toolNames.has(event.name)) {
          toolNames.add(event.name);
          clearProgress();
          hashes.push({ value: event.inputHash, seq: event.seq });
          return null;
        }
        const hits = tally(hashes, event.inputHash, event.seq);
        if (hits.length >= repeats) {
          hashes = hashes.filter((h) => h.value !== event.inputHash);
          return signal("loop", Math.min(1, hits.length / (repeats * 2) + 0.5), [
            `called ${event.name} with identical input ${hits.length} times, with no file changing in between`,
            `inputHash=${event.inputHash}`,
          ], [hits[0]!.seq, event.seq]);
        }
        return null;
      }

      if (event.type === "tool.result" && !event.ok) {
        const print = errorFingerprint(event.display);
        if (print === "") return null;
        const hits = tally(errors, print, event.seq);
        if (hits.length >= repeats) {
          errors = errors.filter((e) => e.value !== print);
          return signal("loop", Math.min(1, hits.length / (repeats * 2) + 0.5), [
            `the same tool error came back ${hits.length} times, with no file changing in between`,
            event.display.slice(0, 200),
          ], [hits[0]!.seq, event.seq]);
        }
        return null;
      }

      if (event.type === "file.changed") {
        const seen = history.get(event.path) ?? [];
        // a revert is landing on a content this file already had *and differs from what it
        // holds now*. Rewriting the same content is a no-op write; only going back to an older
        // version is thrash.
        const isRevert = seen.at(-1) !== event.contentHash && seen.includes(event.contentHash);
        seen.push(event.contentHash);
        if (seen.length > historyPerPath) seen.splice(0, seen.length - historyPerPath);
        history.set(event.path, seen);
        capPaths(history);

        if (!isRevert) {
          // genuinely new content for this file: the session moved, so nothing is circling
          clearProgress();
          return null;
        }

        const n = (revertCount.get(event.path) ?? 0) + 1;
        revertCount.set(event.path, n);
        capPaths(revertCount);
        if (n >= reverts) {
          revertCount.set(event.path, 0);
          return signal("loop", 0.8, [
            `${event.path} was edited back to a previous version ${n} times`,
            "edit→revert thrash usually means two constraints are being satisfied alternately",
          ], [state.recent[0]?.seq ?? event.seq, event.seq]);
        }
        return null;
      }

      return null;
    },
  };
}
