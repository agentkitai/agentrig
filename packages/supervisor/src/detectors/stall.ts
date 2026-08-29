import type { HarnessEvent } from "@agentkitai/agentrig-core";
import type { Detector } from "../types.js";
import type { SupervisorState } from "../state.js";
import { signal } from "../types.js";
import { parseTestCounts } from "../test-output.js";

export interface StallOptions {
  /** Consecutive turns with no file change and no new tool kind before it counts as a stall. */
  turns?: number;
  /** Consecutive test runs reporting an identical pass count before it counts as a stall. */
  testRuns?: number;
}

/**
 * PLAN §4.1: "N consecutive turns with no `file.changed` and no new tool kind; or ≥ k test runs
 * with unchanged pass count."
 *
 * "No new tool kind" is the part that keeps this from firing on legitimate reading: a turn that
 * reaches for a tool it has not used before is exploring, even if it wrote nothing. A turn that
 * re-runs the same two tools and changes no file is spinning.
 */
export function stallDetector(opts: StallOptions = {}): Detector {
  const turnLimit = opts.turns ?? 3;
  const runLimit = opts.testRuns ?? 3;

  const toolKinds = new Set<string>();
  let quietTurns = 0;
  let changedThisTurn = false;
  let newKindThisTurn = false;

  let lastCounts: string | null = null;
  let identicalRuns = 0;

  return {
    id: "stall",
    observe(event: HarnessEvent, state: SupervisorState) {
      const from = state.recent[0]?.seq ?? event.seq;

      if (event.type === "file.changed") {
        changedThisTurn = true;
        return null;
      }

      if (event.type === "tool.call" && !toolKinds.has(event.name)) {
        toolKinds.add(event.name);
        newKindThisTurn = true;
        return null;
      }

      if (event.type === "tool.result") {
        const counts = parseTestCounts(event.display);
        if (counts === null) return null;
        const key = `${counts.passed}/${counts.failed}`;
        identicalRuns = key === lastCounts ? identicalRuns + 1 : 1;
        lastCounts = key;
        if (identicalRuns >= runLimit) {
          identicalRuns = 0;
          return signal("stall", 0.7, [
            `${runLimit} consecutive test runs reported the same ${counts.passed} passed / ${counts.failed} failed`,
            "the last few attempts moved nothing",
          ], [from, event.seq]);
        }
        return null;
      }

      if (event.type === "turn.end") {
        const productive = changedThisTurn || newKindThisTurn;
        changedThisTurn = false;
        newKindThisTurn = false;
        quietTurns = productive ? 0 : quietTurns + 1;
        if (quietTurns >= turnLimit) {
          quietTurns = 0;
          return signal("stall", 0.65, [
            `${turnLimit} consecutive turns changed no file and used no tool that had not been used before`,
            `${state.toolCalls} tool call(s) so far, ${state.filesChanged} file change(s)`,
          ], [from, event.seq]);
        }
      }

      return null;
    },
  };
}
