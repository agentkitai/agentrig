# R17d — measurement-contract deviation requested

Builder: **agentrig**, conductor **a4decdf9**. Not an implementation or completion receipt.
Base: origin/main `e74018c707a5715ef20ec5686210a092b8d909ab`.

## Frozen acceptance

> R17d — prompts per E1 task fall from the recorded
> baseline, and every R13e fixture still asserts its non-behaviour.

No new capability; consent cannot widen. No permission settings changed.

## Reproduced blocker

`node .agentrig/r17/task-baseline.mjs` exited 0 after `pnpm build`.
All eight tasks completed and their correctness checks exited 0. A1/A2/A3/A4/
X1/X2/X3/X4 prompts were **2/2/3/2/2/2/2/2**, matching the recorded reference.
[Extracted event evidence](R17d-baseline.json) retains session IDs, request sequence
numbers, input digests, paths and decision attribution. Original local run:
`/tmp/r17-e1-kL4TNF/results.json`, sessions beneath that directory's `sessions/`.

The trace generator `.agentrig/r17/task-baseline.mjs` invokes one trusted-root
`read_file` and then writes each `scriptedFiles` entry once. It executes verification
checks in the measuring process, not as agent bash calls. Every prompt is therefore
a distinct `write_file` request to a distinct path. There are zero bash requests
and zero repeated identical permission requests. Existing `defaultRules` already
auto-allow the read (core `permissions.ts`, read/cwdOnly rule).

Thus neither the proposed bash default key nor identical-ask collapse can reduce
these particular traces. Lowering them would require a different measurement or
consent covering distinct writes, which is not authorized here. This is a narrow
measurement blocker, not a claim that the product UX work itself is impossible.
No fail-first behavior tests were written because no behavior change was attempted.

## Exact proposal for the parent's arbiter

Approve **a supplemental paired E1 permission-friction workload as the reduction
acceptance**, rather than requiring the frozen one-read/unique-writes R17 baseline
to decrease. Preserve that original baseline and rerun it unchanged as a
non-regression control (2/2/3/2/2/2/2/2 is an acceptable unchanged result).
Before implementation, freeze and record the supplemental per-task traces and
operator response policy on this base: include task-relevant verification through
agent bash calls and repeated identical requests, and replay those exact same
traces and response policy after implementation. Explicitly label this a new
baseline, not the historical E1 baseline. Target at least one fewer actual user
prompt per supplemental task, with zero new authority. Keep the original row's
three product requirements and every R13e non-behaviour assertion unchanged.

This proposal is **not approved** and no supplemental traces or product changes
have been implemented. If rejected, retain this evidence and request an alternative
measurement interpretation from the human; do not silently broaden write consent.

## Verification and accounting

Separate commands on the unchanged runtime base:

- `pnpm install --frozen-lockfile`: exit 0.
- `pnpm build`: exit 0.
- `pnpm test`: exit 0; 220 files, 3440 passed, 4 skipped.
- `pnpm typecheck`: exit 0.
- `pnpm exec vitest run packages/core/test/injection-fixtures.test.ts`: exit 0,
  all six R13e fixtures passed. No modified product behavior to validate yet.
- E1 baseline: exit 0, eight correctness checks exit 0, counts above.

No live provider/E3 matrix calls, no nested children, no external reviews,
no merges, no CI retry. One builder halt: measurement-contract arbitration.
Builder terminal token totals and child/session accounting are unavailable to this
child and must be captured by the parent; no estimates substituted. Legitimate
scoped decisions were not filed as feel bugs. No novel runtime friction observed.
ROADMAP R17d remains incomplete intentionally. This is pushed continuation evidence,
not a bookkeeping merge proposal; resume the implementation PR only after arbitration.
