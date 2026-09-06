# R14d — original independent review

One bounded Claude review of `5b28d3b`; session `32234c12-c129-4a1e-9528-380d27a4d4d4`,
144.8 seconds, 19 reported turns despite a requested 16-turn cap. Read-only, no delegation;
42 focused tests and package typecheck independently passed. Original verdict/finding below,
verbatim. The material finding is addressed in the row, not accepted as a limitation.

Tests and typecheck are green. I have what I need and am writing up the verdict.

**Verdict: REQUEST_CHANGES** (one material finding; the rest are optional followups).

Verified: the three focused test files pass (42 tests) and `pnpm typecheck` is clean across all four packages. The E1 checker to stored E2 report to attached M6 path works as the plan describes for X2, failure beats block in both reducers, SKIP requires a pre-run exclusion with no observed attempt, legacy reports without the field keep their JSON outcome and print an explicit unverified line, provenance text says evaluator-attested rather than authenticated, the loader runs inside the existing auxiliary timer and abort signal (timer starts at `packages/supervisor/src/supervisor.ts:159` before the loader is awaited at line 334), and the grader only adds gaps, never a pass.

## Material finding

1. **A4/X4 can no longer reach PASS in E2 even with a signed human PASS verdict.** `eval/check.mjs:78-92` runs the behavior worker for A4/X4 and it passes, so `eval/check.mjs:186-199` sets the behavior lane to PASS/complete but leaves `negativeProbe` undefined (the probes map has no A4/X4 entry). The reduction at `packages/supervisor/src/verification-lanes.ts:45-46` then turns behavior into BLOCKED. In `packages/cli/src/evaluation.ts:221` the human verdict correctly promotes the outcome to PASS, but line 228 immediately demotes it to BLOCKED because the lane verdict is not PASS. The existing human-gate test at `packages/cli/test/evaluation.test.ts:133-137` only covers a legacy checks object without `verification`, so the real checker output is untested on this path. Result: with the shipped checker, the human-review gate for both prose tasks is dead and the plan's "E2 additionally enforces its existing ... human gates" no longer holds. Smallest fix: in `evaluation.ts` after line 228, when `checks.manual === "PENDING"` and `m.humanVerdict?.outcome === "PASS"`, let a behavior lane that is BLOCKED only for a missing negative probe/observation defer to the human verdict (regression lane and any FAIL still bind); alternatively have `check.mjs` emit the A4/X4 behavior lane with `verdict: "BLOCKED"` and an explicit observation saying prose semantics are human-assessed, and make E2 treat that specific case as human-gated. Add a test that runs the real checker (or a fixture with its A4 output) plus a human PASS and expects PASS.

## Optional followups

- **A4/X4 lane labeling** at `eval/check.mjs:153,190` says basis `surface` and "Actual A4 task surface completed evaluator-owned assertions" for what is a structural prose/citation check. The reduction blocks it anyway, but the recorded observation overstates what was observed.
- **Legacy grader prompt wording.** `packages/supervisor/src/grader.ts:113` calls `assessVerificationLanes(undefined)` for callers that never supply verification, so every legacy M6 prompt now contains "Verification lanes: BLOCKED — absent/invalid evaluator evidence". No gap is forced, but the word BLOCKED is model-visible and may bias grades on callers who never opted in. A distinct "not supplied by host" text would preserve the visible-unverified intent without implying a failed check.
- **Invalid loader output yields no grade rather than a blocked one.** `packages/supervisor/src/supervisor.ts:334` parses inside `runAuxiliary`; a zod failure propagates to the catch at line 360, records an error and skips the grade and the steer. The plan says invalid grading input is "a bounded unverified block". Passing the raw value through and letting the grader's own `safeParse` at `verification-lanes.ts:26` block it would match the plan and still keep the bound.
- **Duplicate payload in the report.** `packages/cli/src/evaluation.ts:233-235` writes the raw `verification` object inside `independentChecks` and the reduced `verification` beside it. Harmless, but readers get two sources of truth for the same lanes.
