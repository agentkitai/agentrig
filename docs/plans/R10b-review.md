# R10b — independent review receipt

One bounded read-only Claude review on integrated head `f2b02a6`/main `a99f3ec`.
Session `a1461659-bc98-4188-a9b4-6def7912188f`; 362 seconds; 18 reported turns / max24 requested.
It independently ran 48 focused tests, the 21 new tests separately, and full typecheck.
Three shell commands were denied (combined shell/tsc invocations); the approved focused
vitest and pnpm typecheck commands did run. No subagents or live provider probes.
The reviewer’s line numbers are concatenated-read offsets, not reliable source line numbers.

## Original result (verbatim)

**Verdict: approve R10b as implemented. No material defects found.** The scheduler, gate ordering, hazard classification and join semantics match the contract in docs/plans/R10b.md. Sequential pinned traces are unchanged, and everything I ran passed.

**What I ran**

| Check | Result |
|---|---|
| parallel-strategy, turn-strategy, h6-trace, token-continuation tests | 48 passed, 4 files |
| parallel-strategy alone | 21 passed, matching the claimed count |
| `pnpm typecheck` | all four packages clean |

**Verified against the review focus**

- **Private runtime binding.** The bridge is a WeakMap keyed on the exact context object in `packages/core/src/parallel-runtime.ts:135`. A copied context falls back to sequential in `turn-strategy.ts:349`. Model input never reaches scheduling metadata.
- **Final post-hook metadata.** Permission, paths and effects are computed once from the revalidated, hook-merged input in `tool-execution.ts:279-285`, and admission happens after that. The hook test confirms one paths callback per call.
- **Path and inode hazards.** Canonical realpath plus lowercased NFC keys, ancestor and descendant checks, and dev:inode identity in `parallel-runtime.ts:159-191`. Dangling symlinks return exclusive via the lstat probe at line 175. Missing parents return exclusive at line 178. Reads of missing targets, special files, ELOOP and ENOTDIR all fall through to exclusive. Reclassification after each wait at line 219 covers alias changes by earlier writers.
- **FIFO barriers.** The prepare mutex is held from `prepare()` through `admit()` and released only in `authorized()` for non-exclusive calls, or in `finish()` for exclusive ones. A blocked conflicting call therefore blocks all later calls, which the six serialization cases test.
- **Hooks and background fallback.** `agent.ts:908` forces exclusive when any config hook exists or any tool reports background work. Extension hooks live in the same `config.hooks` array that `hook()` reads at `agent.ts:305`, so the check is consistent with what actually runs. Exclusive calls hold prepare across the body and wait for the active set to drain.
- **Late sandbox ask serialization.** The onAsk wrapper is installed before `executeToolInner` at `tool-execution.ts:173-178`, and the escalation path at line 453 reads `config.onAsk` from that wrapped context, so it shares the prompt mutex. No lock cycle exists: ask is always acquired while holding prepare or while already authorized, never the reverse.
- **Permission, MCP and fresh-consent gates.** All existing gates in lines 298-360 run unchanged inside the lease. Grant-session and view-expiry checks are untouched. MCP definition consent is outside the tool pipeline and unaffected.
- **Failure and abort joining.** Workers stop dequeuing on failure or abort, waiters wake on the next `finish()` and throw, all started pipelines are awaited at line 236, and the first failure is rethrown only when not aborted. Abort returns an interrupted empty batch, as documented.
- **Sequential unchanged.** Without a schedule, `declaredEffect` is only computed when checkpointers exist, and `toolEffect` reduces to the previous expression. Pinned trace tests pass.

**Optional polish, none blocking**

- `parallel-runtime.ts:170-171`. The `info.ino === 0n` spread guard is dead, since line 170 already returned for that case.
- `.github/workflows/ci.yml:119`. The new step re-runs turn-strategy and h6-trace, which line 118 already runs. Either drop the duplicates or fold parallel-strategy into the prior step.
- `parallel-strategy.test.ts:435`. The 100ms held-body window is timing-sensitive, as R10b.md admits. A deterministic companion assertion is available at no cost: the blocked call's permission.request seq must exceed the held call's tool.result seq, because admission precedes that emit. This does not replace the window for the mutant, but it strengthens the positive direction.
- Fatal rejection joining. A sibling call already waiting in a permission prompt keeps the batch open until the user answers. This is the documented join behaviour, but worth a sentence in R10b.md so nobody reads it as a hang.
- Trust wording. `extensions.ts:155` wraps extension-declared `effects` and `paths`, so extension tools are parallel candidates on the same trust basis already used for checkpoint skipping. R10b.md says "trusted SDK"; naming extension registration explicitly would be more accurate.

**Honest limits preserved.** The docs correctly state that declarations are cooperative contracts rather than sandboxing, and that raceAbort may still report uncooperative orphan work. One consequence worth knowing: an aborted call whose fresh-expansion ask was queued behind the per-batch prompt mutex can still surface its prompt after abort. That is the pre-existing raceAbort orphan, scoped to the aborted batch only, not a new defect.

## Disposition

The reviewer approved with no material findings. Independently during review, the author
identified directory traversal aliases and missing-name Windows spelling ambiguities; those
are not credited to this review. Actual grep-through-hardlink output and four missing-name
ordering controls failed before the conservative exclusive fallback, then passed after it.
Regular-file disjoint reads/writes and ordinary ASCII new-file concurrency remain supported.

The reviewer’s final paragraph calls a queued callback after abort pre-existing. The new
mutex can queue additional prompts, so this was treated as a material new boundary instead:
a real two-sandbox-denial control observed two callbacks after cancellation before the fix,
and exactly one after checking stopped state immediately before invoking a released callback.
Already-running host callbacks are still joined, not forcibly canceled or abandoned.

Optional feedback addressed: redundant inode guard removed, CI duplicates folded into the
existing strategy group, permission-request-versus-result sequence assertions added, and
prompt-join/extension-declaration trust wording clarified. The 100ms negative observation
windows remain explicitly timing-sensitive; positive disjoint entry is controlled separately.
No second general review was run for these bounded fixes or subsequent mechanical integration.
