# H5 — explicit recovery of owned dream workspaces

Base main c820c84 after PR #128 and main CI 33969215100, all platforms green. Current row only.

## Contract

- New manifest version records the producing PID and hostname, with explicit lifecycle handoff.
  Runtime workspace handles may dispose their own work. A persisted recovery API requires the
  exact owner UUID observed during preview and either explicit producer release or an exited
  same-host producer. PID reuse, permission errors and foreign hosts are conservative refusals.
- Keep version-1 manifests applicable through the existing guarded apply API, but refuse to
  infer inactive ownership for recovery. Missing, malformed or unregistered artifacts require
  manual inspection. A temporary-directory prefix or old mtime is never evidence of ownership.
- Recovery operates on a single explicit output and its sidecar, never the source or backups.
  Recheck owner/root identity under the canonical output lock; refuse symlinked/replaced roots,
  symlinked sidecars or changed manifest owner/content. Preview is read-only;
  confirmation binds to the previewed owner UUID.
- Never reclaim writer locks automatically, even when they look stale. Concurrent reapers cannot
  implement atomic compare-and-unlink safely with Node's ordinary file APIs. Stop all writers
  before manual recovery of the specifically named lock. This command must not steal a newer
  lock through an age/PID-only unlink race.
- A completed/retained run explicitly releases producer ownership so a long-lived TUI/SDK
  process can hand off review artifacts. Release failure is visible and leaves conservative
  active ownership, never a false successful handoff. Returned runtime disposal remains usable.
- This is single-host cooperative filesystem coordination, not authentication, a distributed
  lease, hostile path-race defense or a power-loss guarantee. Unknown provenance is preserved.
  Shared mounts and different PID namespaces are unsupported; hostname only detects mismatches.
  Handoff is post-production bookkeeping with a bounded five-second lock wait, like cleanup;
  it must not convert a completed live commit into a reported cancellation.
- Crash during unregistered allocation/copy remains manual inspection; invalid/partial sidecars
  are not guessed through. Automatic interrupted-install repair/journaling is deferred, not an
  additional H5 completion gate; existing original backups and stop-writers manual recovery stay.

## Validation

Real separate-process producers: active refusal, exited recovery, released live-producer handoff,
and replaced roots/owners. Bounded malformed manifests, legacy refusal, symlinks, existing locks,
preview/confirm token mismatch, cancellation, partial disposal and handoff failure. Drive the
built CLI and actual runDream lifecycle; negative mutations must fail the ownership tests.
Build/typecheck, explicit Node22 full suite, Claude review, exact-head three-platform PR CI,
merge and post-merge main CI before continuing H5 persistence work.

The repository-map growth regression is corrected in this PR as test maintenance: prove the
tree-before-symbols guarantee with a controlled small tree and excessive exports, retain the
real-checkout byte-cap/truncation smoke test, and retain the existing oversized-tree fixture.
Do not raise the production budget or promise that an indefinitely growing checkout fits 8 KiB.
