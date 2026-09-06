# R7b — bounded advisory heartbeat fallback

R7a and its test-only repair are fully gated on main `90301f8`, post-CI
`34040182760`. R10b main `9294681` is integrated; post-main CI `34040691166` is green.

## Contract

`schedule tick` previews; only explicit `--execute` under the existing canonical
project trust decision may launch a heartbeat. Read literal canonical-root
`HEARTBEAT.md`, at most 4096 UTF-8 bytes, regular file only, no symlinks or
interpolation. Missing means no fallback; unsafe/oversized/invalid UTF-8 input
refuses rather than truncates. Existing cooperative filesystem race limits apply.

Only a minute with no matching scheduled cron gets a fallback, including when
matching entries were already claimed: a repeated tick must not add heartbeat
work after ordinary due work. Reuse the existing exclusive lock and an additive
bounded heartbeat minute claim. At most one heartbeat per UTC minute, no catch-up
or silent retry of claims. Distinct runtime source metadata separates heartbeat
from an ordinary entry whose ID happens to match its display name.

Trusted `heartbeatMaxTurns` config accepts an integer from 1 to 50, default 5.
Whitespace-empty checklists force exactly one tool-free model request/turn, with
an actually empty runtime registry even if a provider fabricates tool calls.
Nonempty checklists use the configured turn bound. Main requested tokens are
10,000 and minutes five, matching bounded scheduler defaults. These are existing
cooperative runtime limits, not hard monetary caps or remote cancellation proof.

Heartbeat text stays advisory project content and cannot clear the external-input
restriction or mint grants. Suppress explicit/discovered extensions, skill and
package roots, MCP, subagents, memory maintenance, checkpoints and supervisor
side effects at real builder boundaries. Ordinary runs retain existing behavior.
Heartbeat uses the built-in shell default rather than a custom configured shell;
its main provider selection remains configured, but unused auxiliary roles are not constructed.

An empty/no-action fixture produces no task/wiki/report artifacts. Normal immutable
session log, derived resume cache and bounded operational claim stamp are allowed;
they are not task artifacts. Nonempty applicability is model judgment, not semantic
verification. No R7c schedule log/banner/ingestion, daemon or R15i ledger; unattended
execution remains opt-in.

R7c extension: successful heartbeat keeps that quiet profile. Failed/budget/aborted heartbeat
may persist bounded operational failure accounting and an uncertainty marker for next-start
visibility, never task/wiki artifacts or automatic maintenance. Acknowledging a banner does
not restore permissions, replay a run or silently clear missing-receipt uncertainty.

## Evidence gates

Actual CLI→runCommand→local adapter/storage tests cover empty one-turn behavior,
artifact differences, malicious explicit/configured extension and maintenance
canaries, nonempty bounds, provenance denials, due/deduplication, cancellation and
unsafe files. Named removed-empty-registry, removed-side-effect-suppression and
removed-heartbeat-claim mutations must fail and be restored. Build/typecheck/full
tests, one bounded independent review with original findings, exact-head
three-platform CI, root merge and post-main CI precede completion.

## Recorded verification

- Build/typecheck and full suite: 2,634 passed plus two skips / 151 files, four workers,
  39.26 seconds before review; final restored-source build/typecheck/full passed the same
  counts in 37.35 seconds on updated main `9294681`.
- 28 focused tests pass (8 heartbeat + 20 scheduler). Actual CLI uses only a local SSE
  fixture through the real OpenAI adapter; no credential or live model spend.
- `removed-empty-registry`: builder test fails with nine built-in tools instead of `[]`.
- `removed-side-effect-suppression`: both actual CLI fixtures fail before the expected request
  because forbidden configured setup is no longer suppressed.
- `removed-explicit-extension-suppression`: keeping just the explicit extension path causes
  actual extension loading/import canary to violate both CLI fixtures independently of MCP.
- `removed-heartbeat-claim`: repeated tick returns heartbeat again instead of no work.
  Each mutant failed, was restored, and all 28 focused tests passed afterward. Artifacts:
  `/tmp/r7b-mutant-{registry,suppression,extension,claim}.log`.
- One bounded independent Claude review **APPROVE**, 20/24 turns, independently 28 focused
  tests and typecheck, no denied commands. [Original response](R7b-review.md) retained verbatim;
  optional render coverage added, remaining polish at roadmap end. No second broad review.

Declared checks establish mechanics and bounds, not real-model checklist judgment or a
monetary cap. Original R7a post-main failure remains failed; repair #178's green main restores
the continuation gate rather than retroactively relabeling that run.
