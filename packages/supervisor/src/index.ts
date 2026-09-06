/**
 * @agentkitai/agentrig-supervisor — out-of-band observer over the event stream. See docs/PLAN.md §4.
 *
 * M4 shipped the six heuristic detectors, the escalating ladder, and `attach`. M6 adds the
 * LLM-backed reviewer and grader (§4.3) and makes `force_replan` real, so every rung of PLAN
 * §4.2's ladder is now reachable when its machinery is attached.
 * Depends only on core's event types.
 */
export * from "./types.js";
export * from "./state.js";
export * from "./test-output.js";
export * from "./detectors/index.js";
export * from "./policy.js";
export * from "./reviewer.js";
export * from "./grader.js";
export * from "./supervisor.js";
export * from "./auxiliary.js";
