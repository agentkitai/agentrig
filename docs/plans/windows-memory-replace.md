# Windows memory atomic replacement — CI-blocking repair

PR #144 CI run 34016959860, Windows job 101442314327, failed the existing real-process ingest
conservation test: `EPERM` while renaming an `index.md.<random>.tmp` file over `index.md`.
The two-worker fixture passed 95 other tests in that step; Linux/macOS checks passed. The log
does not identify the handle/actor responsible or prove the refusal was transient. The observed
failure exposed that `FileMemoryStore.atomicWrite` attempted replacement once, unlike the existing
bounded Windows access-error handling during memory lock acquisition.

This is a separate repair PR before R5d resumes, not a nested roadmap milestone or a test rerun
used to dismiss a real failure.

## Contract

- Only `FileMemoryStore.atomicWrite` changes. Existing writer locks remain held through replacement
  and cleanup; page/index/log semantics and committed-result reporting stay unchanged.
- On Windows only, `EPERM`, `EACCES` or `EBUSY` from rename allows another attempt on the **same
  complete temporary file and same destination**. There is no destination unlink, force option,
  fresh content rewrite, or alternate non-atomic replacement.
- A monotonic 250 ms retry window begins after the first eligible failure, with waits of at most
  20 ms. No new attempt starts after the deadline, including after a delayed timer wakeup. The
  budget limits retries, not an in-flight OS syscall or scheduler delay.
- Cancellation is checked before every attempt and passed into each wait. No retry is scheduled
  after cancellation. A successful rename is a commit and is not subsequently reported as an
  uncommitted failure if cancellation arrives afterward. An already-started OS rename cannot be
  interrupted; it is always awaited, never orphaned.
- Non-Windows failures and other error codes fail immediately. Persistent eligible failures
  propagate the last error after the bound; existing temporary-file cleanup runs. The previous
  destination is preserved when replacement never succeeds.

## Verification

Deterministic injected tests invoke the actual `FileMemoryStore.writeIndex` pipeline on all
platforms. They inspect target bytes, temporary bytes/path, lock ownership and removal calls;
exercise all three error codes, precise deadline exhaustion and delayed wakeup; cancel during
the wait and immediately before the next attempt; prove non-Windows/other-error immediate failure
and preserve success after commit. The existing real two-process ingest fixture remains enabled
on Windows. Build/typecheck/full tests, detected/restored negative mutations and one bounded
independent review precede exact-head three-platform CI. PR receipts record final outcomes.
