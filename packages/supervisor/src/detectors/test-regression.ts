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
 * in isolation. Only a *drop* fires; a run that adds failures while keeping every pass (a new
 * test that does not pass yet) is ordinary progress, so failures alone are not the trigger.
 */
export function testRegressionDetector(): Detector {
  let bestPassed = -1;

  return {
    id: "test_regression",
    observe(event: HarnessEvent, state: SupervisorState) {
      if (event.type !== "tool.result") return null;
      const counts = parseTestCounts(event.display);
      if (counts === null) return null;

      const previousBest = bestPassed;
      if (counts.passed > bestPassed) bestPassed = counts.passed;
      if (previousBest < 0 || counts.passed >= previousBest) return null;

      const lost = previousBest - counts.passed;
      return signal("test_regression", Math.min(1, 0.6 + lost / 20), [
        `pass count dropped from ${previousBest} to ${counts.passed} (${lost} test(s) that used to pass no longer do)`,
        `${counts.failed} failing in this run`,
      ], [state.recent[0]?.seq ?? event.seq, event.seq]);
    },
  };
}
