# Checkpoint lock inspection and explicit recovery

Checkpoints deliberately refuse a mutation while ownership is uncertain. The lock
is `agentrig-worktree-checkpoint.lock` in Git's **canonical worktree Git directory**
(`git rev-parse --git-dir`). Each linked worktree has its own owner; the main
worktree does too. Separate worktrees can checkpoint/edit/undo concurrently, even
the same filename. A directory's age, an empty
`git status`, or the absence of a command named AgentRig does not prove quiescence.
Do not disable checkpoints, delete the lock recursively, kill an unfamiliar process,
or retry mutations to bypass this refusal.

## Inspect without models or configuration

```sh
agentrig checkpoints lock inspect --cwd /absolute/path/to/worktree
```

The result names the exact lock path, its scope, observed state and identity token.
New version-2 leases contain a bounded `owner.json`: hostname, PID, session ID,
canonical repository/worktree-Git/common-directory paths, nonce and timestamp. No command
line, credentials or model task is recorded. Owner metadata is local cooperative
diagnostic evidence, not tamper-proof authority. The timestamp never determines
whether recovery is allowed. Inspection reads at most two directory names and
4,096 owner bytes and never follows lock/owner symlinks.

`live-owner` refuses recovery. `dead-owner` means the hostname matches and the
OS PID existence check returned `ESRCH`; it does **not** prove that descendants,
other worktrees, background jobs, editors or plain Git writers have stopped.
PID reuse safely causes a live-owner refusal, not a kill. Foreign-host owners or
indeterminate process checks are `unknown-owner` and refuse. Malformed metadata,
unexpected contents, hardlinked owner files and symlinks also refuse without
echoing their contents. `legacy-empty` means **unknown ownership**, not stale.

## Review, stop writers, then explicitly preserve the lock

First identify and join owned sessions/processes and stop all other cooperating
writers in the affected worktree. Independent writers in other worktrees need not
stop for a worktree-scoped lock. For `legacy-repository` scope, stop writers across
all linked worktrees. Checkpoint recovery cannot
establish the absence of arbitrary external writers. If you cannot establish
quiescence, stop here. Keep writers stopped through the command and inspection of
its result. Obtain a fresh inspection and review the exact path and metadata.

For a recognized, same-host dead owner:

```sh
agentrig checkpoints lock recover --cwd /absolute/path/to/worktree \
  --expected-token <token-from-inspect> --confirm-quiescent
```

An empty legacy lock additionally requires an explicit acknowledgment that its
owner cannot be identified. This is a deliberate operator decision, not inferred
from age or an automatically generated approval:

```sh
agentrig checkpoints lock recover --cwd /absolute/path/to/worktree \
  --expected-token <token-from-inspect> --confirm-quiescent \
  --acknowledge-legacy-empty
```

The token binds observed directory and owner-file identities and exact metadata
bytes. It is not a permission grant. Recovery rechecks that identity and current
owner status, then renames the reviewed lock into a uniquely created sibling
`agentrig-checkpoint-recovery-*/lock` container. **Nothing is recursively deleted.**
The command returns `preservedAt`; retain that evidence and inspect it before
resuming a new bounded edit/checkpoint/session-end cycle. Recovery does not restore
files, replay previous tools, establish an old ownership seal, or prove that a
previous task succeeded. Existing undo ownership guards remain unchanged.

There is no force option, age-based stealing, automatic expiry or automatic
recovery cleanup. A changed token requires investigation and a fresh inspection,
not a blind retry. Quarantine-container leftovers after failed/cancelled recovery
are retained. Cancellation before rename stops the operation; cancellation after
rename cannot roll back the completed filesystem change. External rename races
cannot be made transactional by an ordinary filesystem API: post-rename identity
checks detect uncertainty and preserve evidence, not undo a competing writer's work.
Legacy applications do not know the new metadata; keep them stopped during recovery.

## Upgrade and legacy evidence

Stop older AgentRig versions before upgrading; mixed-version concurrent writing
is unsupported. An existing `agentrig-checkpoint.lock` in the common Git directory
is never silently ignored, stolen or migrated. Inspection prioritizes it with
`scope: "legacy-repository"`; explicit recovery uses the same reviewed token and
preservation rules. Its presence blocks new checkpoint writes in every worktree,
including at subsequent ownership guards. These checks do not make a race with
an old binary transactional: old versions cannot recognize new worktree leases.

New snapshots and seals use `refs/worktree/agentrig/<session>/...`, which Git stores
per worktree. Old `refs/agentrig/...` receipts remain readable by guarded undo and
checkpoint diff; their recorded repository and object checks still apply. New
retention never prunes old refs or another worktree's refs, and raw logs are never
rewritten. Checkpoint and seal namespaces must match. Shared branch/object changes
still use Git's own locking; force-updating another worktree's checked-out branch,
external edits in the same worktree and deleting/moving active worktrees are not
made safe by checkpoint isolation.

## Trusted SDK surface

`inspectCheckpointLock(cwd, signal?)` returns the same read-only observation.
`recoverCheckpointLock(cwd, { expectedToken, confirmQuiescent,
acknowledgeLegacyEmpty?, signal? })` applies the same refusal and preservation
rules. Literal `true` acknowledgments are required; neither model-authored prose,
persisted events nor a copied token establishes operator authority. These are
explicit host administration APIs, not model tools or configuration hooks.

This implementation addresses the diagnostic/recovery path observed in issue
[#295](https://github.com/agentkitai/agentrig/issues/295). It does not claim that
the original real repository lock has been recovered: that is a separate operator
action after reviewing live ownership and quiescence.

Implementation validation used only private temporary repositories: exact-path and
owner-metadata assertions failed before implementation; removal of the live-owner,
inspection-identity and legacy-acknowledgment gates each caused the corresponding
negative control to fail. Mutations were restored. Actual legacy/dead-owner
preservation followed by a new edit, checkpoint, seal and release passed, alongside
the existing undo suite and actual CLI routing. Build/typecheck passed. These local
controls do not substitute for integrated PR/CI review or authorize real-lock recovery.
