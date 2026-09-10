# Worktree-local checkpoint ownership

User authorization: “ok. fix it then”, after identifying that repository-wide
checkpoint locks prevent the intended parallel-agent/worktree workflow.
One corrective PR, not a new roadmap band. Builder: Codex/operator outside AgentRig.

## Contract

- Each canonical worktree Git directory owns its own
  `agentrig-worktree-checkpoint.lock`, including the primary worktree. Directory
  aliases/subdirectory launches must not produce another ownership domain.
- New snapshots, seals and retention use globally visible, worktree-qualified
  `refs/agentrig/worktrees/<sha256(canonical-git-dir)>/<session>/...`. Even identical session IDs in separate
  session stores must not reuse or prune a sibling's checkpoint.
  Shared visibility keeps all checkpoint objects reachable during Git garbage
  collection from any worktree. Git-private `refs/worktree/...` are not used:
  independent review reproduced sibling garbage collection deleting their objects.
- Separate worktrees may write the same relative filename simultaneously. One
  worktree may undo while another remains active. Actual dirty baselines, HEAD,
  index, seals, refs and file contents must remain independent.
- Same-worktree competing owners still refuse. Ownership identity, unknown effects,
  pending background work, external-file/index/HEAD changes, permission gates and
  undo collision/seal checks are not weakened. This is cooperative isolation, not
  an OS sandbox or protection against arbitrary cross-worktree shell writes.
- Git's existing object/ref transactions coordinate genuinely shared Git state;
  no whole-repository lease spans model calls. Avoid force-changing another
  worktree's checked-out branch or administrative worktree mutation during use.
- Old shared locks block new writers until explicit recovery; inspection identifies
  legacy repository scope. Stop old versions before upgrading. Guard checks detect
  an old lock's presence but cannot make mixed-version races transactional.
- Old refs remain usable by guarded undo/diff, with matching namespace, recorded
  repository and object identity. No raw log rewrite or automatic ref migration.
  New retention leaves historical shared refs untouched.

## Verification

Real Git + actual SDK overlapping-agent tests must fail on the old shared lease,
then pass for linked/linked and primary/linked worktrees with identical session IDs.
Negative controls cover same-worktree contention, copied recovery tokens, legacy
locks, mixed-ref receipts and external changes. Existing restore/retention/CLI tests
remain active; new paths enter Windows coverage. Runtime mutation probes restore
the broad lock/shared refs or remove safety checks and must fail the relevant tests.
Actual garbage collection from both primary and linked worktrees must preserve
each checkpoint's commits, trees and blobs, and both independent undos.

Run build, typecheck and full tests; one independent Claude/Codex review pair,
focused repairs only, then exact-head CI, merge and post-merge CI. Do not modify
real user worktrees to prove destructive restoration; fixtures are isolated.

## Prior recovery receipt

The real retained legacy lock from #295 was explicitly recovered after the user
exited AgentRig; the old empty directory was preserved, working files unchanged,
and issue #295 closed. See the issue's operator receipt. No retroactive absence-of-
external-writers or live-model judgment claim is made.
