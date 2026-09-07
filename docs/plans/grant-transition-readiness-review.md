# Grant-transition readiness — original independent review

Frozen74caf8810251d43f92b8e8fedc12d3e8dcd05b0f versus2181859b723cc9be80eee7ce2dcefeebf03da0bb.
One Claude review; requested24/reported28 turns,210.150s, no denied commands.
Session `b16a3653-b7e3-467f-b3aa-24376ef81769`; REQUEST_CHANGES.
Metadata list-price estimate1.0006835USD is not a subscription bill.
Original result retained verbatim below. Author disposition follows separately.

## Original result

## REQUEST_CHANGES

Scope: `2181859..74caf88` only — 4 files, docs + `packages/cli/test/tui.test.ts`. No production files touched (`git diff --stat` confirms), so the "production-free repair" constraint holds.

### What I verified

- **Fixture is genuinely parameterized, not weakened.** `it.each` now yields 6 cases (`new|fork|switch` × `startupMs 0|1100`); every original assertion is retained verbatim — grant `resource:"*"`, `duration {kind:"session", id:oldId}`, empty grant list post-transition, single `✓ needs_permission`, `permission.revoked` with `oldGrant.id` in the raw log, terminal `session.end`. Real `TuiController`/`createAgent`/`SessionStore`/`forkSessionAt` execution is preserved; the only swap is `makeController(calls, …)` → `makeControllerWith(new FakeProvider(calls, startupMs), …)`, both pre-existing helpers (`tui.test.ts:147`, `:199`).
- **The 1.1s control is a valid fail-before control.** `vi.waitFor`'s default timeout is 1000ms (`vitest@4.1.11` `test.DNmyFkvJ.js:3361`: `{ interval = 50, timeout = 1e3 }`), and the delay is applied inside `stream` *before* the first turn's events (`requests.length === 1`), so under the original wait the prompt is provably absent at the 1s bound for all three transitions. I did not reproduce the plan's exact 1008/1005/1004 ms failures (that needs an edit, which is out of scope here); the mechanism is sound.
- **`FakeProvider.stream(req, signal)` matches the contract.** `ModelProvider.stream(req, signal)` at `packages/core/src/provider.ts:68` already declares the signal, so adding it is conformance, not a widening. No test calls `FakeProvider.stream` directly, so the signature change is inert elsewhere.
- **Readiness helper is unchanged and does not paper over an absent prompt.** `tui-readiness.ts:24-34` rejects on timeout, on run-settled-before-readiness, and on run rejection; the predicate is `state.pending?.req.tool === "needs_permission"`, i.e. the actual prompt, at both boundaries.
- **Tests actually run** (`pnpm exec vitest run`, this worktree, HEAD `74caf88`):
  - `packages/cli/test/tui.test.ts` — 96 passed. Delayed cases: new 1127ms, fork 1134ms, switch 1129ms; zero-delay 28/32/28ms.
  - CI group from `.github/workflows/ci.yml:120` (`permission-grants` + `grant-runtime` + `tui` + `render`) — 164 passed, 5.99s.
  - `packages/cli/test/tui-readiness.test.ts` — 6 passed. 164+6 = the 170 the plan claims.
- **Not run** (outside the allowed command): build, typecheck, Docker/Chromium-required suites, Windows. The Windows behaviour of this change is unverified by me.

### Blocking finding

**The delayed cases spend 1.1s of an unraised 5s per-test budget on the platform that just proved it is slow.** There is no `testTimeout` override in `vitest.config.ts` or in the CI invocation, so each case runs under vitest's 5000ms default. Two consequences:

1. On Windows, the observed cost of reaching the first prompt already exceeded 1s. The delayed variant adds 1.1s *additively* (the delay precedes the first turn's events) on top of that real cost, plus the second boundary and fork/store I/O. That leaves well under 2s of margin on the exact runner whose slowness is the subject of the repair — a new way for main to go red.
2. In the delayed variants the helper's own 4s bound is unreachable (1.1 + 4 = 5.1 > 5.0), so a Windows timeout there surfaces as vitest's generic `Test timed out in 5000ms` instead of the helper's `pending=…; status=…; recent=…` diagnostic. That is precisely the diagnostic blindness that left the original failure readable only as "absent prompt at 1s."

Fix, and it stays inside the contract (per-test, not a global timeout change): pass an explicit timeout to the parameterized case. `EachFunctionReturn` in `@vitest/runner` 4.1.11 supports both `(name, fn, timeoutMs)` and `(name, { timeout }, fn)`, so e.g. a 20000ms third argument after the test body at `packages/cli/test/tui.test.ts:264`.

### Non-blocking, worth fixing in the same pass

- **`other` is never shut down.** In the `switch` branch, `const other = makeController([])` (`tui.test.ts:246`) outlives the test; only `c` is joined in `finally`. The stated contract is "join the owned controller before temporary cleanup," and `other` is equally owned and rooted in the same temp dir removed by `afterEach` (`:143-144`). One line in the same `finally`.
- **Only the first boundary has a fail-before control.** The delay fires on `requests.length === 1` only, and for all three transitions the post-transition prompt comes from a later request on the same provider, so the second `waitForTuiState` switch is unexercised by any control. This matches the remote failure (`tui.test.ts:236`, the first prompt), so it is a coverage gap rather than a defect — but the docs should not read as if both boundaries were demonstrated.

### Uncertainty preserved

CI 34082267021 establishes only that the prompt was absent at the 1s bound on Windows. It does not identify which stage was slow, and nothing in this diff or in my local runs establishes that 4s (effectively ~3.9s under the 5s cap) is sufficient there. The docs (`docs/plans/grant-transition-readiness.md`, `docs/STATUS.md`, `docs/ROADMAP.md`) state this correctly and do not claim R16b is done — that framing is accurate.

## Author disposition

Material outer-budget finding reproduced: controls now delay both actual prompt
stages2.6s each. With the unchanged5s outer bound, all three transitions failed
at5005/5002/5002ms; zero-delay baselines passed. Only this parameterized fixture
now has20s, covering two existing4s readiness phases plus real fork/log work.
The helper already includes provider delay within its own wait; the review's
1.1+4 arithmetic is not relied upon. The demonstrated aggregate-stage outer
timeout is the basis for the fix. Four seconds remains a tested bound, not proof
of a universal Windows latency guarantee.

Both c and the switch peer are joined in finally; fixture-owned controllers are
also registered for abort/join before afterEach removes the temporary root, which
covers Vitest outer-timeout cleanup. Other fixtures remain unchanged. Current
delayed controls exercise both prompt boundaries; earlier1.1s first-stage controls
and their original failures remain historical evidence. No second review.
Reviewer build/typecheck were not run; the invocation did permit those commands,
so the original parenthetical does not describe a denied execution.
