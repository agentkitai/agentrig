import type { Usage } from "./events.js";

/** Shared accounting contract; these are auxiliary calls, never part of main-agent usage. */
export interface AuxiliaryCall {
  operation: string;
  provider: string;
  model?: string;
  outcome: "completed" | "failed" | "aborted" | "timeout" | "limit";
  durationMs: number;
  /** Last provider-reported cumulative snapshot. Undefined is unknown, not zero. */
  usage?: Usage;
  /** Partial snapshots on failed/abandoned calls do not establish total consumption. */
  usageComplete: boolean;
}

export interface AuxiliaryReport {
  operation: "ingest" | "dream" | "reviewer" | "grader";
  outcome: AuxiliaryCall["outcome"];
  durationMs: number;
  calls: AuxiliaryCall[];
  reportedUsage: Usage;
  unknownUsageCalls: number;
  /** No price assumptions: missing pricing/remote backend cost is never represented as free. */
  costUsd: number | null;
  /** Ingest/local maintenance status; cancellation never rolls back an earlier commit. */
  localCommitState?: "not-started" | "may-be-partial" | "completed";
}
