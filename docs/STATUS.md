# Status

Current milestone: **M2**

| M | Deliverable | Status |
|---|---|---|
| 0 | Monorepo skeleton, event schema, session JSONL store, replay CLI | done (2026-08-29) |
| 1 | Core loop: Anthropic adapter, 6 tools, allow/deny/ask permissions, budget, headless `run` | done (2026-08-29) |
| 2 | OpenAI-compatible adapter, compaction, resume | next |
| 3 | Memory v1: wiki layout + `SCHEMA.md`, session-end ingest, `index.md` injection, index ∪ BM25 search, attempts ledger, pins | |
| 3b | Lore backend: `MemoryBackend` seam + Lore adapter (ingest push, recall union, promote, provenance both ways) | |
| 4 | Supervisor v1: heuristic detectors, policy ladder, inject/escalate/abort | |
| 5 | Dream = scheduled lint over a wiki copy, review/auto, promotion to global | |
| 6 | Supervisor v2: trajectory reviewer + rubric grader, force_replan | |
| 7 | TUI, hooks, MCP client, subagents, skills — as dogfooding demands | |

## M0 notes

- `HarnessEvent` = envelope (`seq`, `sessionId`, `ts`, stamped by the store) + discriminated `EventPayload`.
- `SessionStore` is append-only JSONL, one file per session; `read` validates every line and fails on seq gaps.
- `memory` and `supervisor` export interfaces only.
- `pnpm demo` writes a session containing the exact loop pattern M4's `loop` detector must catch.

## M1 notes

- `agentrig run "<task>" --headless --json` works end to end; `ask` resolves to deny headless.
  Without `--headless` on a TTY, `ask` prompts on stderr via `AgentConfig.onAsk` (the same seam
  the M7 TUI will use).
- Tools declare `paths()`; `cwdOnly` permission rules confine file tools to the project.
  `--allow write` is cwd-confined; `--allow write:anywhere` lifts it. bash declares no paths and
  cannot be confined — `--allow exec` is all-or-nothing.
- Stop reasons: `refusal` ends the session `done` with a non-fatal error event; a final response
  truncated at `max_tokens` ends it `reason: error` (CLI exit 1); unknown provider stop reasons
  surface verbatim via `raw` in the fatal error message.
- `steer()` takes an optional source (`user` default; the M4 supervisor passes its own); a steer
  still queued when the session ends is recorded as a non-fatal error, never silently dropped.
- Every event — including `file.changed` emitted from inside tools — goes through
  `SessionStore.append` on one promise chain, so `seq` order is emission order and
  `session.events` replays identically to the on-disk log.
- `ToolResult` gained optional `isError`: expected failures (non-zero exit, missing file, bad
  regex) reach the model as error tool_results; throwing is for unexpected failures only.
- Anthropic adapter speaks the streaming REST API directly (no vendor SDK) with an injectable
  `fetchFn`, so tests exercise the full SSE path with no network.
- Budgets are enforced at turn boundaries; `maxUsd` binds only when `pricing` is configured.
- Deferred to their milestones, per build order: hooks, compaction, resume (M2), TUI (M7).

## Decided

- Lore is an optional `MemoryBackend` behind the seam in PLAN.md §3.8; the wiki stays the source
  of truth and the default stays no-infra (milestone 3b).
- AgentLens is a future sink for the event stream (observability), not a memory dependency.

## Open questions (from PLAN.md §8)

1. Sandboxing: none + allowlists for v1, Docker later
2. Git-based checkpoint rollback: opt-in or assumed
3. Dogfood repo after AgentRig itself
