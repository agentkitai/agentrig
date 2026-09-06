# R7c — bounded unattended receipts and failure visibility

Starts from green main `f3a1ec8`, R7b PR #179, post-CI `34042336391`.

## Contract

Ordinary cron launches write one structured `.agentrig/schedule.log` outcome after
joined run/maintenance: source, entry, UTC minute/time, nullable session ID, main
outcome, maintenance failure, separately reported main/auxiliary usage and nullable
estimated cost. No task/output/error prose or credentials. Preview and deduplicated
ticks write nothing. Successful heartbeat remains quiet and maintenance-free;
heartbeat failures receive only operational failure accounting and the next-start
banner. This explicitly extends R7b's operational metadata exception, not its task/
wiki/report capability or instruction authority. No model no-action classifier.

Reuse existing ingestion once when ordinary scheduled work has configured memory,
honoring an explicitly configured `ingestOnEnd:false` (not a shared default false).
The existing hook receives the actual session directory through trusted runtime
plumbing, never config/model path authority, so custom memory roots work without
copying raw logs. Existing roles, trust, permission and cancellation/ingest bounds
remain. Main budget is not a maintenance or monetary cap.

Retain at most 512 one-KiB receipts / 512 KiB. Fixed canonical trusted-root paths,
regular files, no symlinks; cooperative report lock and atomic replacement. No
stale-lock stealing. Safe monotonic sequences and acknowledgement cutoff only
through the displayed snapshot; concurrent newer reports remain pending. Pruned
unacknowledged history is explicitly uncertain, never zero failures. Corrupt or
oversized state warns/refuses without overwriting it. Report failure after a claimed
run is visible and never causes model retry. Process crashes can leave missing
receipts; no crash-atomic relationship with schedule claims or physical terminal
delivery proof is promised. This is bounded operational retention, not a spend ledger.

On report-write failure, create only fixed `.agentrig/schedule-report-uncertain.json`
exclusively (512-byte read bound), with generic version/uncertainty fields. Never overwrite
an existing marker or automatically clear it during acknowledgement: that could hide a
concurrent new missing receipt. Startup keeps warning until an operator stops scheduler
writers, inspects the immutable raw logs, and removes only that exact marker. If writing the
marker also fails, stderr/nonzero exit are the only available record; no retry of model work.

Trusted interactive startup shows bounded failures through actual controller/Ink
mounting before acknowledging the snapshot. Headless, preview and untrusted startup
do not consume notices. Lock/read errors warn and retain pending state.

Accounting replaces cumulative auxiliary snapshots by ID (128-ID collector bound),
never double-sums them or conflates them with main usage. Missing usage/pricing,
unfinished calls, child coverage and overflow remain unknown/partial, not free.
Reporting/banner adds no provider calls. Raw session logs remain immutable.

Ingestion accounting comes from the existing trusted usage callback plus a final-settlement
observer, not invented canonical events or parsed diagnostics. Callback errors remain isolated;
unknown/missing final usage stays partial. The actual existing ingest source directory override
is supplied from the runtime's SessionStore path. Child work, compaction and untracked dream
work keep total coverage partial; known cache pricing follows existing provider rates. A nullable
session ID means no usable run result was returned, not proof that no session ever started.

## Gates

Actual CLI/local provider/ingestion/storage and actual startup/controller/Ink frame
controls; failure/maintenance, heartbeat quiet/failure, concurrent append/ack,
retention/corruption/symlink, usage/cost, cancellation/dedupe pairs. Named removed
report, acknowledgement-bound and ingestion-wiring mutations must fail and restore.
Build/typecheck/full tests, exactly one bounded Claude review with original findings,
material fixes, updated-main exact-head three-platform CI, root merge and post-main
CI. No daemon, new maintenance engine, R8 or R15i scope.

## Recorded checks and review

- Pre-review build/typecheck passed; full suite 2,652 passed plus two skips / 153 files,
  four workers, 37.32 seconds. 123 focused tests cover actual local CLI/provider/ingest and
  actual startTui/App/Ink output, not a command-wiring-only mock.
- One bounded independent Claude review **APPROVE**, session
  `fc922d93-97a3-45b2-88e7-500775eb376b`, 293,941 ms. It reported 41 turns despite
  24 requested; no enforcement of the requested cap is claimed. Independently 123 focused
  tests and typecheck. A fetch-containing compound command was denied; review used cached
  main `f3a1ec8`, not the later integration head. [Original response](R7c-review.md) verbatim.
- Review low finding 2 exposed a contract wording mismatch: pruned history led with literal
  zero before its caveat. New exact unknown-count assertion failed before and passed after;
  retained failures with omissions are now a lower bound. Artifacts
  `/tmp/r7c-review-wording-{before,after}.log`. No second broad review.
- Five named mutations failed and were restored: omitted CLI receipt (missing schedule.log),
  acknowledgement advanced to latest rather than displayed cutoff (new failure disappears),
  disabled scheduled ingest (one provider call rather than two), omitted actual source root
  (custom memory receives no actual log), omitted uncertainty marker (missing durable warning).
  Artifacts `/tmp/r7c-mutant-{receipt,ack,ingest,source,uncertainty}.log`; all 123 focused
  tests pass after restoration. These do not measure model judgment or semantic wiki quality.
- Initial full-test failure was only the new uncertainty frame assertion's line wrapping;
  normalizing whitespace retained the exact words in actual rendered output. No production
  behavior or timing threshold changed. Updated-main final checks/CI are recorded in the PR.
- Integrated R10c main `7b6cb6a` (post-main CI `34044235154`, all three green).
  Combined build/typecheck/full: 2,674 passed plus two skips / 154 files, four workers,
  38.23 seconds; 123 focused pass again. Only documentation merge conflicts; both row
  records and CI groups are retained. No second review for mechanical integration.
