# R15c independent review — original record

One invocation, frozen `20e93885ffb300ed5d843517a292e8a382b36251` against
`317447521cd5b594f9d39c8dd45b9e37327a6562`. Session
`095ccd45-ceed-454c-8720-f3b4ee81acfc`; requested 24 turns, reported 27;
251.759 seconds. Reported model `claude-fable-5-1`; list-cost USD 3.423827 is
not a subscription-billing claim. Two ad-hoc shell commands were denied;
no edits, network, providers or subagents. Original final result follows verbatim.

## Verdict: REQUEST_CHANGES

Scope reviewed: commit `20e9388` against base `3174475` (19 files), plus CLAUDE.md, PLAN.md §2.2 and `docs/plans/R15c.md`. One material finding blocks approval. The privacy, provider replay, and cache-removal claims hold up under code and test inspection.

### Material finding

**Compaction stops working for sessions that contain reasoning.** The two new guards in `packages/core/src/compaction.ts` interact with the agent loop's give-up rule to disable compaction permanently in the two shapes that matter most.

- **Headless and single-task sessions** (`compaction.ts:88-102,108`). The `active` index is the last user message that is not tool-result-only. In an `agentrig run` session, that is the task at index 0. Once any assistant message carries a thinking block, line 102 clamps `cut` to 0, line 108 returns the messages unchanged, and `agent.ts:987-997` sets `compactionExhausted` and never retries. Before this commit the Responses provider replayed reasoning from its cache and compaction summarized older rounds normally. With a reasoning model on Responses, every turn emits a reasoning item, so this is the default path, not an edge case. The session then runs until the provider rejects the context.
- **Interactive multi-user sessions** (`compaction.ts:99`). The evict-only pass returns early without summarizing. The agent loop in `agent.ts:987` requires a 10 percent estimated reduction from a single call or it marks compaction exhausted. Stripping a few small thinking blocks rarely reaches 10 percent when tool results dominate, so the first compaction attempt in a session with reasoning also ends in permanent exhaustion.

The clamp is not needed for provider correctness. Summarization already keeps the tail verbatim and widens the cut so tool_use and tool_result pairs stay together, so retained assistant messages keep their reasoning and function_call items adjacent. Both vendors only require reasoning for the current chain after the last real user message, and the compaction summary itself becomes that user message.

**Minimal corrective direction:**

1. Remove the clamp at line 102, or narrow it to protect only from the last assistant message onward rather than from `active`.
2. Do not return early at line 99. Evict old thinking, then continue into the normal summarization path on the evicted result in the same call, so one compaction produces real progress.
3. Add a test with the existing `turn()` shape from `compaction.test.ts` plus thinking blocks on every assistant message. Assert the summarizer is called, the task survives, the kept tail equals the last turns byte-identically, and the result shrinks. The current thinking compaction test uses a two-user shape and cannot detect this.

I could not execute a reproduction script because direct `node -e` was denied in this session. The trace above is deterministic from the code and I am confident in it.

### Claims verified

- **Returned opaque thinking persists.** `agent.ts:132-141` appends parsed blocks in stream order with generated trust and advisory context. The two-adapter SSE test checks the second request body, canonical log, snapshot, fresh-provider resume and fork, and asserts the log is append-only.
- **Signatures not rendered or exported.** Controller prints only disclosed text under verbose. `renderEvent` prints block counts only. Export replaces thinking before the `view` helper runs, so the JSON-stringify fallback at `session-export.ts:148` never sees it. ACP forwards only text deltas unless raw events are opted in, which is declared sensitive. Memory ingest and supervisor condensation are canary-tested.
- **No hidden cache resurrection.** The cache field, the eviction constant, and the per-attempt caching are removed, not bypassed. The provider passes `undefined` for legacy groups. The dedicated test drives a live provider instance through a turn without persisted thinking and asserts zero reasoning items.
- **Chat Completions refuses before I/O.** `toOpenAIRequest` validates with no format, so any thinking block throws before fetch. Cross-format and user or nested placement are covered.
- **Tests discriminate.** The rewritten Responses replay test feeds actually parsed thinking events into history and still asserts exact-once order, so it no longer passes through hidden state. Forged display text is rejected by re-deriving from the replay payload in `thinkingToItem`.
- **Cache benefit unmeasured.** The E1-style test is a fixture rule and is labeled as such. Nothing claims a live delta.

### Optional polish, separate from the blocking finding

- The thinking-only placeholder inserted during eviction (`compaction.ts:97`) is an assistant text block labeled `external`. That trust label describes untrusted input, not a compaction-owned marker. Consider the same trust the summary uses.
- Anthropic replay is currently reachable only for SDK callers, since the adapter never sets a thinking parameter. The contract excludes automatic thinking, so this is a documented gap, not a defect. How the Anthropic API treats replayed thinking blocks when thinking is disabled on the request is unknown here and untestable offline.
- The ROADMAP §3 table still lists R15c's "AgentRig today" cell as "returned reasoning is dropped", which will be stale on merge.

### Commands run

```
git diff --stat 3174475 20e9388
git diff 3174475 20e9388 -- packages/ .github/ docs/
pnpm exec vitest run packages/core/test/thinking.test.ts packages/cli/test/thinking.test.ts packages/core/test/openai-chatgpt.test.ts packages/core/test/anthropic.test.ts packages/core/test/compaction.test.ts
pnpm typecheck
```

Focused vitest: 5 files, 52 tests, all passed. Typecheck: all four packages clean.

### Limitations

No full suite, no Docker, no provider calls, no network. The frozen-head full run is the author's concurrent claim and is not independently confirmed here. Shell execution of ad-hoc scripts was denied, so the compaction finding rests on code tracing, not an executed reproduction. No files were edited.
