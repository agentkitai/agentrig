# E2 — compact outcome reports

This read-only reporter consumes an **evaluator-owned evidence bundle**. It is not a live-run
driver or model grader. Scripted and live evidence lanes are explicit; scripted PASS demonstrates
mechanics, not real-model performance.

```sh
pnpm build
node eval/report.mjs /absolute/path/to/run/manifest.json
node eval/report.mjs /absolute/path/to/run/manifest.json --text
# Synthetic negative control: expected exit 1 / FAIL despite agent reason done:
node eval/report.mjs eval/fixtures/report/manifest.json --text
```

Exit 0 means PASS or pre-run SKIP, 1 independent FAIL, 2 BLOCKED or invalid/unreadable bundle.
Inspect the JSON outcome: SKIP is not PASS. The command only writes stdout; no logs are rewritten.

## Bundle and trust

`EvaluationManifest` in `packages/cli/src/evaluation.ts` defines the schema. The checked-in
example's all-zero evaluator SHA, timestamps, prices and outcomes are deliberately synthetic.
For a real attempt, record exact evaluator/starting Git SHAs, E1 run UUID/task ID, role/provider/
model configuration, budgets and frozen corpus hash. Checks must match the run UUID and task.
Keep the bundle outside the model's workspace; do not put credentials in labels/configuration.

Loaded paths (logs, checks, auxiliary file) are relative to the canonical manifest directory;
absolute paths and canonical escapes are refused. Limits: 256 KiB manifest, 1 MiB checks, 8 MiB
per log/auxiliary file, 32 MiB total, 100,000 events per log, 64 logs. Only regular files are read.
Corrupt/unterminated logs, wrong IDs, sequence gaps and events after session.end are rejected,
not silently skipped. Use closed immutable bundles; this is not OS isolation against hostile
concurrent filesystem replacement.

Loaded files receive SHA-256 hashes. Large check diagnostics stay in the hashed check file, not
the compact report. Timing/coverage/diff/human evidence references are preserved as **evaluator
attestations**, not authenticated or reconstructed by the reporter. Retain those artifacts too.
Calling model-authored evidence “independent” does not make it trustworthy.

E2 handles fresh E1 attempts, not resumed/forked histories. Include one main session and each
spawned child's own log tagged `subagent`. Parent references must agree; duplicate logs fail.
Missing children or unfinished sessions make aggregate coverage unknown. A pre-run SKIP needs a
reason and no logged work. Broader history aggregation is not a prerequisite for fresh E3 runs.

## Outcomes and changes

Agent end reasons never decide success. Behavior, regression and scope must each PASS; submitted
tests must PASS or be NOT_REQUIRED. Explicit FAIL, any failed lane, independently discovered
unintended changes or a human FAIL cannot be promoted to PASS. Missing evidence remains BLOCKED.
For A4/X4 retain automatic BLOCKED output and add a real `humanVerdict` (`assessor`, PASS/FAIL
`outcome`, `reason`, `evidence`) after rubric assessment. That resolves only pending prose review,
not failed automatic checks.

`changes.independentlyChecked` and its unintended-path list come from independent diff/artifact
review, not `file.changed`: shell side effects need not emit file events. Event paths are labelled
as observations only. Preserve E1's scope-check limitations and external-action restrictions.

## Usage and pricing

Optional `model.response.usageComplete` distinguishes genuine provider-reported zero from absent
usage. New core logs set it true only after non-synthetic usage and an explicit non-error stop,
without retries. Legacy absence, synthesized counts, unclosed streams and retries remain unknown.
Aborted/thrown calls without a response remain unknown requests; unlogged partial counts cannot
be recovered. Retries add unknown attempts, never assumed free calls.

Main plus child calls form one labelled aggregate, with per-role breakdown. Supervisor/memory/
compaction/other receipts stay in auxiliary totals. Input, output, cache-read and cache-write are
disjoint. Reported counts are partial evidence when unknown-call/coverage fields say so.

Supply explicit USD-per-million-token rates per exact role/provider/model: `input`, `output`, and
optional `cacheRead`/`cacheWrite`. Missing nonzero-category rates, model identity, pricing, usage or
coverage make complete cost null. No market price/discount is guessed. `pricedReportedUsd` is
only the priced portion, not a full bill. `coverage.externalCostsUsd` records independently known
non-token/backend charges; null means unknown, not zero. Total cost requires every component.

## Auxiliary receipts

The auxiliary JSON has `{ "snapshots": [], "calls": [] }`.

- `snapshots`: `{sessionId, id, ts, final, report}` using core's `AuxiliaryReport`. Snapshots replace
  by `(sessionId,id)` in timestamp order, never sum. Identical final duplicates are harmless;
  a final wins over a provisional record when their millisecond timestamps tie;
  conflicting final reports fail. Totals/unknown counts must agree with calls. Unfinished runs
  retain unknown total consumption even when their observed portion is priced.
- Supervisor events already carry IDs. **Do not copy `onUsage` callbacks into new IDs** and
  double-count the same operation. Sidecar completion of an event-observed run keeps its actual
  ID. Assign new IDs only to genuinely separate memory operations collected through ingest/dream
  `onUsage`; keep late final receipts in the sidecar, never append to a closed session log.
- `calls`: `{id, role: "compaction" | "other", call}` for provider work absent from events.
  `call` is an `AuxiliaryCall` with operation/provider/optional model, outcome, durationMs,
  optional usage and usageComplete. IDs are unique per actual call. Retries/failed requests need
  their own conservative accounting; final-response usage alone is not an operation's full bill.

The existing CLI log is **not a universal recorder** of memory hooks, compaction, backend charges
or arbitrary SDK code. The evaluator must wire callbacks/provider wrappers into these receipts
and retain a coverage attestation. Until that collector actually covers the selected configuration,
set `coverage.auxiliaryComplete: false`. Missing sidecar data stays unknown even if the boolean
was accidentally true. A truly collected no-work run supplies an explicit empty sidecar and
complete-coverage attestation. Never backfill missing instrumentation with empty arrays and zero.

## Wall time and activity

Measure `timing.startedAt` before session start and `settledAt` after session, observer handle
(`detach()`/`done` as appropriate), maintenance and local cleanup settle. Set
`includesObserverAndMaintenance` true only for that interval; otherwise wall time is null.
Event-span duration is partial evidence, not end-to-end timing. All events/snapshots must fall
inside the declared interval. Local settlement does not promise remote abandoned calls stopped
billing. Overlapping durations are not added or called causal supervisor overhead; E3 compares
inclusive wall time across configurations.

Counts are literal: permission requests and allow/deny decisions (not necessarily distinct human
approvals), failed tool results, tool denials, errors, interventions, memory-search requests and
successful tool results, and memory-read requests. An empty successful search is not a recalled
fact. Child logs can contain delegated permission observations too. Independent task outcomes,
not activity counts, establish whether memory/supervision helped.
