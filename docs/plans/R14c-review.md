# R14c independent review — original receipt

Session `24f6be90-8c4a-480d-8032-b0df40f0d362`; one bounded CLI invocation, 191 seconds.
The requested ceiling was 16 turns; the receipt reported 32 turns. No second general review.
The original finding and verdict are preserved below before any fix interpretation.

**Verdict: REQUEST_CHANGES** for R14c on `feat/r14c-evidence-grading` (head b33642d vs origin/main cee1ad9).

The core design holds: the report is bounded, gaps can only lower a verdict, dropped/unfinished/legacy/malformed states behave as the plan says, attach folds the full stream, and the CLI path is read-only over the physical log. One material runtime regression on the resume path must be fixed before merge.

**Required fix**

1. **[HIGH] Every grade in a resumed supervised session is forced to fail.** `packages/supervisor/src/evidence-report.ts:24-30` starts the collector at `previousSeq = -1` and marks `invalidOrder` when the first event's seq is not 0. A resumed session's stream begins with `session.resume` at a continued seq (`packages/core/src/agent.ts:437` appends through `store.append`, and `packages/core/test/agent.test.ts:1662,1672` prove the resumed stream's first event is `session.resume` at seq equal to the prior event count). So the attach collector at `packages/supervisor/src/supervisor.ts:129,211` is permanently `invalidOrder`, the report is permanently `incomplete`, and in `packages/supervisor/src/grader.ts:112,133` `claims` becomes true and `evidenceGaps` is non-empty, which forces `pass: false` with "invalid ordering true" on every `run_grader`, including no-declaration sessions the plan says keep legacy behavior. The CLI wires this path today: `packages/cli/src/run.ts:410-419` resumes and attaches the supervisor, and line 302 supplies the RubricGrader under `--supervisor-review`. Fork children hit the same (child stream starts at seq 1 after the `session.fork` marker). No test exercises attach on a resumed session, so this was not caught. Fix: treat a first observed `session.start` or `session.resume` as the anchor (seed `previousSeq = event.seq - 1` when the collector is empty and the event is a session boundary), which keeps the direct-trajectory prefix test at `evidence-grading.test.ts:132-138` valid since that partial starts at `plan.updated`. Add a real resumed-session-under-attach fixture asserting a legacy plan still passes and a declared mismatch fails with the specific deficit, not only the ordering gap.

**Optional polish** (not blocking)

- `supervisor.ts:210-211`: if `reduce` throws, `evidence.observe` is skipped, the seq gap sets `invalidOrder`, and all later grades in that session are forced to fail. Observing before reducing, or in its own try, keeps a single fold error from poisoning grading.
- After a resume, declarations made before the resume are not in the resumed stream, so the fold treats the session as undeclared and grades as legacy. That is a documented-adjacent limitation worth a sentence in `docs/plans/R14c.md`.
- `sessions show --evidence` on a fork child prints "(no current plan declarations observed…)" with no hint that ancestors were not read. A one-line note would avoid misreading.

**Verified as correct**

- Index alignment of `statuses` with `ledger.items` (both from `items.slice(0,100)`); omitted rows still contribute gaps before the row is dropped; gap cap is 32 plus one omission line; report text stays under 12,000 chars; raw stdout and task text never enter the report.
- Attach path for fresh runs is fully ordered: the lifecycle `EventStream` replays from seq 0 to late subscribers (`packages/core/src/session-lifecycle.ts:17-47`).
- `GradeInput.evidence` is only produced in-process by attach, frozen, and never derived from model output. Direct graders fold their own trajectory.
- CLI: `store.read` throws on parse or seq gap, the collector rejects unfinished or mixed-identity logs, no config or provider is loaded, and the log bytes are unchanged.

**Tests run**

```
pnpm exec vitest run packages/supervisor/test/evidence-grading.test.ts packages/cli/test/evidence-report.test.ts
Test Files  2 passed (2)   Tests  12 passed (12)   Duration 1.10s
```

No mutants were re-run here (read-only review). The two reported mutants were not re-verified.
