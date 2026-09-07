# Bounded runtime-fixture CI repair

Repair only the two concrete existing fixture failures; no new product milestone.
Branch from updated main `339f79586f37d027edd6939f39c2ac8fc6e78fd8` because its
post-merge Windows gate is failed, not to bypass the green-main feature gate.
Feature merges pause until this repair passes exact-head and repaired-main checks.

## Original failures

- R16a #199 exact head passed all four checks. Post-main CI34075972025 failed
  `packages/cli/test/generated-skills-runtime.test.ts:48` after 5,009 ms in the
  emitted-skill runtime test; the other 15 tests in that group passed. The fixture
  performs real dream/emission and six actual CLI-built runtime modes under one
  default five-second outer timeout. Linux/macOS/structure passed.
- R15j #205 repaired head `0a198b9` passed Linux/macOS/structure but Windows
  CI34075890518 timed out the existing actual passing/failing evidence-grading
  test under its default five-second outer bound. It runs two real sessions with
  four real Node checks total; premature cleanup also encountered EBUSY while a
  child remained active. Provider-selection tests were not the failure.

The logs establish outer timeout failures, not which exact remote stage was slow.
No claim attributes either failure to Markdown/provider-selection production code.

## Contract and controls before edits

Keep every original opt-in/refusal/provenance/raw-log and evidence/exit-mismatch
assertion, real runtime/builder/CLI/dream and actual subprocess execution. Add
bounded controlled startup/provider or child scheduling delays to reproduce the
old outer timeout, then give only these multi-stage fixtures an explicit 30-second
outer bound. No production deadline, budget, policy, skip or retry changes.
Owned sessions must be aborted/joined before temporary cleanup on failure. Baseline
and controlled delayed variants must both pass after correction. No live provider.

One bounded Claude review, original verdict/actual turns retained and material
findings addressed. Build/typecheck, full required digest-pinned Docker and actual
Chromium, then all four exact-head and repaired-main gates. Original failed runs
remain failed. Roadmap/status track this bounded gate repair without nested rows.

## Evidence

The generated-skill fixture's six controlled 900ms provider delays failed at
5,003ms under the original bound (baseline passed). The evidence fixture's four
1,400ms real child delays failed at5,006ms (baseline passed). These reproduce the
outer-bound failure class, not the unknown precise remote slow stage.

Only these two fixtures now allow30s. The CLI fixture uses Vitest's test signal,
passes cancellation into dream/builder, aborts/joins each owned runtime and joins
the fixture before the next test; the evidence fixture aborts/joins owned sessions
before removing roots. Original semantic assertions remain, with successful
session completion asserted additionally. Initial cleanup implementation used
`it.each` with a context argument; focused tests caught its unsupported callback
shape. Corrected to `it.for`; no product edits or assertion removal.

Build/typecheck pass. Focused CLI skill/evidence and supervisor evidence suites:
18passed /3files,8.40s. Actual Chromium:1passed,2.80s. Full required-Docker
verification and one bounded Claude review pending; no passing delivery claimed.
