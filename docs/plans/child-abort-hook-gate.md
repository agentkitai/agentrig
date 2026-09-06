# Child abort-hook regression gate repair

Started from main `59c21c7` after R15a #188 post-main CI `34054434385`
failed macOS: `core/test/subagent.test.ts` expected hook outcome `cut`, got
`not run`. Linux and scripted structure passed; Windows was still running.
The original failure remains failed. No blind rerun or next feature merge.

## Contract before changes

Repair only the discriminating lifecycle fixture if controlled reproduction
confirms its wall-clock assumption. The actual child abort is already triggered
inside its stubborn tool. Child orphan grace is 200 ms, automatic end-hook cut
300 ms, parent grace 400 ms. Orphan-error append and snapshot writes occur before
the end hook; real I/O can consume the 100 ms gap. Already-aborted end hooks are
intentionally skipped. Production grace and cancellation semantics stay unchanged.

First reproduce with controlled slow child snapshot persistence. Then coordinate
real child/tool/storage/hook entry with bounded test gates and a controlled timer
clock, preserving hook-cut, child-orphan and no-parent-orphan assertions. Release
and join all test-owned work. A removed/deliberately early cut must still fail.
No timeout increase, assertion removal or runtime rewrite to satisfy the fixture.

One bounded Claude review; build/typecheck/full actual-Docker tests; own repair PR
and all four exact-head/post-main checks. Roadmap/status identify this gate repair
and do not claim R15a complete until repaired main is green. Small polish stays last.

## Author evidence

Adding a controlled 150 ms child snapshot delay to the original fixture reproduced
the exact `not run` versus `cut` failure (435 ms). The repaired fixture uses real
storage at both zero and 150 ms delays, while controlling only timeout progression:
wait for actual child/parent orphan timers, advance 200 ms, await real hook entry,
then advance 100 ms to the real subagent cut. Both variants pass; all 43 subagent
tests pass, as do ordered build/typecheck. Every wait has a real two-second watchdog;
test cleanup releases the stubborn tool, aborts and joins owned work, and restores
timer state. Production code is unchanged.

The early-cut-at-child-grace mutation fails both variants: immediate terminal-before-
hook error without storage delay, bounded missing-hook watchdog with delayed storage.
The mutation was restored. Full validation and one independent review follow.

## Frozen-head validation and review

On `564d0a2`, ordered install/build/typecheck and the full actual-Docker suite
passed: 2,823 tests, two existing skips, 171 files, 53.38 seconds, four workers.
Worker image: `sha256:f111ef59dce766519eb2ac455b554b01793aff0e9cd1d68d29b6d314d7db52e9`.
Checker image: `sha256:33443f68f312abe4f1e88e16be7c88407d7173e80d7e55dfb0a12a5541e733e5`.

One independent Claude review approved the frozen change, with no material
findings. Requested 16 turns, reported 11; 150.854 seconds. It independently
ran both variants three times, all 43 subagent tests, and core typecheck;
it did not independently run the full build/Docker suite or the mutant.
The original result and limitations are preserved in
[child-abort-hook-gate-review.md](child-abort-hook-gate-review.md).
The optional timer-assumption comment is recorded at the end of the roadmap.
No second review and no production changes.

The original main run completed with Linux and Windows green, macOS failed;
scripted structure was green. Its failure receipt is on PR #188:
https://github.com/agentkitai/agentrig/pull/188#issuecomment-5561616415.
The repair still requires all four exact PR-head checks and all four post-main
checks before roadmap integrations resume; those receipts belong on the PR.
