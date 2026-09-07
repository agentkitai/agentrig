# Runtime-fixture CI repair — original independent review

Frozen head `fa0e1662e61faecf9fcd440b6ce98a6b226e76a6`, base `339f79586f37d027edd6939f39c2ac8fc6e78fd8`.
One substantive Claude review; session `31860d46-f664-4336-bb97-fa65542b13d1`.
Requested24, reported25 turns,204.401s: max-turn exhaustion without verdict.
Sole same-session tools-disabled summary: requested1/reported1,44.137s. Total26 reported turns.
Metadata list-price estimate1.4779605 +0.700625 USD is not a subscription bill.

Original verdict below is verbatim. No independent test/build/typecheck pass claimed.
Metadata records three denied Bash commands: two Node/version discovery commands
and one `npx vitest` command. It does not substantiate the original prose's broader
claim that pnpm/typecheck executions were denied. Preserve that prose, distinguish
it from recorded evidence. Author verification is in the repair contract.

## Original summary

## Verdict: APPROVE

No material defect established. The change is test-and-docs only, scoped as the contract requires.

### What I verified (static reading only)

- **Scope.** `git diff --stat 339f795..fa0e166` touches exactly `docs/ROADMAP.md`, `docs/STATUS.md`, `docs/plans/runtime-fixture-ci-bound.md`, `packages/cli/test/generated-skills-runtime.test.ts`, `packages/supervisor/test/evidence-grading.test.ts`. No production source, no deadline/budget/policy/skip/retry edits.
- **Bounds are scoped, not global.** `vitest.config.ts:7-13` sets no `testTimeout`, so the repo default stays Vitest's 5,000 ms; only the two fixtures carry `30_000` (`generated-skills-runtime.test.ts:144`, `evidence-grading.test.ts:57`).
- **The trailing `30_000` on `it.for` is honored at runtime.** `@vitest/runner` `parseArguments` (`chunk-artifact.js:1680-1704`) maps a trailing number to `{ timeout }`, and `taskFn.for` (`chunk-artifact.js:2040-2058`) passes those options to `test(...)`. `ctx.onTestFinished(fn, timeout)` is a supported signature (`tasks.d-DEYaIMIu.d.ts:1304`). The doc's account of `it.each` not supplying a context argument matches the types (`EachFunctionReturn` vs `TestForFunctionReturn`, lines 691-711).
- **Cancellation is real, not decorative.** The test signal reaches `runDream` (`dream.ts:134` → `MaintenanceRun` composes the parent signal, `maintenance.ts:50-57`), `buildAgent(opts, { signal })` (`agent-builder.ts:477`, same `extras.signal` used by `run.ts:439`), and the session via the abort listener plus `signal.throwIfAborted()` per mode (`generated-skills-runtime.test.ts:80,96,99-101`). The delayed provider stage uses the agent's own request signal — `ModelProvider.stream(req, signal)` is the declared interface (`provider.ts:68`) — so the injected 900 ms delay is abortable.
- **Join-before-cleanup is correct in both fixtures.** CLI: the session is aborted and joined in `finally` (lines 105-109) inside `work`, whose own `finally` does the `rm` (137-138), and `onTestFinished` joins `work` before the next test (142). Evidence: sessions are registered before the await that can throw (`evidence-grading.test.ts:42-43`), and `afterEach` aborts, `Promise.all`-joins, then removes roots (11-17). This addresses the EBUSY class specifically: `bashTool` kills the process group on abort and waits for `close`/pipe drain (`bash.ts:150-194`), so the join implies dead children before `rm`.
- **Semantics preserved.** Every original opt-in/refusal/provenance/raw-log assertion in the CLI fixture and every evidence/exit-mismatch assertion in the supervisor fixture is intact; real dream/emission, real `buildAgent`/CLI parse, and real `node check.cjs` children remain. The only additions are the delay parameter and `expect((await session.done).reason).toBe("done")`, which the contract permits. `check.cjs` keeps its `writeFileSync('ran')`, `ALL PASSED` stdout and exit codes — only the `process.exit` call is deferred.
- **Documentation is honest.** STATUS/ROADMAP record R16a as merged-but-not-done with the failed post-main Windows run; the contract states the delayed controls "reproduce the outer-bound failure class, not the unknown precise remote slow stage" and that Docker verification and the review were pending. No green-CI claim is made.

### What I did **not** verify

All execution was denied in this session (don't-ask mode): `pnpm/npx vitest`, `pnpm typecheck`, and `node -p`/`grep` shell calls were refused. So I did **not** run the two fixtures, did not confirm the claimed fail-before figures (5,003 ms / 5,006 ms) or the pass-after figures (18 passed / 3 files, 8.40 s), did not observe the generated test titles, and did not run build/typecheck. Everything above is from reading source, the vendored Vitest 4.1.11 runtime and types, and the tsconfigs.

### Optional polish (none blocking)

1. `generated-skills-runtime.test.ts:144` — `it.for` types (`TestForFunctionReturn`, `tasks.d:701-707`) have no trailing-number overload, unlike `.each`. It works at runtime and `packages/cli/tsconfig.json` only includes `src`, so nothing breaks today; the typed form `it.for([0, 900])(name, { timeout: 30_000 }, fn)` would survive any future test typechecking.
2. `generated-skills-runtime.test.ts:84` — the provider's `signal` parameter shadows the test-context `signal`; a distinct name (`requestSignal`) makes line 87's cancellation source obvious.
3. `evidence-grading.test.ts:91,131` — those sessions abort in `finally` without joining and are not in `ownedSessions`, so they remain the same abort-then-`rm` race the repair fixes elsewhere (low risk: their `check.cjs` exits immediately). Registering them is a one-liner, but it is outside the two named failures, so leaving it is defensible.
4. Both delayed variants are permanent suite cost (~5.4 s CLI + ~5.6 s supervisor per run). The contract requires both variants to pass, so this is a noted tradeoff, not a defect.
5. The new `afterEach` join runs under Vitest's default 10 s hook timeout while the tests get 30 s; safe given the group kill, but worth remembering if a future child ignores SIGKILL semantics on Windows.

