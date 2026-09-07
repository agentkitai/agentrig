# Grant-transition readiness repair

Bounded delivery repair, not a roadmap item. Main2181859 (#203) passed all four
exact-head checks, but post-main Windows CI34082267021 failed the existing
`tui.test.ts:236` first permission-prompt assertion in the real `new` transition.
It used Vitest's default one-second polling readiness. The other160 tests in
the group passed; Linux/macOS/structure passed. The log establishes absent
prompt at that bound, not the exact slow remote startup stage or a grant defect.

Contract before edits: preserve actual controller/agent/store/fork execution and
all grant scope/revocation/denial/raw-log assertions in the existing parameterized
new/fork/switch fixture. Add an abortable1.1s first-provider startup control for
each transition, demonstrate failure under the old readiness, then use the
existing four-second subscribed waitForTuiState at both permission boundaries.
Join the owned controller before temporary cleanup. No production deadline,
grant rule, retry, skip or global timeout change; no unrelated test migration.

One bounded Claude review with original verdict/actual turns retained, material
findings fixed with controls. Build/typecheck/full required Docker/Chromium and
exact-head/repaired-main all-four gates. Pause #201 merge until repaired main
is green, then drain201→205→207→194; unsubmitted roadmap work remains frozen.
Branch from failed updatedmain2181859 only to repair its delivery gate.

## Evidence

With the original waits, each1.1s controlled first-provider startup failed the
same absent-prompt assertion: new1008ms, fork1005ms, switch1004ms. All three
zero-delay baselines passed. Controller shutdown in finally joined the aborted
runtime before owned temporary cleanup even during those failing controls.

The existing subscribed waitForTuiState now requires the actual needs_permission
prompt at both boundaries and rejects an early-settled run. No production or
global test timing changed. After correction,170tests across the TUI, readiness,
grant runtime/core and render suites pass (5files,5.98s), including all six
baseline/delayed transition cases. Build/typecheck pass. Full required-Docker,
Chromium, single bounded review and delivery gates pending.

Pre-review full required-Docker passed3,106 +2existing skips /197files,74.69s;
actual Chromium1passed,2.46s. One [Claude review](grant-transition-readiness-review.md)
requested changes:24requested/28reported turns, independently170unique focused
tests passed, no Windows/build/typecheck/full-Docker execution claimed. Original
verdict and its arithmetic/command-availability caveats are retained verbatim.

Review closure: the final delayed variants wait2.6s at each actual prompt stage.
Under the original5s outer bound they fail at5005/5002/5002ms (all three zero-delay
baselines pass). Scope expands only to an explicit20s bound on this same fixture,
not global timing, and joins both owned controllers before root cleanup, including
outer-timeout afterEach cleanup. Both existing4s prompt waits remain fail-closed.
No production changes or second review. Final local verification passes:
170 focused tests /5files (18.32s), build/typecheck, required-Docker3,106 passed
+2 existing skips /197files (75.64s), and actual Chromium1passed (2.36s).
Exact-head and repaired-main delivery gates remain pending.
