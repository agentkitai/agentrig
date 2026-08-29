import type { HarnessEvent } from "@agentkitai/agentrig-core";
import type { Detector } from "../types.js";
import type { SupervisorState } from "../state.js";
import { signal } from "../types.js";
import { parseTestCounts } from "../test-output.js";

/**
 * PLAN §4.1: "pass count drops vs. best seen this session".
 *
 * The best-seen high-water mark is the whole idea: a suite that goes 250 → 260 → 251 has broken
 * something that was working, and that is worth interrupting for even though 251 looks healthy
 * in isolation. Two things it must not mistake for a regression:
 *
 *  - **A subset run.** "run everything, then iterate on one package" is the single most common
 *    agent workflow, and 327 → 120 is not 207 broken tests. So a run is only compared when its
 *    *total* is at least the best total seen; a smaller suite is a different suite.
 *  - **A newly written failing test.** Added failures with no lost passes are ordinary progress,
 *    so failures alone are never the trigger — only a drop in `passed`.
 */
export function testRegressionDetector(): Detector {
  let bestPassed = -1;
  let bestTotal = -1;

  return {
    id: "test_regression",
    observe(event: HarnessEvent, state: SupervisorState) {
      if (event.type !== "tool.result") return null;
      const counts = parseTestCounts(event.display);
      if (counts === null) return null;

      const previousBest = bestPassed;
      const comparable = counts.total >= bestTotal;
      if (counts.passed > bestPassed) bestPassed = counts.passed;
      if (counts.total > bestTotal) bestTotal = counts.total;

      if (previousBest < 0 || !comparable || counts.passed >= previousBest) return null;

      const lost = previousBest - counts.passed;
      return signal("test_regression", Math.min(1, 0.6 + lost / 20), [
        `pass count dropped from ${previousBest} to ${counts.passed} (${lost} test(s) that used to pass no longer do)`,
        `${counts.failed} failing out of ${counts.total} in this run`,
      ], [state.recent[0]?.seq ?? event.seq, event.seq]);
    },
  };
}
