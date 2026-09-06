# R10c independent review — original output

Snapshot `0b53f52` against `92946819`. One read-only `claude -p` invocation,
requested `--max-turns 24`; tool reported **28 turns**, 331,113 ms, session
`58365abf-1a55-4257-8a8a-8b8351fd8291`. No agents or live provider/network tests.
The original result below is verbatim. Its attempted directory/symlink reproduction
commands were denied; they did not establish an independent reproduction. The author
subsequently ran an actual owned symlink/junction-store fixture and observed a copied
parent JSONL file before the canonical-exclusion fix. This distinction is intentional.

---

Review complete. Verdict below, with what I ran and what was blocked.

## Verdict: REQUEST_CHANGES

One material defect, one coverage gap, two minor notes. The contract items otherwise hold up against the code.

## Findings

**1. Store exclusion is not canonicalized, unlike every other checkpoint exclusion (material).**
`packages/core/src/tool-execution.ts:394` binds `[config.store.root]` raw, and `packages/core/src/tools/subagent.ts:301` appends the child `config.store.root` raw. Every other exclusion site canonicalizes first (`tool-execution.ts:370`, `tool-execution.ts:635`, `agent.ts:1012`). In `prepareSubagentWorktree` the repo root is realpath'd (`subagent-worktree.ts:55`), so `captureTree` compares realpath'd file paths against a lexical `resolve(excluded)` (`checkpointer.ts:129`). Any symlink or short-name component in the store path defeats the exclusion.

Failure scenario: macOS tmpdir (`/var` to `/private/var`) or Windows tmpdir (`RUNNER~1` short name), which is exactly what the new test fixture uses via `os.tmpdir()`. The parent session log and snapshots under `runtime-logs/` get captured into the baseline and materialized into the child worktree, so the child can read the parent transcript, breaking the context isolation the tool exists for. Then in `finish()` the parent tree includes the child's newly created log file, so `ready` is false and the candidate is reported stale. The first test in `isolated-subagents.test.ts` would fail on the macOS and Windows CI legs that `ci.yml` now adds this file to. Fix: realpath both roots before binding, or canonicalize the exclude list inside `prepareSubagentWorktree`.

I could not execute this reproduction because directory and symlink creation was denied (details below). The conclusion is from code reading, not a run.

**2. No test for the ordinary-tool barrier (coverage).**
`parallel-runtime.ts:66` makes an isolated hazard conflict with everything non-isolated, and the plan claims isolated children are barriers against ordinary parent tool calls. No test puts an ordinary declared read or write in the same batch as isolated children. Reversed completion, FIFO prep and same-batch isolated overlap are tested, but this specific claim is asserted only in prose.

**3. Lock cleanup can mask the primary error (minor).**
`subagent-worktree.ts:109` awaits `rmdir(lock)` in `finally`. If the lock directory is non-empty or already gone, that throw replaces the original preparation error and its retained-path message.

**4. Child configuration runs before the enforcing-parent-sandbox refusal (minor).**
`subagent.ts:229` calls `childConfig()` and creates the permission view before the refusal at line 232. Permission evaluation is still first, so the contract holds, but the sandbox refusal could sit before configuration with no cost.

## Contract items verified in code

- Opt-in by factory object only, private WeakSet/WeakMap identity, not exported from the SDK entrypoint. Copied tool fails closed and is tested.
- Permission decision precedes `childConfig()` and Git preparation. Denial test checks zero child builds and no artifact root.
- Enforcing parent sandbox throws a plain Error, so no escalation prompt fires. Tested with an ask counter.
- No grant remapping. Child cwd differs, `childPermissionView` unchanged, delegable path and cwd grants tested as non-matching. The documented broad ancestor prefix case is a preserved lexical match, not a widening.
- Baseline uses the existing raw double-capture with a private index, synthetic detached commit, `--no-checkout` plus raw blob writes with `wx`, and read-tree into the worktree's own index. Parent HEAD and index are untouched. Recheck after preparation and before `ready`.
- Scheduling: FIFO gate held through preparation and released via the bound `ready()` only for isolated tools. Exclusive fallback preserved since `ready()` becomes a no-op. Early refusals hold the gate until `finish()`, which cannot deadlock.
- Cleanup: preparation and synchronous `child.run` failures decrement `live`, keep tokens reserved, consume the child count, and pair spawn with an end event. Tested for all three paths.
- Candidate is retained, never applied. Apply happens through a separately authorized tool with deny then allow tested, and the conflicting second patch rejected.
- Supervisor loop and stall detectors pinned for both completion orders with no file-change credit from child results.

## Commands executed

| Command | Result |
|---|---|
| `git diff --stat 9294681...HEAD` and per-file diffs | 12 files, +669 / -131 |
| `pnpm typecheck` | Green |
| `vitest run isolated-subagents, parallel-strategy, detectors` | 3 files, 129 tests passed |

## Commands denied or blocked

- Compound `rm && mkdir && ln -s && TMPDIR=... vitest` to reproduce finding 1 was denied.
- `mkdir -p /tmp/...` and `ln -sfn` outside the worktree were blocked by the sandbox.
- `mkdir -p .review-scratch/real` inside the worktree was also blocked.

## Limitations

- The symlinked-store reproduction was not executed. Finding 1 rests on reading `inside()` and the realpath asymmetry, plus the fixture's use of `os.tmpdir()`.
- Only Linux was exercised locally. No macOS or Windows run, no full suite, no live providers, no network.
- Candidate readiness remains a point-in-time observation as the plan states, and the 512 MiB figure is an admission bound, not a filesystem quota. Nothing here changes those characterizations.
