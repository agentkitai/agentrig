# Independent child abort-hook fixture review

One Claude invocation reviewed frozen `564d0a2d2067ef61a6af0576134fe9c8f4bd7403`
against `59c21c7a7185df5e32293d0d92b9cb94337a56ad`.
Session: `8003de06-27a0-4ea6-89ef-cada09a46981`.
Requested 16 turns; reported 11. Duration 150.854 seconds. Reported list-cost
USD 1.391233 is not a statement of subscription billing. No permission denials
or subagents. Original final result follows verbatim.

**Verdict: APPROVE.** The repair is a fixture-only change that makes the timing deterministic without touching production deadlines, and every original assertion survives with one added.

**What I verified**

- **Scope is as described.** The diff at 564d0a2 against 59c21c7 touches only the subagent test, the new plan doc, ROADMAP and STATUS. No file under any `src/` changed.
- **The phase detection is sound.** In the abort path the only timers with delays of 200 and 400 are the two orphan-grace timers in session-lifecycle, and the cut timer in the subagent tool is armed at 300. All three are armed at fake time zero, so advancing 200 then 100 lands exactly on child-orphan expiry and then the cut, regardless of how long real I/O takes in between. No other core timer in that path uses those delays.
- **Assertions are preserved, not weakened.** The hook must be running before the cut and cut after it, the child log must carry the 200 ms orphan error, the parent must carry none, and the parent must end aborted. The new check that the child log ends with session.end is stronger than before. The fixed 200/300/400 bounds are unchanged.
- **The mutant still fails, by construction.** With the cut armed at 200, it fires inside the first advance before the child reaches its end hook, and the hook runner skips a point whose signal is already aborted. The fixture then hits the "child ended before its end hook entered" race. I did not execute the mutant because that needs a source edit, which was out of bounds.
- **Cleanup is complete.** The stubborn tool is released, the session is aborted, the parent grace is advanced, done/events/tool-return are joined under a real watchdog, and the spy is restored before real timers, which is the correct order.

**Commands I ran and results**

```
pnpm exec vitest run packages/core/test/subagent.test.ts -t "ignores the abort keeps its session_end hooks"   # x3: 2 passed each, ~350ms
pnpm exec vitest run packages/core/test/subagent.test.ts                                                       # 43 passed, 4.48s
cd packages/core && pnpm exec tsc --noEmit -p .                                                                # exit 0
```

**Limitations**

- I did not run the full suite, build, or Docker run. I rely on the author's reported full-suite result for that.
- The CI run IDs cited in the docs could not be verified because network was out of scope.
- The core tsconfig includes only `src`, so test files are not typechecked by the typecheck script. That is pre-existing and not introduced here.

**Optional polish, non-blocking**

- Resolving the phase gates on any 200 ms or 400 ms timer is correct today but silent if a future timer with the same delay enters the abort path. A one-line comment naming the two lifecycle timers would make that assumption visible.
