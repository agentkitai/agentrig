import type { Detector } from "../types.js";
import { loopDetector, type LoopOptions } from "./loop.js";
import { stallDetector, type StallOptions } from "./stall.js";
import { errorBurstDetector, type ErrorBurstOptions } from "./error-burst.js";
import { budgetDetector, type BudgetOptions } from "./budget.js";
import { testRegressionDetector } from "./test-regression.js";
import { driftDetector, type DriftOptions } from "./drift.js";
import { injectionDetector } from "./injection.js";

export * from "./loop.js";
export * from "./stall.js";
export * from "./error-burst.js";
export * from "./budget.js";
export * from "./test-regression.js";
export * from "./drift.js";
export * from "./injection.js";

export interface DefaultDetectorOptions {
  loop?: LoopOptions;
  stall?: StallOptions;
  errorBurst?: ErrorBurstOptions;
  budget?: BudgetOptions;
  drift?: DriftOptions;
}

/** Runtime heuristic detectors, including external instruction-shape signals; no model calls. */
export function defaultDetectors(opts: DefaultDetectorOptions = {}): Detector[] {
  return [
    loopDetector(opts.loop ?? {}),
    stallDetector(opts.stall ?? {}),
    errorBurstDetector(opts.errorBurst ?? {}),
    budgetDetector(opts.budget ?? {}),
    testRegressionDetector(),
    driftDetector(opts.drift ?? {}),
    injectionDetector(),
  ];
}
