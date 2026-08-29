import type { Detector } from "../types.js";
import { loopDetector, type LoopOptions } from "./loop.js";
import { stallDetector, type StallOptions } from "./stall.js";
import { errorBurstDetector, type ErrorBurstOptions } from "./error-burst.js";
import { budgetDetector, type BudgetOptions } from "./budget.js";
import { testRegressionDetector } from "./test-regression.js";
import { driftDetector, type DriftOptions } from "./drift.js";

export * from "./loop.js";
export * from "./stall.js";
export * from "./error-burst.js";
export * from "./budget.js";
export * from "./test-regression.js";
export * from "./drift.js";

export interface DefaultDetectorOptions {
  loop?: LoopOptions;
  stall?: StallOptions;
  errorBurst?: ErrorBurstOptions;
  budget?: BudgetOptions;
  drift?: DriftOptions;
}

/** The six v1 detectors from PLAN §4.1, all heuristic and all free — no model call anywhere. */
export function defaultDetectors(opts: DefaultDetectorOptions = {}): Detector[] {
  return [
    loopDetector(opts.loop ?? {}),
    stallDetector(opts.stall ?? {}),
    errorBurstDetector(opts.errorBurst ?? {}),
    budgetDetector(opts.budget ?? {}),
    testRegressionDetector(),
    driftDetector(opts.drift ?? {}),
  ];
}
