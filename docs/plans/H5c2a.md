# H5c2a — bounded wiki and raw scans

Starts from updated main fb8201e after PR #125 and green main CI 33963323981.

- Bound wiki tree entries, depth, per-file bytes and aggregate bytes while copying/fingerprinting,
  not only after allocating an entire directory/file. Check cooperative abort between filesystem
  operations and before further writes. Reject unsupported entries/cycles; never silently omit data.
- Preserve H5c1's owned directories, root modes, canonical lock identity, stale checks and backups.
  Once apply moves the original root, finish or restore even if cancellation arrives.
- Bound raw session directory enumeration and attempt ledger reads. Count unrelated entries toward
  scan work; fail visibly instead of selecting an arbitrary partial history. Session-scoped ledger
  lookup/index rebuilding remains H5c3.
- Adopt bounded page/raw/evidence discovery on the dream path; keep generic legacy callers explicit
  where signatures remain backward-compatible. Bound failures/corruption must not become a claim
  that an incomplete wiki is clean.
- Tests cover each boundary, FIFO/type rejection, nested trees, aggregate growth, cancellation,
  conservation of original/backup data and relevant mutation failures. Node 22 and all existing
  platform CI gates remain required.

This does not complete dream lifetime guarantees: provider deadlines/usage and the full signal
chain through regeneration/CLI/hooks are H5c2b. Crash-left workspace recovery is H5c2c. Filesystem
syscalls and synchronous parsing are not hard-preemptible; limits cap work/allocation and checks
stop subsequent work, rather than promising a hard OS deadline.

Implemented defaults: 10,000 enumerated entries, directory depth 32, 8 MiB per file and 64 MiB
aggregate bytes per traversal. Each snapshot fingerprint/copy/verification pass has its own budget,
as do page scans and ledger scans; 64 MiB is not a cap on all phases combined. Named metadata reads
are separately bounded; scheduling stamps are 4 KiB and manifests retain H5c1's 64 KiB cap.
Exclusive bounded file writes preserve modes, including umask-masked bits. Fingerprint framing
is unchanged so existing bounded H5c1 artifacts remain usable.

FileRawStore session/document enumeration is bounded by default and only missing directories are
treated as empty. Its legacy no-options readAttempts/attempts remain unchanged; ingest and dream
pass explicit ledger bounds. FileMemoryStore.pages(opts) is strict and bounded; no-options generic
search retains the old behavior for now. Dream uses the strict path, including consolidation's
reread. Enumeration/byte cap failures stop the dream; known unreadable/corrupt attempt entries
instead produce an explicitly incomplete, review-only artifact with the affected paths. Model
consolidation and CLI/hook automatic apply are disabled, and the report cannot claim a clean scan.
The immutable files remain untouched; fixing permissions can resolve a transient read failure
without deleting history. Manual SDK artifact application remains an explicit trusted operation.
Custom SDK stores must honor scan options; returned lengths are checked too, but the
caller cannot prevent allocation inside trusted custom code.

`dreamScanLimits` config and `--dream-scan-limits <json>` on dream/run/TUI/resume configure these
caps, including the scheduler's initial cadence enumeration. Pin metadata and repeated checked-page
reads share one aggregate budget across inspection and guarded revalidation; pin entry counts and
serialized pins/index output are capped. Short reads reuse a geometrically grown buffer, preventing
retained backing buffers from multiplying the byte cap. A fixed H5c1 hash vector covers files,
empty directories, relative file/directory symlinks, modes and the excluded scheduling stamp.

Scan signals are observed by tree/page/raw/evidence reads and at phase transitions. Full provider
lifetime, regeneration commit cancellation, final accounting and lifetime CLI configuration remain H5c2b;
passing a scan signal alone is not yet a guarantee that a stuck model call terminates.
