# R4a — opt-in pre-mutation checkpoints

Fresh branch `feat/r4a-checkpoints-current` from updated main `56b4d8a`, after E3 PR #134
exact-head CI 34006960314 and post-merge CI 34007074990 passed all platforms. The old PR #109
and its worktree are preserved. Selected hook/event tests are ported from that reviewed work;
the old write-permission-only gate and Git-filtered snapshots are replaced for this contract.

## Scope and contract

One roadmap row / one PR. SDK opt-in: register `new Checkpointer()` in `AgentConfig.hooks`.
Creation only; restoration, CLI/TUI undo and supervisor rollback remain R4b/R4c. No new default.
The existing H1 restriction still applies: host-process hooks require sandbox absent or `none`.
This PR does not bypass that restriction or make native Git part of an OS sandbox.

- Run after ordinary pre-tool hooks and final permission approval, before the first potentially
  mutating tool executes each turn. Unknown custom/MCP effects are conservative, even for a
  read permission. Only trusted SDK `effects: "read-only"` declarations skip checkpoints.
  Foreground shell calls are always potentially mutating; never parse shell text to guess safety.
- Private temporary Git index, raw blob objects and `refs/agentrig/<session>/<turn>` commits.
  HEAD, the user's index and worktree stay untouched; normal branch log is unchanged. Reuse an
  existing direct checkpoint ref, never overwrite it or dereference a symbolic ref. Retain refs
  for later undo; no automatic deletion/GC of user evidence.
- Capture tracked and non-ignored untracked regular files, raw CRLF/binary contents, executable
  bits and symlink target bytes (never target contents). Capture tracked deletions as absence.
  Include tracked ignored files; exclude ignored untracked files and the active session store.
  No clean/smudge filters, hooks or fsmonitor programs execute. Staged index state is preserved
  but is not part of the worktree snapshot. Timestamps, ownership, ACLs/xattrs and empty directories
  are not covered. R4b must retain ignored/excluded paths and cannot claim to restore that metadata.
- Refuse sparse checkouts, submodules/nested repositories, nonregular files, unsupported path
  encodings, files over 16 MiB, trees over 128 MiB, or over 50,000 paths. Bound Git output and the
  checkpoint hook to 60 seconds. These are rejection ceilings, not a promise that every tree
  below them finishes within the deadline. Failure/timeout/event-append failure blocks mutation visibly.
- A truly non-Git directory degrades to one warning per session. Broken/inaccessible Git metadata
  is not non-Git and fails closed. Session logs remain append-only; tools cannot forge checkpoints.

## Concurrent and background writers

An exclusive directory lease in the Git common directory lasts until the checkpoint-enabled
session ends. Other checkpoint sessions/worktrees sharing that common directory refuse while it
is held. Existing/stale locks are never stolen. Cleanup verifies the directory identity and only
removes an empty owned directory; unknown/replaced contents are preserved with an error.
After a crash, stop all writers, inspect `<git-common-dir>/agentrig-checkpoint.lock`, and remove
that exact empty directory manually only after confirming no owner remains. Never delete refs
or session evidence as part of lock recovery.

Known background launches are refused in checkpointed Git sessions. Registered unfinished jobs
also block later mutations (status/kill remains available). Trusted integrations can expose
`hasBackgroundWork()` and supply `assertQuiescent(ctx)` to reject external uncertainty. The
callback is rechecked for subsequent mutations in the same turn, not only the first snapshot.
Two raw scans must produce the same tree; detected edits or HEAD movement fail closed.

**Caller precondition:** external editors, watchers, daemonized shell children and unregistered
custom-tool writers must be stopped. This is an advisory cooperative-writer protocol, not an OS
filesystem freeze or security sandbox. Two scans cannot rule out ABA edits or future writes;
no snapshot may be advertised as owning arbitrary external/background changes. Uncertain hosts
must reject through the callback or not enable checkpointing. R4b must independently verify
current ownership before destructive restoration; a checkpoint existing alone is insufficient.

## Validation and convergence

Actual Git and scripted-agent tests cover shell/custom/file effects, once-per-turn ordering,
denied/read-only calls, dirty/staged/untracked/ignored/binary/CRLF/symlink bytes, unborn/corrupt
repositories, sparse/submodule refusal, existing/symbolic refs, fail-closed timeout/append/ref
errors, lease conflicts, real registered background jobs and deterministic between-scan writes.
Event schema/render tests and three-platform CI are required. One bounded independent Claude
review, focused repairs only for material findings. Optional improvements go at ROADMAP's end.

Maintainer build/typecheck and full explicit Node22 suite: 1,901 passes plus two skips (90 files).
Claude pass `124693ac-c382-45ef-a044-41be0468eb87` approved; independently ran build/typecheck
and 127 targeted tests. Its only pre-merge request was throughput measurement/documentation.
A disposable local Linux repository with 1,000 distinct ~1 KiB untracked files took 3,961 ms
for the two-scan checkpoint (Node22, raw blobs, no user Git identity). This is one local sample,
not a Windows/macOS or worst-case guarantee. Two process launches per file limit scalability;
larger/slower trees may hit the deadline and block mutation. Batching is an optional follow-up.
Mutation controls: restoring write-permission-only gating fails the named shell/custom-tool test;
removing the scan-equality guard fails the named between-scan-change test. Both mutations reverted.
