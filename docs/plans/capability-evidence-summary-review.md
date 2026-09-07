# Capability evidence summary — independent review

One substantive Claude review of frozen source8928bd789c2c94916a13285892498d407841e757
against base5d91ce09686b634a35000afd2d3e20a57759cdc2. Requested24/reported26 turns;
228,174ms; sessionf36313e3-cb1e-41da-b3ae-57addfcd3a60. No continuation or second review.
APPROVE, no material findings. It independently ran20 focused tests and typecheck;
three alternative test invocations were denied before the allowed invocation succeeded.
No live providers or source changes by the reviewer. Original verdict below is verbatim.

Author response: added the suggested missing-report-key assertion and corrected the PR spacing.
No production change after review. The roadmap heading now reflects the user's explicit whole-queue
continuation instruction, not a new milestone. Four fail-before controls were actually run by
the author (4 failed/16 passed), not independently mutated by Claude. Author build/typecheck,
full required pinned-Docker3,309 passed+2 existing skips/209files84.30s and Chromium1/2.69s
passed before the added assertion; final-head validation follows on the implementation PR.
No hosted gates are inferred from local checks.

## Original review

## Verdict: **APPROVE** — 2 nits, no material findings

### Executed vs. inspected

**Actually executed** (this worktree, commit `8928bd7`):
- `pnpm typecheck` — green for core, memory, supervisor, cli.
- `pnpm exec vitest run packages/core/test/provider-conformance.test.ts packages/cli/test/provider-probe.test.ts` — **2 files, 20 tests passed** (2.51s). Fake streams + local 127.0.0.1 HTTP only; no live provider traffic.
- Not run (out of scope by instruction): full suite, pinned-Docker eval, Chromium, hosted CI.

**Static inspection only:** the fail-before claim (verifying it would require editing source), and every hosted receipt in `docs/STATUS.md:8-10` (CI `34104220683` / structure `34104220637`, PR #216 comment) — unverifiable read-only without fetching, so those remain author-supplied.

### Correctness

- `packages/core/src/provider-conformance.ts:103-104` — `source` is now derived from the same per-dimension `sources` map instead of from report presence. All-unknown report → `unverified-configured`; the cloned report is still attached (`structuredClone` at :104, spread only skips the key when `report === undefined`, preserving the previous shape for that branch). Capability-flag application at :106 is untouched, so no capability booleans, cache format/TTL/fingerprint, pricing, or permission/sandbox behavior changed.
- Source semantics are exactly what the contract states: only `tools` / `parallelTools` / `caching` feed the summary; `promptedSchema`, `cacheReporting`, `nativeStrictness` do not. A completed negative (`not-observed`) correctly counts as evidence — verified by the loop at `provider-conformance.test.ts:62-72`, which also asserts the other two dimensions stay `unverified-configured` and that the boolean tracks the observation.
- Fail-before, by inspection of the base expression (`report === undefined ? … : { source: "observed", … }`): the three all-unknown controls (`provider-conformance.test.ts:47-56` error/aborted, `:57-61` schema-only) and the CLI cached case (`provider-probe.test.ts:108`) would each have read `observed`. Four controls, matching the claim in `docs/plans/capability-evidence-summary.md:14-16` and `docs/STATUS.md:6-7`.
- Retained clone is genuinely tested: `provider-conformance.test.ts:53-55` asserts full `toEqual` on the all-unknown report **and** `.not.toBe(report)`, and `:52` asserts configured capabilities are unchanged.
- The CLI addition is a real builder/cache discriminator, not a restatement: `provider-probe.test.ts:106-110` rebuilds through `buildProvider` → `providerProbeFingerprint`/`readProviderProbe` → `applyProviderConformance` off the on-disk cache the failed doctor probe wrote, and the assertion only passes if the persisted all-unknown report survives round-trip. Confirmed empirically by the run above, since a missing cache entry would drop the `report` key and fail. `expect(requests).toBe(4)` at :111 (with :105) pins no implicit probe on read; `ordinary` and `cached` are separate provider instances with per-instance `capabilities` literals (`packages/core/src/providers/openai.ts:253`), so the "unchanged configured flags" comparison is not aliased/vacuous.
- No other consumer of `conformance.source` exists in any `src/` (grep: only the type at `packages/core/src/provider.ts:65`), so nothing user-facing renders a now-changed label. `provider-probe.test.ts:51` still legitimately expects `observed` after a fully successful probe.
- Docs: `docs/ROADMAP.md:1287-1290` and the new contract state the weaker meaning of `observed` explicitly and point at per-dimension sources; the contract closes with "this contract is not a CI claim," so the plan doc makes no unverified green claim.

### Nits (non-blocking)

1. **`packages/cli/test/provider-probe.test.ts:68`** — the only coverage of the *no report at all* branch uses `toMatchObject`, which would still pass if the builder attached a stub or `report: undefined` key. Since `:104` of the source was rewritten as a spread, one assertion that the key is absent (e.g. `expect("report" in provider.capabilities.conformance!).toBe(false)`) would lock the "missing evidence never fabricates a report" property that the rest of the change is about.
2. **`docs/ROADMAP.md:1373`** — `PR#216` is missing the space used elsewhere (`PR #196`, `PR #171`). Also an out-of-scope-adjacent edit, though factually correct: #216 is on main as base `5d91ce0`.

### Informational

Top-level `source: "observed"` still reports `observed` for a partially observed report (e.g. tools observed, caching unknown). That is the documented intent — `packages/core/src/provider-conformance.ts:15`, the contract, and the ROADMAP bullet all say so, and `sources` remains authoritative — so no action; `source` is now a pure function of `sources`, kept as a field for consumer stability.

