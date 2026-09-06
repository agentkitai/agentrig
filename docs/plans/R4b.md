# R4b — guarded explicit undo

Fresh branch from updated main `45dac7f`, after R4a PR #135 exact-head CI 34008045638
and post-merge CI 34008201624 passed all three platforms. One row, one PR; R4c stays separate.

## Contract

- Opt-in `--checkpoints` / config `checkpoints: true`, shared by headless runs and TUI. Existing
  host-hook sandbox restrictions remain. SDK `Checkpointer` supports the same ownership receipts.
- Record the stable raw tree after each settled mutating tool. Before a later mutation and at
  session end, compare against that owned state; external changes between tools refuse. After
  session-end hooks, a matching stable tree, HEAD and index seal ownership in a namespaced Git
  ref and additive event. Aborted in-flight or uncooperative work cannot be sealed. Older R4a
  sessions without a seal are not retrospectively certified.
- `sessions undo <id> [--to-turn n]` and idle TUI `/undo [turn]` restore the latest checkpoint
  by default. Take session and common-Git locks, require a closed session and an exact matching
  ownership seal, HEAD/index and current raw tree. No force flag; uncertainty refuses.
- Restore only differing covered paths using raw blobs (no Git filters). Preserve pre-existing
  dirty bytes in the checkpoint, ignored/excluded files, the real index, HEAD, normal Git log,
  checkpoint refs and original session JSONL. A separate audit log records restoration.
- Preflight every path/type and stage all replacement bytes before changing covered files.
  Retain a recovery directory containing displaced originals if installation fails; never
  overwrite unexpected paths or erase recovery evidence. No multi-file crash-atomicity claim.
- A true non-Git session is a warning/no-op. Missing/corrupt ownership, active/background writers,
  changed HEAD/index or external edits refuse. The R4a cooperative external-writer precondition
  still applies: scans do not prove the absence of concurrent adversarial/daemonized writers.
- Undo changes files, not conversation history. TUI starts a fresh conversation after successful
  undo, preventing automatic continuation from claims about reverted work. Explicit resume remains
  possible and does not replay tools. Ignored artifacts and staged index state are not rolled back.
- Invoke undo from the recorded repository. Only checkpoints from the latest run are eligible;
  earlier resumed runs may predate external edits and are not covered by a newer seal. HEAD
  movement since the target refuses, rather than rewriting history. File/directory collisions,
  sparse/submodule trees and cross-device installation failures are conservative refusals.
- Raw scans now run after mutating tools, before subsequent mutations, at seal and at undo. This
  adds opt-in latency; R4a's single-checkpoint sample is not an end-to-end overhead estimate. Each
  lifecycle check and explicit undo has a 60-second budget. Recovery originals remain until the
  owner inspects and manually removes that exact directory; no automatic GC.
- Session-end hooks that modify covered files (for example an unignored memory wiki) invalidate
  the seal rather than silently claiming those later edits. Ignore/exclude only intentionally
  out-of-scope artifacts; checkpointing is not a promise to undo memory maintenance.

## Checks

Real Git: shell/file tools, binary/CRLF/symlink bytes, dirty/staged/untracked/ignored files, target
selection, HEAD/index/log/ref preservation, external edits, held/stale lease, missing seal,
in-flight abort, path collisions and partial-failure retained evidence. Thin CLI/TUI/config wiring
tests; event/schema/render cases. Dirty guard mutation must fail its named test. Bounded Claude
review, exact-head and post-merge all-platform CI before R4c. Optional polish goes at roadmap end.

Maintainer build/typecheck and full explicit Node22 suite: 1,917 passes plus two skips, 91 files.
Claude's single bounded review `0d3fecf5-0182-4d8c-9140-72e70d19c1fa` approved with no material
findings; independently passed build/typecheck, 125 targeted tests and the same full suite.
Removing the pre-install dirty-state comparison fails `undo defaults to the latest checkpoint
and refuses external dirty-worktree changes` by permitting a partial restore instead of the
required pre-mutation refusal. The mutation was reverted and the affected suite rerun.
One earlier full run hit E2's Date.now-based negative-wall-time fixture flake; its targeted rerun
and two subsequent full runs passed, without changing production checks or the original test.

Initial PR CI 34009484658 passed Linux/macOS; Windows hit Vitest's default 5-second timeout
in three multi-step Git cases (then teardown encountered still-running children). The core and
CLI checkpoint integration files now have a 30-second fixture budget. No tests/assertions are
skipped and no production deadline changes. This is a CI fixture repair, not another review round.
