/**
 * @agentkitai/agentrig-memory — LLM Wiki memory. See docs/PLAN.md §3.
 *
 * M3 in progress. Landed so far: shared types, the page format (frontmatter parse/serialize,
 * fact lines, wikilinks), the file-backed wiki store with atomic slug reservation, and
 * index ∪ BM25 retrieval. Still to come this milestone: raw store, attempts ledger, pins,
 * session ingest, and the agent-facing memory tools. M5 adds the dream (scheduled lint).
 */
export * from "./types.js";
export * from "./page.js";
export * from "./store.js";
export * from "./search.js";
