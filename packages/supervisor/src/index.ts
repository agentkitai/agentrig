/**
 * @agentkitai/agentrig-supervisor — out-of-band observer over the event stream. See docs/PLAN.md §4.
 *
 * M4: the six heuristic detectors, the escalating policy ladder, and `attach`. The LLM-backed
 * reviewer and grader (§4.3) are M6; the ladder already has rungs for them, gated on capability.
 * Depends only on core's event types.
 */
export * from "./types.js";
export * from "./state.js";
export * from "./test-output.js";
export * from "./detectors/index.js";
export * from "./policy.js";
export * from "./supervisor.js";
