# Status

Current milestone: **M1**

| M | Deliverable | Status |
|---|---|---|
| 0 | Monorepo skeleton, event schema, session JSONL store, replay CLI | done (2026-08-29) |
| 1 | Core loop: Anthropic adapter, 6 tools, allow/deny/ask permissions, budget, headless `run` | next |
| 2 | OpenAI-compatible adapter, compaction, resume | |
| 3 | Memory v1: wiki layout + `SCHEMA.md`, session-end ingest, `index.md` injection, index ∪ BM25 search, attempts ledger, pins | |
| 4 | Supervisor v1: heuristic detectors, policy ladder, inject/escalate/abort | |
| 5 | Dream = scheduled lint over a wiki copy, review/auto, promotion to global | |
| 6 | Supervisor v2: trajectory reviewer + rubric grader, force_replan | |
| 7 | TUI, hooks, MCP client, subagents, skills — as dogfooding demands | |

## M0 notes

- `HarnessEvent` = envelope (`seq`, `sessionId`, `ts`, stamped by the store) + discriminated `EventPayload`.
- `SessionStore` is append-only JSONL, one file per session; `read` validates every line and fails on seq gaps.
- `memory` and `supervisor` export interfaces only.
- `pnpm demo` writes a session containing the exact loop pattern M4's `loop` detector must catch.

## Open questions (from PLAN.md §8)

1. Sandboxing: none + allowlists for v1, Docker later
2. Git-based checkpoint rollback: opt-in or assumed
3. Overlap with AgentLens / Lore
4. Name and npm scope
5. Dogfood repo after the harness itself
