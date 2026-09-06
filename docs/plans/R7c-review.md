# R7c independent review

One bounded Claude review, session `fc922d93-97a3-45b2-88e7-500775eb376b`,
293,941 ms, 41 reported turns despite 24 requested, no error. No second broad review.
One fetch-containing compound command was denied; reviewer used cached main `f3a1ec8`.
The author independently refreshes/integrates latest main after review.

## Original response (verbatim)

Author disposition: low finding 2 fixed with fail-before/pass-after count-wording control.
Low finding 1 and remaining polish are non-blocking follow-ups at the roadmap end.
The response below is unchanged; subsequent main integration is separately validated.

**Verdict: APPROVE** (no blocking findings; two low-severity findings and some optional polish below).

## Scope reviewed

Uncommitted R7c changes in the worktree against local `origin/main` at `f3a1ec8`. I read CLAUDE.md, the scheduling and memory sections of `docs/PLAN.md` plus the new R7c paragraph, `docs/plans/R7c.md`, the full diff, `packages/cli/src/schedule-report.ts`, the tick loop in `program.ts`, `run.ts`, `agent-builder.ts`, `schedule.ts`, `memory/src/hooks.ts`, `ingest.ts` settlement, `tui/start.tsx`, `tui/app.tsx`, and all four touched or new test files.

## Findings

1. **Low — benign lock contention leaves a sticky operator-only marker.** `packages/cli/src/schedule-report.ts:82-88` and `packages/cli/src/program.ts:391-399`. `append` fails immediately on `EEXIST` with no bounded wait, and the TUI's `notice()` (`schedule-report.ts:113`) holds the same lock while reading. If a cron tick's receipt append lands during a TUI startup read, the receipt is lost, the run exits 1, and `schedule-report-uncertain.json` is created and stays until an operator removes it by hand. The behavior is truthful and matches the contract's "no stale-lock stealing", but a short bounded retry on `EEXIST` before declaring the receipt lost would remove most false uncertainty markers without stealing anything. Not blocking.

2. **Low — the "omitted history" notice still prints a literal zero.** `packages/cli/src/schedule-report.ts:119`. When all pending failures were pruned by retention, the text reads "0 scheduled runs failed. Earlier unacknowledged history was omitted; failure count is incomplete." The caveat is present, but the contract says pruned history is "never zero failures". Phrasing it as "unknown number of scheduled runs failed" when `failed.length === 0 && omitted` would match the contract exactly. Test at `schedule-report.test.ts:44-45` would need the assertion adjusted.

## Verified as correct

- **Actual run reporting**: outcome comes from the real `RunSummary.reason`, receipts are written only for ordinary entries or failed/maintenance-failed heartbeats, and successful heartbeats write nothing (`program.ts:386-390`, confirmed by `heartbeat.test.ts:112-114`).
- **Ingestion opt-out**: `ingestOnEndExplicit` correctly distinguishes a commander `"default"` source from CLI or config values (`config.ts:271-279`, `359`); the tick command uses `withProviderOptions`, so only config can opt out. Heartbeat forces `ingestOnEnd: false` before `ScheduledUsage` is constructed (`run.ts:376, 409`).
- **Actual log source**: `sessionDir: opts.root` is the same root `SessionStore` writes to (`agent-builder.ts:536, 646`); the path-containment check in `hooks.ts:55-60` is preserved.
- **Main/aux accounting**: no `auxiliary.usage` event is emitted for ingest (only the supervisor records them), so the `hook:ingest` key cannot double-count with `event:<id>` keys. `finish` keeps main and auxiliary separate, marks retry, pending, subagent, compaction, overflow, and missing settlement as partial, and never reports an unknown cost as zero. `ingestSession` delivers `onUsage` in a `finally`, and `onSettled` runs in the hook's `finally`, so a "done" session with configured memory always settles.
- **Canonical file, lock, retention, uncertainty**: canonical realpath root, symlink and non-regular-file refusal, exclusive temp file plus rename, 512-line and 512 KiB and 1 KiB bounds consistent with each other, sequence-gap detection, ack bounded by the displayed snapshot with `Math.max` against the stored cutoff, marker created exclusively and never overwritten or auto-cleared. Session IDs match the receipt regex (`session-store.ts:75`).
- **Ink acknowledgement**: `onMounted` fires from a `useEffect` after the first commit, guarded by a ref; the banner test asserts the rendered frame contains the notice before the acknowledgement commits, and the unmounted and untrusted cases never acknowledge.
- **Cancellation and errors**: launch errors retain the claim, write an `error` or `aborted` receipt with a null session ID and no error prose, and only rethrow when the signal is aborted. Report or marker failures set exit code 1 and never re-execute (`schedule-report.test.ts:122-155`).

## Optional polish

- `notice()` reads the log once unlocked for existence and again under the lock (`schedule-report.ts:108, 114`). The unlocked read could be replaced with a stat.
- The lock-busy message shown at TUI startup, "stop writers before recovering the report lock", suggests manual recovery when a tick may simply be running. A softer wording for the `notice()` path would avoid a misleading instruction.
- `maintenanceFailed` is set by every `onHookError`, including skill discovery and MCP errors (`agent-builder.ts:480, 493, 588`). That is conservative and visible, but the receipt field name reads narrower than what it records.
- The "log missing for acknowledged history" error does not name `schedule.ack.json`, which is the file an operator must inspect.
- Out of this row's scope but adjacent: the dream cadence still counts sessions under `memory/raw/sessions` (`hooks.ts:152`), so a custom memory root now ingests correctly but still sees zero sessions for dream scheduling.

## Checks executed

| Check | Result |
|---|---|
| `pnpm exec vitest run` on schedule-report, schedule-banner, heartbeat, schedule, config, memory hooks | 6 files, 123 tests passed |
| `pnpm typecheck` | all four packages clean |
| `git diff origin/main` and `git status` | reviewed in full |

No files were edited, no agents spawned, no provider calls made, no PR changes.

## Denied commands

One compound command containing `git fetch -q origin main` required approval and was not run. The review therefore used the locally known `origin/main` ref `f3a1ec8`, which matches the base named in `docs/plans/R7c.md`.
