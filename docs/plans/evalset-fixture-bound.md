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

Build/typecheck and all 15 focused evaluation tests pass. Full suite passes
2,597 plus two skips across 149 files, four workers, 39 seconds. One bounded
Claude review approved: session `8118c1ea-3de6-43ae-8109-5316de4280a6`, 48,940 ms,
nine reported turns of requested twelve, no error. It independently ran 15 focused
tests and typecheck; its fetch attempt was denied, so its base was cached origin/main.
Final remote refresh, exact-head three-platform CI and the repaired-main post-merge
gate remain required. Root coordinates merge; heartbeat stays paused until green.

## Original independent review (verbatim)

**Verdict: APPROVE.**

The diff against origin/main is one commit touching four files. The only code change is the A1/A2 test declaration in `packages/cli/test/evalset.test.ts:96`, which adds an explicit 30-second per-test timeout and a two-line explanatory comment. Everything else in the diff is documentation.

**Scope verification against the plan contract**

- Test body unchanged. The positive real-build assertion, the exact single-occurrence seeded replacement check, the mutated-copy negative assertion, and both worker calls are byte-identical to origin/main. Only the closing `});` became `}, 30_000);` plus the comment.
- Worker guards unchanged. The shared worker helper at line 19 still passes a 30-second subprocess timeout, and every other spawnSync in the file keeps its existing bound.
- No global timeout change, no skip, no production or source edit. The diff touches no `vitest.config`, no `packages/*/src`, and no eval checker.
- Precedent matches. The X1 fixture at line 187 and the signal fixture at line 219 already use the same explicit 30-second declaration with the same rationale style, so this is consistent with the file's existing convention.
- Docs are internally consistent. The plan, STATUS entry, and ROADMAP row all describe the same failing run, the same duration, and the same test-only scope.

**Non-material observations, no change requested**

- The comment at line 95 reads `CI34039249249` without a space before the run ID. Cosmetic only.
- STATUS says "R7b remains paused" while the plan says "heartbeat work stays paused". Both are consistent with the intent that nothing proceeds until the repaired main gate is green.

**Commands executed**

```
git log --oneline origin/main..HEAD
git diff --stat origin/main..HEAD
git diff origin/main..HEAD
git status --short
pnpm exec vitest run packages/cli/test/evalset.test.ts --maxWorkers=4
pnpm typecheck
```

Focused vitest result: 1 file, 15 tests passed, 7.98s total. Typecheck: all four packages clean. Working tree clean.

**Command denied**

`git fetch -q origin main` was denied by the permission policy. The review therefore diffed against the locally cached `origin/main` ref. If that ref is stale relative to the remote, the branch should still be rebased and re-gated by exact-head CI before merge, as the plan already requires.

No subagents, network calls, live-provider calls, commits, or PR actions were performed.
