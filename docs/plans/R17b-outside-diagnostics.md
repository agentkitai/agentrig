# R17b: human-approved bounded coverage metadata repair

Builder **Codex, outside the AgentRig train**; halted conductor **2aa2f739**,
feel **#254**, existing PR **#234**. This is operator-directed repair, not a
fourth train round, new arbiter, reset of the three-round cap, or new row/PR.

## Explicit contract amendment

The operator asked:

> May I give coverage metadata a separate bounded allowance, preserving the 64 KiB diagnostic-text cap and all safety checks? This changes the existing combined-output contract, so I need your explicit approval before implementing it.

The human replied verbatim:

> ok... resolve it and continue. do not stop all the time for nonsense.

Approval is retained in [feel #254](https://github.com/agentkitai/agentrig/issues/254#issuecomment-5579119985)
and [PR #234](https://github.com/agentkitai/agentrig/pull/234#issuecomment-5579120217).
It explicitly amends R15b's combined-output contract only for compiler coverage
metadata. The previous authorization, sole sandbox deviation, #248 resolution,
failed reviews and halt remain history. The 12,000,000-token E3-only budget is unchanged.

## Bounded implementation

The exact approved `tsc --noEmit --pretty false --listFiles` invocation still goes
through ordinary exec consent, sandbox wrapping and changed-command guards. No
compiler installation, new executable, checker registration or provider call is added.
Only the trusted internal tsc/listFiles path uses the new sink; other checkers and
custom tsc arrays without listFiles keep their capture semantics.

- Diagnostic text retains the configured 4096–262144-byte cap, default 65536.
- Stdout absolute file-list lines, excluding diagnostic lines, receive **4 MiB**
  total metadata allowance, including line endings. This finite allowance is well
  above the CLI's roughly 100 KiB listing, without permitting unbounded output.
- Each stdout/stderr line or pending partial line is limited to **8192 bytes**.
  Separate fatal UTF-8 decoders preserve split code points and stream boundaries.
- Metadata is retained in one lazily allocated fixed-size buffer. At process close,
  paths are checked sequentially, without an unbounded array or async work queue.
  Once canonical coverage is witnessed, remaining paths are still checked for
  existence/access; unknown paths cannot disappear after a valid witness (#258).
- The existing timeout covers final sink work; cancellation is checked around
  each filesystem operation, and completion joins that work. Individual filesystem
  operations cannot themselves be interrupted while awaiting the OS. The existing
  200ms inherited-pipe grace is unchanged; forced pipe loss explicitly fails closed.
- Metadata/diagnostic/line overflow, invalid UTF-8, unterminated metadata, unknown
  paths/output, unexplained nonzero exit, missing coverage, changed bytes/argv,
  denied exec, timeout and abort cannot become a completed clean report.

## Reproduction and regression evidence

The old implementation failed all three new actual TypeScript 5.9.3 large-program
controls (broken, clean, excluded): `/tmp/R17b-outside-large-before.txt`, exit 1.
Each fixture has 750 source files and proves the actual listing exceeds 65536 bytes
before asserting runtime behavior. The repaired controls report TS2322 for broken,
no diagnostics (not proof of correctness) for clean, and incomplete for excluded.
The focused sink/runtime/background suite passed 78 tests before final freezing.

[The committed default-path smoke](R17b-outside-diagnostics-smoke.mjs) additionally
loads the actual default configuration and invokes bare `tsc` from PATH through
the built runtime, with an owned fixture and fake provider. Run after `pnpm build`:

```sh
pnpm exec node docs/plans/R17b-outside-diagnostics-smoke.mjs
```

Its JSON records the Git head, source cleanliness, actual compiler version/listing
size, literal argv, diagnostic cap, report and provider call count. The initial
dirty-candidate proof measured 138303 listing bytes and correctly reported TS2322;
it is not an exact clean-head receipt. Final clean-head gates and smoke are posted
to the PR, not inferred from that candidate. Explicit fixture write/exec consent
is not a claim that security defaults automatically grant permission. This PATH
smoke is local POSIX evidence; the portable real-compiler tests also enter Windows CI.

Nine individually applied mutations were killed (actual exit 1) and restored:
metadata cap, diagnostic cap, post-witness unknown-path validation, fatal UTF-8,
split-chunk decoding, line cap, inherited-pipe loss, coverage gate and abort checks.
Artifacts: `/tmp/R17b-mutant-{metadata,diagnostics,unknown-after-witness,utf8,chunk-decoding,line-cap,pipe-loss,coverage-confirmed,abort}.txt`.
An initial coverage selector matched no tests (exit 0); its retained
`/tmp/R17b-mutant-coverage.txt` is not a successful mutation probe. The corrected
selector killed the mutation through the real excluded-file control.

This addresses #256's large-output failure and #257's missing real large-project
proof under explicit human approval, with directly related #258 work and #259's
small historical provenance correction. Independent external review and exact-head
plus post-merge CI remain required; local implementation completion does not land
the row or erase earlier #260/#261 evidence limitations. No paid provider is used.

## Preserved history and delivery

Commit `45b78ba` preserves the bookkeeping child's entire 48-line halt handoff.
Merge `49f88d738cf09a344712e2200171bf62deffdf5e` adopts green main
`da5236ac495c365b8ecb8984648f390c7107b418`, including #255's isolated executable
reviewer instructions, without rebasing. The final delta is reviewed against
halted `fdf72cf5838f0004a93a6f7630382114041c3686`, explicitly including that main merge.
The PR body preserves its earlier receipts verbatim. A fresh train may adopt the
existing PR only after the outside repair's required gates; no private fourth
train repair round or lowered review bar is asserted.
