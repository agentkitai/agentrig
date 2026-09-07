# Independent review — compaction zero retention

One read-only invocation, frozen head `f6722c4` against `db2271b`.
Requested maximum 24 turns; reported 21. Session
`c7550d5a-40fb-4c31-af23-ada553f8ceeb`; duration 120,185 ms,
API duration 112,894 ms; `is_error: false`. No second review or summary continuation.

Author clarification: tests were not independently executed; four attempted forms
were denied. Author and CI receipts are separate. The review's claim that zero
retention always shrinks drastically is too strong: a short history or verbose
summary can fail to shrink, so the unchanged no-progress handling still matters.
Likewise valid existing counts are compatible; invalid SDK counts now deliberately
throw at construction. No universal claim that all existing host callers cannot throw.

## Original result (verbatim)

Review complete. Verdict first, then evidence.

**Verdict: approve.** The change is minimal, matches the contract in docs/plans/compaction-zero-retention.md, and I found no correctness defect in scope. Typecheck is green. I could not run the tests because every test invocation was denied, so the "152 passing" claim in STATUS.md is unverified by me and should be confirmed by the CI gate.

**Commands executed**
- `git diff db2271b f6722c4` and `git log`: succeeded. Six files, 95 insertions, 5 deletions.
- `pnpm typecheck`: succeeded, all four packages clean.
- Focused tests: denied four times. Piped form, `pnpm vitest run`, `pnpm test -- <files>`, and `./node_modules/.bin/vitest run` all required approval that this session cannot grant.

**Findings (evidence-based, in scope)**

- **Count validation is correct.** `packages/core/src/compaction.ts:80` rejects negative, fractional, NaN, infinite, and unsafe-integer counts at construction. It accepts `-0` as zero, which is harmless. The only production constructor without user input is the default at `packages/core/src/agent.ts:407`, so nothing existing can now throw.
- **Zero retention is safe and total.** At `compaction.ts:87` zero gives `cut === messages.length`. The new `cut < messages.length` guard at line 90 prevents the previous undefined `.role` dereference. Lengths 0 and 1 return the same reference, which `compactWithProvenance` at line 17 maps back to the original array, so the loop sees no change. Longer histories return task plus summary with an empty tail, so no tool pair can be orphaned.
- **Positive semantics are byte-for-byte unchanged.** For any keep of 1 or more, `cut <= length - 1`, so the added guard is always true and the widening loop behaves exactly as before. The pre-existing pair test at `packages/core/test/compaction.test.ts:87` still covers it.
- **Ancestry stays conservative.** Trust is joined over every summarized block at `compaction.ts:101`, including a prior summary, so nested and repeated summaries cannot upgrade trust. Asserted at `compaction.test.ts:44`.
- **Runtime path holds.** In the loop at `agent.ts:1119` the compacted array is adopted, the compact event is emitted, and the no-progress latch at line 1127 cannot trip since zero retention always shrinks drastically. The agent test at `packages/core/test/agent.test.ts:1278` checks the next request shape, a single compact event, and materialized-replay equality with the snapshot. The Anthropic adapter at `providers/anthropic.ts:56` maps roles one-to-one, but a user-role summary directly after the user task already occurs at every positive count, so the two-user-message request is not new.

**Inference, not evidence**
- Repeated compaction at zero re-summarizes the previous summary each time. This loses fidelity faster than positive counts. The contract chooses this deliberately, so it is a documented trade-off rather than a defect.

**Omitted checks**
- Tests not executed, as above.
- No explicit zero-count test through manual compaction. The contract states manual compaction is unchanged, and the shared strategy path plus the byte-shrink check at `manual-compaction.ts:125` make it consistent, but it is untested.

**Optional polish, non-blocking**
- The plan and STATUS cite a local `/tmp` log as the fail-before receipt. It is not reproducible from the repo. Dropping the path or attaching the log to the PR would make the claim checkable.
