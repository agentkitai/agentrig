# Compaction zero-retention follow-up

Existing roadmap END item, independently assigned from green main `db2271b`.
No new milestone hierarchy. Automatic slash suggestions remain a separate PR;
root serializes that merge and green main before this item integrates and merges.

The public option counts retained tail messages; the first task is independently
always retained. Deliberately support `keepLastMessages: 0`: summarize every later
message, retaining the task and one advisory summary, with no retained tool pairs
to orphan. Empty/task-only input is a no-op. Positive counts preserve the existing
backwards widening around tool results. Reject negative, fractional, nonfinite or
unsafe-integer counts at construction rather than indexing a nonexistent message.
No changes to other options, permission semantics, summary ancestry, event types,
manual compaction, default count eight, or raw session immutability.

Verification: fail-before/pass-after zero retention and count validation; actual
agent tool→summary→next-model path plus event materialization/snapshot equality;
conservative nested ancestry/repeated summary, empty-summary fallback, and retained
positive-count tool pairs. No live provider. One bounded Claude review, material
fixes, build/typecheck, full digest-pinned required Docker, actual Chromium, and
exact-head four CI gates. Root alone merges after updated-main integration.

## Initial verification

Before the fix: nine failures and one pass across the selected new controls.
Zero with history dereferenced undefined `.role`; the actual agent's compaction
path did not reach the expected summarized next request. Empty/task-only input
already passed. Six invalid-count cases failed to throw. With the bounded fix,
all 152 tests in compaction, agent, provenance assembly, thinking and manual
compaction pass, including exact event-materialization/snapshot equality.
Original failing log: `/tmp/compaction-zero-before.log` (local receipt).

## Final local gates and independent review

Frozen head `f6722c4`: build/typecheck pass. Digest-pinned required-Docker suite
passes 3,252 tests plus two existing skips /209 files (84.19s); actual Chromium
passes one test (2.86s). Worker image:
`sha256:f111ef59dce766519eb2ac455b554b01793aff0e9cd1d68d29b6d314d7db52e9`;
checker image: `sha256:33443f68f312abe4f1e88e16be7c88407d7173e80d7e55dfb0a12a5541e733e5`.

One Claude review APPROVE, 24 requested /21 reported turns; typecheck executed,
four test attempts denied. [Original result and exact metadata](compaction-zero-retention-review.md)
preserve those limits and correct the review's overstatement about guaranteed
shrinkage. Zero deliberately trades recent verbatim history for a summary; model
summary quality/size is not guaranteed, and no-progress/fallback behavior is unchanged.
No material findings or extra review. Exact-head four-check CI and subsequent
slash-suggestion updated-main integration remain pending; root alone merges.
