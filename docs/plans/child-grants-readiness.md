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

## Independent review receipt

Single bounded Claude review `8f8e96af-3314-4c96-b1c2-464cf4a6e48a`: 88 seconds,
8 reported turns / maximum 24 requested. APPROVE, no material findings. Independently ran
the five-file 40-test CI group and typecheck. Its attempted fetch was denied; coordinator
independently fetched and verified unchanged main `3d45d9f`. No subagents or live probe calls.
Optional status wording corrected; two optional test refinements recorded at roadmap END.
The reviewer shorthand about every predicate naming a tool is broader than the code:
editor/preview predicates require a present pending scope/preview, not a tool-name comparison.
Verbatim reviewer result follows (mutation reproduction was author-run, not reviewer-run):

> **Verdict: APPROVE.** No material defects found. The focused CI group and workspace typecheck both pass locally.
>
> | Check | Result |
> |---|---|
> | CI child-grants group (5 files) | 40 passed |
> | `pnpm typecheck` (4 packages) | clean |
>
> **What I verified against the controller contracts**
>
> - **Exact subscription readiness.** The controller's subscribe publishes the current state synchronously and returns a disposer. The helper handles that ordering correctly: a synchronous match sets the settled flag before the disposer exists, and the post-subscribe check disposes it. The timer is declared before subscribe runs, so there is no temporal dead zone on the clear.
> - **Premature run settlement and timeout cleanup.** Both settlement branches, the timeout, predicate failure and success all route through one guarded finish that clears the timer and unsubscribes. The helper tests confirm disposer called once and zero timers in every path, including the rejected-run case with no unhandled rejection.
> - **Authorization discrimination unchanged.** Every assertion on root, child and sibling grants, counters, revocation and persisted audit events is textually identical to origin/main. Only the wait mechanics changed. The sibling wait now requires a present probe prompt with a present registry and a different subject, which removes the old absent-prompt inequality. The mutation result in the plan doc is author-reported; I did not reproduce it since the review is read-only.
> - **Startup delayed-stage regression.** The 1,100ms delay sits on the real spawn path for the child's first turn only, and the old wait would have missed it. Both startup cases pass with the new helper. The docs correctly claim timing sensitivity, not a proven Windows cause.
> - **Both Ink input paths.** Ordinary and protocol modes run through the identical five-stage wait sequence and pass.
> - **Absent state is never ready.** Every predicate requires a non-null pending prompt with a specific tool. The timeout test confirms an absent prompt rejects with a state diagnostic.
>
> **Optional polish, non-blocking**
>
> - `packages/cli/test/tui-readiness.ts:31` builds a diagnostic string via snapshot before finish checks the settled flag, so every normal run completion does that work needlessly. Checking settled first would avoid it.
> - `packages/cli/test/child-grants-ui.test.ts:77` could additionally require the sibling prompt's registry to be a child view. Today it excludes only the first child, and the root prompt is distinguished by the later executed-count and subject assertions, same as before.
> - `docs/STATUS.md:7` still describes R10d as "implemented, pending delivery gates" while the new heading says it merged as PR #171. One line should be updated for consistency.
>
> Scope stayed bounded to the two test files, the helper and its tests, one CI line and docs. No production code touched.

## First repair CI: additional rendered-frame readiness

PR #173 first head `eac6e8b` CI 34035057038 passed Linux but failed macOS's protocol
UI case: all controller/authority/audit checks passed, while the final captured output
had not yet rendered `Child-owned`. Controller subscription completion does not flush
Ink's throttled rendering. This is a test-observation boundary exposed by faster waits,
not a permission failure. The initial failed receipt is retained, not rerun away.

The same repair now waits for an actual stdout frame containing the preview before
sending confirmation. Both input modes buffer preview frames deliberately: controller
preview is ready while captured output lacks the label; actual Ink eventually produces
the buffered label, and releasing the buffer resolves the output wait. The existing
final visible-text assertion remains unchanged. Both frame waits use the same four-second
bound and premature-run diagnostic. No production changes or second broad review.

Negative control: removing only the actual Ink frame wait fails both input modes with
empty buffered output instead of `Child-owned`; restored, all three UI tests pass.
After the frame correction, build/typecheck and full 2,497 tests plus two skips across
143 files pass again (four workers, 34 seconds). A new exact-head CI run follows.
