# H5 auxiliary lifecycle closure

Fresh branch from updated main 661634a after PR #130 exact-head CI 33972036578 and
post-merge main CI 33972161624 passed all three platforms. This is the existing H5d row,
not another nested milestone. E1 follows its completion.

Acceptance:

- Reviewer/grader SDK calls have bounded input/output/events/deadlines, cooperative cancellation,
  prompt return from uncooperative providers, and explicit reported/unknown auxiliary usage.
- Attach/detach and session completion cancel pending loaders and reviews. Late work cannot
  steer an ended session. Cancellation does not wait indefinitely for an iterator's cleanup.
- Add validated auxiliary snapshot records to the event spine and render them separately from
  main-agent usage. Provisional records preserve unknown consumption if a session closes before
  a final report; no record may be appended after `session.end`.
- Preserve core-types-only imports in supervisor and memory; no new shared runtime framework.
- Finish already-listed asynchronous diagnostic isolation, tolerant recall routing and late-TUI
  shutdown handling. Do not add UI polish or a general observer/extension architecture.

Gate: focused real-session regressions and negative mutations, build/typecheck/full Node22 suite,
bounded independent Claude review with delegation disabled, exact-head PR CI, merge and main CI.
Small optional improvements go at the END of ROADMAP and are not new prerequisites.

## Implemented boundaries

Reviewer/grader methods accept per-call `AuxiliaryOptions`; constructor defaults may supply
limits/callbacks too. Their signals combine. Defaults: 90 s total, 30 s per model call, one call,
32,768 total prompt characters (including system text), 65,536 output characters and 4,096
model events. Existing prompt/artifact presentation limits remain. Successful model completion
requires `end_turn`; malformed JSON still gives no reviewer guidance or a failing grade. This
is not an assertion that a parsed grade is objectively correct; E1 supplies independent checks.

SDK usage callbacks receive a detached final report on success and failure. Cumulative provider
snapshots replace earlier snapshots; retries, absent/synthetic/malformed usage and abandoned
calls retain unknown-total status. No pricing is invented. Timers/listeners close on settlement;
an uncooperative iterator's `return()` is requested but never awaited indefinitely. Synchronous
JavaScript that blocks the thread cannot be preempted, and remote work may ignore cancellation.

Core supplies optional `SessionControl.auxiliarySignal`, cancelled when main work enters shutdown
or the user aborts, without cancelling independently budgeted session-end memory hooks. Older
custom Sessions fall back to `session.done`; they can implement the signal for earlier shutdown.
The observer uses the tighter of `reviewTimeoutMs` and `auxiliaryLimits.timeoutMs` across
attempt/artifact loading and the review/grade. Detach also
cancels idle waits and pending work. No late result may steer after the observer lifetime closes.
Opaque custom reviewers are conservatively one unknown auxiliary operation unless they provide
reports; a loader cancelled before invoking them remains zero calls. No runtime dependency on
memory or core internals was added to supervisor; the bounded runner remains package-local.

`auxiliary.usage` is a validated event carrying a run ID, cumulative report and `final` flag.
Snapshots replace by ID, never add, and never contribute to main `model.response` totals. A
provisional record is durable before external work; if a session closes before final accounting,
the last snapshot explicitly remains unknown. Core still rejects all records after `session.end`.
CLI/TUI render final reports and warn about unfinished snapshots at session end; raw JSON/trace
consumers can reconstruct both. This does not yet aggregate/pricetag all memory hooks and provider
roles into evaluation reports: that is the already-planned E2 measurement work.

CLI/TUI shutdown detaches and joins the supervisor. A closed TUI ignores late diagnostics and
new submissions. Tolerant recall errors use the configured diagnostic channel. Async diagnostic
rejections in ingest, memory hooks, tolerant backends and supervisor reporting are isolated from
the work's outcome. No extra UI feature or general extension lifecycle was introduced.
