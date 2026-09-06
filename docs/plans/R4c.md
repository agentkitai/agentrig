# R4c — opt-in restore after supervisor abort

Fresh branch `feat/r4c-supervisor-abort-restore` from updated main `1291c77`, after R4b PR #136
final-head CI 34009706860 and post-merge CI 34009896484 passed Linux/macOS/Windows.

## Contract

- SDK supervisor `abortRestores: true`, default false. The supervisor remains dependent on core
  types only: a trusted `restoreCheckpoint(sessionId, signal)` seam supplies the existing core undo.
  Enabling restoration without that seam is a construction error, never a silent no-op.
- Exactly one restore attempt after this observer issues an abort and `session.done` confirms an
  aborted session. No restore for user abort alone, normal completion, budget/error completion,
  or detach before an abort intervention. Detach prevents future interventions but does not cancel
  already-authorized restoration. The observer's `done` joins that work.
- A 60-second signal reaches the core undo. Never race destructive work and announce completion
  while it may still mutate: trusted callbacks must honor cancellation and settle; an uncooperative
  SDK callback can delay the join. Wait for the agent's real settlement and retain R4b's writer
  lease, dirty-tree/index/HEAD guards, latest-run seal and recovery behavior. No forced undo.
- CLI/TUI `--supervisor-abort-restores` / config `supervisorAbortRestores: true` requires explicit
  supervision, abort permission and checkpoints, with sandbox none. Validate before starting a
  session. Shared wiring reads the settled snapshot cwd and invokes core undo; no model calls.
- Report restored/no-op/refused outcomes without appending after the original `session.end`.
  Successful restore keeps R4b's separate audit log. TUI forgets automatic resume state after a
  successful restore, just as manual undo does. Headless JSON stdout remains the original event log;
  restoration diagnostics go to stderr and name the separate audit receipt.
- This is the abort option, not a general mid-session `checkpoint_rollback` policy rung. H6 stays
  next; optional improvements go at the end of ROADMAP, without new hierarchy levels.

## Checks

Real Git + scripted agent: opt-in successful supervisor abort restore, default-off, user-abort
non-trigger, dirty/uncertain refusal, final log immutability, no early restore, exactly-once and
join/detach behavior. CLI/config/TUI wiring and no silent prerequisites. Negative mutation of the
opt-in gate must fail a named test. Bounded independent review and exact-head/post-merge CI gates.

The integration tests exposed a core cancellation-classification bug: a provider that closed its
iterator normally after abort could be reported as done. Core now refuses entry with an already
aborted signal and checks cancellation before choosing the final stop outcome, preserving any
reported usage. The restore guard still requires an aborted result; it is not weakened to accept done.

## Validation receipt

Build/typecheck and full Node22 suite: 1,931 passed, two skipped, 92 files. One bounded independent
Claude review `db4e2583-64e6-45c0-9a34-1e42ee8bd5d0` approved with no material findings, passing
build/typecheck and 1,036 selected tests. No delegated reviewers or additional review rounds.
Removing the opt-in gate fails the real default-off undo test; removing the post-stream cancellation
check fails the normally-closing provider test (done instead of aborted). Both mutations restored.
PR exact-head and post-merge main CI are still required before H6.
