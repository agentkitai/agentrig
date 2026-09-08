# R17b repair round 1/3 — PR #234

> Preserved historical record. Current behavior/evidence and explicit withdrawals
> are in [repair round 2](R17b-round2.md); the old skipped-tsc, empty E1 errors,
> 18-mutant current-head implication and pending CI claims do not apply to round 2.

Builder **agentrig**, conductor **8fbde1a3**, repair child **12b8dd75** (child 4:
`7dbfad2b`, `1bb8ec86`, `b9109d9f`, `12b8dd75`). Old head
`33cf281fa2e6d36d07537dee9940e2e635cd816d`; baseline-first commit `cf3ed28`
is retained. This is a repair, not independent approval. Both delta reviewers
still have to review the pushed final head. No PR merge and no new arbitration.
The sandbox exception in PR **Deviations** is unchanged.

Source findings: [Claude 1–13](https://github.com/agentkitai/agentrig/pull/234#issuecomment-5573922615)
and [Codex P2](https://github.com/agentkitai/agentrig/pull/234#issuecomment-5573922807).

## Complete finding ledger

| Finding | Resolution and reproducible proof |
| --- | --- |
| Claude 1, ref growth | After a durable ownership seal, compare-and-delete older numeric turn refs, retaining the last two and all sealed receipts. No CLI capability added. `checkpointer.test.ts` test `sealing retains` checks five historical creation events, exact retained refs, unchanged HEAD, fail-closed undo of a pruned target, and successful undo of a retained target. Existing dirty-byte/index/HEAD/external-writer and immutable-log undo tests remain. Unsealed recovery refs are deliberately not deleted; this is bounded turn retention after seal, not global session/GC retention. |
| Claude 2, destructive authority | `superviseExplicit` and `checkpointsExplicit` come only from trusted config/explicit argv provenance, not defaults. Both must be true in addition to the existing values, explicit abort/restore and sandbox-none guards. Config cannot forge internal markers. Tests cover implicit, one-explicit, explicit false and both-explicit cases. The exact user scenario now refuses before mutation. |
| Claude 3, diagnostics applicability | Implicit root tsc is skipped without a root tsconfig and for reference-bearing roots. No package/workspace discovery is added. Existing explicitly configured checkers are not replaced. Implicit Ruff requires a root Python/Ruff config and receives the edited absolute file after `--`, not `.`. Exact `{path}` argument substitution happens before existing exec permission validation, with no shell interpolation. Tests cover clean/error real tsc, absent/reference-only roots, Python scoping, spaces/metacharacters in argv and missing executables. |
| Claude 4, persistent summary preference breaks CI | CI normalizes persistent expanded chat output to summaries while still refusing JSON and unsafe execution settings. Real CI fixture uses user `toolSummaries:false` without a special profile. ACP/MCP/Web ignore this chat-only preference; JSON and loopback/protocol boundaries remain. Protocol startup and real MCP tests cover it. |
| Claude 5, no final terminal measurement | Re-ran the existing terminal fixture after repairs; committed `R17b-repair-terminal.json`. One sample: cold prompt 526.442 ms, submit-to-first-token 74.817 ms, root help 2 options. Baseline was 403.700/59.722 ms; these are single samples, not a speedup claim or percentile. Reproduce with `python3 .agentrig/r17/terminal-baseline.py`. |
| Claude 6, no post-default prompt/turn/cost measurement | `recommended-e1.mjs` replays all eight original task bodies through the real CLI resolver and builder, attaches the supervisor, exercises checkpoints and completed ingest, and runs existing evaluator checks. `R17b-repair-e1.json` records permission prompts, turns, checker selection, checkpoint counts and per-call auxiliary reports. Counts below explicitly expose added ingestion requests and unknown cost. No claim of fewer prompts or lower cost remains. |
| Claude 7 AND Codex P2 | Pass resolved verbosity through `startTui` into controller initial state, retaining session-local toggling. Controller regression plus `recommended-smoke.py --expanded` prove the real persistent preference. A mutation removing the startup pass-through fails the PTY expanded-output assertion. Both reviewers receive credit for the same repair. |
| Claude 8, built-in profile leaks | Shared `resolveConfig` again rejects absent profile names. Only the run-capable CLI layer recognizes implicit `recommended`. Test exercises strict pure resolver and ordinary run's built-in selection. |
| Claude 9, vacuous recommendation test | Raw parsing test is explicitly named raw parsing, not a default-resolution claim. Real `buildProgram` handlers assert resolved checkpoints for run, TUI and resume. Defaults-disabled real-CLI mutant fails the runtime regression. |
| Claude 10, missing negative override coverage | Restore a real handler precedence regression for surviving `--no-sandbox-network` overriding trusted positive config. Mutation replacing explicit CLI precedence with project values fails it. Retain the separate config-false regression. |
| Claude 11, blanket trust in fixtures | Remove all blanket `--trust` insertions from the five cited fixtures. Put harness-owned `ingestOnEnd:false` in separate, isolated user HOME config, outside the simulated checkout. Keep explicit project-trust scenarios only where the original test is testing project trust. Original main-loop request/permission assertions remain. |
| Claude 12, runtime fixture cwd | Resolve the built CLI entry with `new URL('../dist/index.js', import.meta.url)`, independent of process cwd. Run from repository root and a CLI-workspace invocation with the repository Vitest root (the shared include glob is repository-relative). |
| Claude 13, migrated-flag help | Abort-restore error/help no longer tell operators to type removed flags; they require explicit config sources. Tests assert removed options absent and restored guidance. |

## Real probes, not code-reading substitutes

Run `TMPDIR=/var/tmp python3 .agentrig/r17/repair-mutations.py` on Linux in a
throwaway worktree after install/build. The script restores each changed source
in `finally`, rebuilds around built-runtime probes, and fails if any mutant
survives. `docs/plans/R17b-repair-mutations.json` records exact replacements,
commands, exit codes and real failing output. It includes precedence, surviving
negative CLI, scheduled ingest provenance, migrated-flag resurrection, implicit
sandbox omission, destructive source checks, ref retention, root diagnostics,
scoped argv, profile boundary, CI/evaluation/protocol output, controller state,
real TUI startup wiring and real CLI defaults-disabled probes.

Initial fail-first runs also demonstrated the old behavior: implicit restore did
not throw; CI rejected expanded preference; absent recommended profile was
accepted; evaluation rejected `toolSummaries:true`; TUI initialized false;
retention kept turns 1–5 instead of 4–5; diagnostic argv kept literal `{path}`.
The committed mutant runner reproduces these failures against final source.
One first attempt selected only sandbox-explicit tests and survived; changing
the selector to the actual implicit-omission tests killed the mutant. This was
not counted as proof. Fixture-authoring failures (wrong helper names, a missing
import, wrong fake-ingest discriminator and an incorrect one-call assumption)
were corrected; they are not claimed as behavioral fail-first evidence.

## Measurements and explicit limitations

The E1 reference traces retain baseline prompts/turns: A1 2/4, A2 2/4, A3 3/5,
A4 2/5, X1 2/4, X2 2/4, X3 2/4, X4 2/4. A1–A3 and X1–X3 pass evaluator
checks. A4/X4 behavior checks pass; prose remains human-review BLOCKED, not a
fabricated capability pass. These are deterministic reference solutions, not
model competence. Default diagnostic readiness selects no root checker on
these monorepo/JS tasks, so it adds no exec requests there. The independent
single-root TypeScript PTY edit has one new diagnostic exec approval request
(declined), two main responses and one completed auxiliary ingest request.
Its three total provider requests report synthetic usage only.

Ingestion adds **six completion calls per A task** and **one per X task**, versus
no session-end ingest in the SDK baseline. These fake responses report 10 input
and 2 output tokens per call: 60/12 per A task and 10/2 per X task; price is
**unknown**, not zero. A real provider can cost more. We do not claim measured
cost savings. Users can explicitly set `ingestOnEnd:false` in trusted user config
without creating a profile or increasing project trust. `diagnostics:[]` remains
the explicit checker opt-out. No new default permission grant was added.

The PTY captures show the known **#235** checkpoint ownership limitation when
session-end memory changes repo-local files: creation is visible, but sealing
refuses after non-session changes. This repair does not claim successful undo
for that path. It preserves unsealed refs instead of pruning potentially useful
recovery data. The retained-target undo test isolates the ownership-valid case.
This is disclosure of an existing tracked limitation, not an issue-only closure
of any of findings 1–13.

## Reproduction

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
TMPDIR=/var/tmp pnpm test
TMPDIR=/var/tmp pnpm --filter @agentkitai/agentrig-cli exec vitest run --root ../.. packages/cli/test/recommended-runtime.test.ts
TMPDIR=/var/tmp python3 .agentrig/r17/terminal-baseline.py
TMPDIR=/var/tmp python3 .agentrig/r17/recommended-smoke.py
TMPDIR=/var/tmp python3 .agentrig/r17/recommended-smoke.py --expanded
TMPDIR=/var/tmp node .agentrig/r17/recommended-e1.mjs
TMPDIR=/var/tmp python3 .agentrig/r17/repair-mutations.py
```

`/var/tmp` avoids the machine's pre-existing `/tmp/.agentrig` contamination
already recorded by independent review (#239); it is not a production change.
All scripts use local credential-free fake HTTP, not live model credentials.
The E1 script installs the existing pinned A task dependencies offline; it does
not mutate the current checkout. Linux PTY metrics do not assert macOS/Windows
performance. CI is checked on the actual pushed head separately in the PR.


## Local verification receipt

After merging moved `origin/main` (`7841b88`) without rebasing, `pnpm build`,
`TMPDIR=/var/tmp pnpm test` and `pnpm typecheck` each exited 0: 212 files,
3,366 passed / 4 skipped. The CLI-workspace command above exited 0 (1 test).
The first workspace attempt omitted `--root ../..` and exited 1 with “No test
files found”; the repository-relative Vitest include glob, not the CLI binary
path, caused that invocation failure. The successful command is recorded above.
E1 replay exited 0 after correcting its fixture-only auxiliary-call discriminator
and allowing the existing chunked ingest to make more than one call. All 18
mutants exited 1 with the expected assertion failure; restored sources passed.
The merged main commit supplies its own unrelated PTY/maintenance repairs; they
are not attributed to R17b and were not rebuilt as new train work.

Available canonical usage is retained as per-response seq/usage-only snapshots
in `R17b-repair-accounting.json`, separate from fake acceptance-fixture usage.
Recompute each total by summing `responses[].usage` by field. The first three
child sessions are terminal; repair/conductor snapshots are partial, not final
or billable totals. No transcript or credentials are exported. Exact-head hosted
CI and final SHA are in the PR receipt; the local receipt is not substituted for CI.

The post-default E1 extractor uses actual `tool.result` / `ok:false` events, not
the historical baseline script's nonexistent `tool.end` discriminator. Rechecking
all eight retained replay logs found zero failed tool results (3 successful tool
results per task, except 4 for A3/A4); the new runner also fails on any such error.
The original baseline script/history is intentionally not rewritten. The separate
workspace-runner friction is feel #245 (session 12b8dd75, call 1055 / result 1080).
