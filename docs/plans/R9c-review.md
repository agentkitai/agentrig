# Independent review receipt

Snapshot: `de678e2b5dec4e92d41ec7ba3a68d89cf92e7694`.
Session: `bcc5b478-d055-4d31-b5f0-a7542107c2d1`.
One process, no restart; requested `--max-turns 24`, CLI reported **27 turns**
over **351.175 seconds**. The reported count exceeded the requested cap.
Tracked files remained unchanged during review. No second review was performed.
The reviewer wrote its report outside the repository; the complete report follows
verbatim. Independent checks do not include build or a full-suite run.

---

# R9c independent read-only review — snapshot de678e2b5dec4e92d41ec7ba3a68d89cf92e7694

## Verdict: APPROVE

No material findings. Optional polish listed separately. Code treated as frozen; no edits, no build, no image pulls.

## Independent checks actually run (this worktree, HEAD de678e2)

| Check | Result |
|---|---|
| `pnpm typecheck` | all four packages pass |
| `vitest run nightly-structure.test.ts session-evaluation.test.ts --maxWorkers=4` | 2 files, 33/33 pass, container-conditional cases included (env images present, 0 skipped) |
| `vitest run evalset evaluation verification-lanes injection-fixtures --maxWorkers=4` (the nightly job's structural step) | 4 files, 52/52 pass |
| `node eval/nightly.mjs /tmp/... <worker> <checker>` with OPENAI_API_KEY/ANTHROPIC_API_KEY/OPENAI_BASE_URL/AGENTRIG_EVAL_* unset | exit 0, status PASS, observed PASS/FAIL/BLOCKED, evaluatorRevision = de678e2, 52 files / 85,111 bytes, missing [] |
| Artifact inspection | no symlinks, no workspace directories (only 3 `*-workspace.receipt.json`), no `/home/amit` paths, no API key strings; every protocol/summary/report/baseline manifest labelled `scripted`; X4 checks = BLOCKED/PENDING/PASS/PASS/PASS; broken X1 = FAIL with behavior+regression FAIL and submittedTests PASS |
| SIGTERM to real CLI mid-run (during `broken` case, after `correct` PASS) | exit 1 within 313 ms of signal; terminal summary status FAIL, cancelled true, observed [PASS,null,null], 13 missing selections; no container left by this run |
| vitest `--reporter=default --reporter=json --outputFile` (workflow flags) | JSON written, parses |
| Workflow prerequisites | `packageManager` pinned in package.json (pnpm/action-setup@v4 without version OK, same as ci.yml); Dockerfile has `worker` and `checker` targets |
| R7c metadata compatibility | `ingestOnEndExplicit` is resolver metadata only (config.ts:359); validateEvaluationProfile skips the key, `ingestOnEnd:false` skipped as false, `ingestOnEnd:true` rejected; forged file key rejected by strict parse — covered by the new session-evaluation test, which passed here |

## Semantics verified by reading the diff

- Gates: `assertNightlyOutcome` cross-checks eval.result, E2 report and raw checks (task, outcome, lane, usageComplete, unknownCalls=0, not cancelled); human-pending additionally requires manual PENDING with behavior/regression/scope PASS. Missing selection, artifact overflow or cancellation force FAIL in `finally`.
- Lane: `evidenceLane` is a `SessionEvaluationDependencies` field only; `program.ts` never sets it; `runEvaluationAttempt` defaults to `live`; ordinary eval test asserts `live`.
- Artifacts: fixed selection list; regex-limited names; ancestor lstat link refusal; O_NOFOLLOW open; dev/ino/size/mtime recheck; nlink>1 refused; `wx` writes; destination-link refusal; caps 2000/8/8MiB/64MiB.
- Cancellation: single AbortController shared by SIGINT/SIGTERM, 10-min timer and caller signal; every transport/evaluate call awaited; summary published in `finally` after they settle; dockerRun (R9b/E3) force-removes its own UUID container in `finally`.
- Workflow: contents:read, no secrets, 30-min ceiling, non-cancelling per-ref concurrency; structural step has no continue-on-error so its failure fails the job while later steps use `!cancelled()` conditions to still run; retain step exits 1 on missing report; upload `if: always()` with `if-no-files-found: error`.
- Coverage: evalset.test.ts exercises A1/A2 seeded regressions, A3 extraction identities, X2/X3, plus X1/X4 via nightly; injection-fixtures.test.ts is the R13e suite; both run in a separate step from the container controls.

## Optional polish (not blocking)

1. `eval/nightly.mjs`: the on-disk RUNNING summary is written only at start and after each case, so its `phase` lags one case behind (during `broken` the file still says `correct: evaluation`). Saving on each phase transition would make a hard-killed run's partial summary accurate. Terminal summary is correct.
2. `assertNightlyOutcome` for `broken` requires outcome FAIL only; asserting `checks.regression === 'FAIL'` would pin the intended failure reason.
3. Stray local container `agentrig-e3-b73d…` (Created 10:20 today, cmd `sleep 60`) predates this review and matches `live-evaluation-docker.test.ts`; not caused by R9c or by this review's cancel run. Left untouched.

## Scope limits

- Linux/WSL2 only; Windows/macOS behaviour of `nightly-structure.test.ts` (junction symlink, nlink, mtime rechecks) not verified here — exact-head CI must confirm.
- GitHub workflow not executed; YAML semantics verified by reading and by local reproduction of its commands.
- Did not run `pnpm build` (dist at 19:47 today, no src newer; author-built) or the full suite.
- Cancel test hit the `broken` evaluation phase, not a baseline/worker container phase; container-join during an in-flight `docker run` relies on R9b's dockerRun `finally` (read, not re-exercised).

