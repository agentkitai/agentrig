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
