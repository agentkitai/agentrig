# H5c2b — full dream lifecycle and auxiliary accounting

Starts from updated main 3e97b65 after PR #126 and green main CI 33966024863.

- Reuse H5b2 MaintenanceRun for a linked overall deadline, bounded model calls/input/output/events,
  provider cancellation and honest usage snapshots (missing/retried/abandoned usage stays unknown).
- Thread the linked signal through scans, lint, regeneration writes, pin/index/log updates and
  scheduling stamps. Never race local writers or release a lock while its work is still running.
- Put opt-in automatic apply inside the SDK lifetime; CLI/TUI/hooks use that same operation.
  Incomplete scans or failed consolidation cannot auto-apply. Before the first swap cancellation
  stops work; after it, finish or restore the original regardless of a late abort.
- Return auxiliary accounting and deliver it on failures through a diagnostic callback. A callback
  cannot turn a completed mutation into an apparently uncommitted failure. Name retained artifacts
  on apply/cleanup failures; cleanup touches only owned directories and does not use an aborted signal.
- Configure lifecycle and scan limits across standalone dream, memory lint, interactive TUI and
  scheduled hooks; propagate SIGINT/hook cancellation and surface auxiliary usage in the proper UI.
- Tests use deterministic stalled providers/iterators, late output/usage, phase/commit cancellation,
  real file/lock boundaries, repeat cleanup and callback failures; Node 22 plus all platform gates.

Filesystem syscalls, synchronous JavaScript and uncooperative external processes are not hard-
preemptible. Cleanup and an already-started live swap can exceed the work deadline to preserve data.
No live provider/spend is needed for validation. Explicit crash recovery remains H5c2c, lossless
legacy regeneration and scoped attempt indexing H5c3, durable cross-session usage aggregation H5d.

Implemented API: `runDream({ limits, signal, autoApply, onUsage })` returns `auxiliary` and an
optional `autoApply` applied/refused result (including backup on apply). The narrow `WikiDreamer`
remains review-only and returns additive accounting. `consolidate()` is bounded independently too.
Defaults: 300s total work, 30s per model call, one model call, 65,536 input/output characters and
4,096 stream events. Dream requires an explicit end_turn; absent/non-success stops and malformed
JSON cannot become an automatically applied structural fallback. Retry/malformed/synthetic/missing
usage stays unknown; nonzero-call cost is null without pricing, zero-call structural work is free.

`dreamLimits` / `--dream-limits` and `dreamScanLimits` / `--dream-scan-limits` reach standalone dream,
memory lint, run/resume/TUI scheduled hooks and interactive /dream. SIGINT and TUI abort/shutdown
join the running operation/cleanup; overlapping interactive dreams are refused. Scheduler cadence
reads use bounded scans and the outer hook signal; the dream's work deadline starts at runDream.
Successful returned review artifacts intentionally outlive that deadline. Callbacks/cleanup are
not model-work budgets; accounting callbacks are isolated from throws and asynchronous rejections.
`localCommitState` describes maintenance writes (artifact and scheduling metadata, plus an optional
live swap), not a multi-file transaction or a claim that every failure changed the live wiki.
