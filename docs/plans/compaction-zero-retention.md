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
