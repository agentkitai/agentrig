# A1/A2 real-copy fixture scheduling bound

## Evidence and scope

R7a PR #176 passed exact-head Linux/macOS/Windows CI `34038810158`, then merged
as main `bf65aec6459535478c8a3e6ff92e4120218847fb`. Post-merge CI `34039249249`
passed Linux/macOS but failed Windows at `evalset.test.ts:78`: **A1 passes real
built code and detects its seeded regression**, `Test timed out in 5000ms`,
reported duration 6,261 ms. The other fourteen cases passed. No assertion failure
was reported; no blind rerun was performed. R7a remains merged but its main gate
is not falsely reported green.

This unchanged parameterized A1/A2 fixture starts a real baseline worker, copies
the built memory tree and the Zod dependency, mutates the copied compiled source,
and starts a negative worker. Both worker calls already have 30-second limits.
The five-second outer default is a fixture scheduling limit, not a product
performance guarantee. The same file already has an explicit 30-second allowance
for the real-process X1 integration fixture.

The repair changes only this A1/A2 test declaration to an explicit 30 seconds,
with an explanatory comment. Every positive, exact seeded replacement, negative
assertion and 30-second subprocess guard remains unchanged. No global timeout,
skip, product code, evaluation verdict, or other E1 test changes. This is a
separate bounded repair PR from the red main, not another roadmap submilestone.
No claim is made that remote resource contention was proved.

## Controlled discrimination

A temporary 5,500-ms asynchronous delay after A1's real positive/negative
assertions failed with the original five-second outer bound
(`/tmp/evalset-bound-before.log`, exit 1), then passed with the explicit 30-second
bound (`/tmp/evalset-bound-after.log`, exit 0). The artificial delay was removed;
it is not shipped and does not relax any checker assertions. This control
establishes the scheduling-limit distinction, not the cause of remote slowness.

Focused/full checks, one bounded independent review, exact-head three-platform CI
and the repaired-main post-merge gate remain pending. Root coordinates merge;
heartbeat work stays paused until main is green.
