# Child-grants test-readiness repair

Separate CI-blocking test-only repair, before R10a. No production permission, grant,
provider, TUI or session behavior changes. The authorization assertions remain intact.

## Evidence and limits

R10d PR #171 passed exact-head Linux/macOS/Windows CI 34033537430 at `dc82a360` and
merged as `3d45d9f`. Post-merge CI 34033869154 failed Windows at the first child prompt
in child-grants-startup.test.ts and the sibling prompt in child-grants-ui.test.ts.
The single explicitly authorized diagnostic rerun repeated both failures (jobs
101488277897 and 101489388573); Linux/macOS passed. Neither run reached all later
Windows checks, so no green post-merge receipt is claimed.

Both assertions used Vitest's default 1,000ms polling timeout. An earlier predicate
also accepted absent pending state as a changed child subject. The four-file group
passed locally 34/34 in 1.08 seconds. A controlled 1,100ms delay before the real child
provider response reproduced both startup cases' missing-prompt assertion. This proves
timing sensitivity, not the unrecorded cause of the Windows runner's delay.

## Repair

A small test-only helper subscribes to actual controller state. Each wait requires its
exact prompt/editor/preview predicate; sibling readiness requires a present probe prompt
and present registry with a different subject. There is no absent-state success.
Premature run resolution/rejection fails immediately with a bounded state/recent-lines
diagnostic. A four-second wait bounds genuinely missing states; subscriptions and timers
are removed on success, predicate failure, run settlement and timeout, including synchronous
initial publication. Outer startup/UI test ceilings are 10/20 seconds so the individual
readiness diagnostics can fire. These are fixture bounds, not runtime latency promises.

Actual startTui/buildAgent/spawn retains an intentional 1,100ms provider delay to exercise
the previously failing boundary. The real Ink ordinary/protocol paths retain root/child/
sibling grant isolation, inheritance, counters, revocation and persisted audit assertions.
Helper tests use a controlled clock for delayed readiness, missing state, premature run
resolution/rejection, synchronous readiness, predicate failure and cleanup. No live providers.

## Verification

- Original startup polling plus the controlled delay failed both startup cases; subscription
  readiness with that same delay passes both.
- Negative mutation: accepting `pending?.permissionGrants?.subject !== child.subject`
  prematurely resolves during an absent prompt. Both actual Ink input modes fail their
  unchanged executed-count assertion (expected three, observed zero). Restored afterward.
- Focused helper tests: six pass. Full build/typecheck/test, one bounded independent review
  and exact-head three-platform CI are required before merge. Post-merge CI gates R10a.

Local build/typecheck and full suite pass: 2,497 tests plus two skips across 143 files,
four workers, 35 seconds. Independent review and exact-head CI follow.
