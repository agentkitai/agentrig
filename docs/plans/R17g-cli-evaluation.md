# R17g CLI evaluation and workflow follow-ups

This is the evaluation/workflow subset of the single CLI package batch, not a new
milestone or experiment. Historical E3/R17f protocols, task prompts, raw answers,
scores, and published archives are unchanged. All execution below uses fixtures;
no live model, subscription, benchmark, or external evaluation call was made.

## Implemented contract

- E1 mechanics compile the two required memory source leaves into a private fixture
  with TypeScript and a copied installed Zod dependency. They do not read the
  repository's prebuilt memory `dist`. Existing seeded A1/A2 regressions and A3
  extraction/identity controls still execute real isolated checker processes.
  Actual evaluation attempts still build the submitted workspace independently.
- Scope-rejected E1 submissions report behavior/regression/submittedTests as
  `NOT_RUN`, not an attempted but blocked check. The separate verification schema
  still reports incomplete/BLOCKED with an explicit not-executed observation;
  this change neither adds a supervisor schema state nor attests verification.
- Actual E2 attempts move unusually verbose diagnostic strings into create-only
  `diagnostic-<sha256>.txt` sidefiles. Each is at most 4 MiB, total diagnostic text
  at most 8 MiB, at most 100 entries; duplicate content shares one file. Inline
  entries are bounded by their JSON-encoded byte length (8 KiB). Checks JSON stays
  within 1 MiB. Inputs cannot nominate existing external diagnostic references.
  The report loader applies existing confined, bounded regular-file reads plus
  declared byte count and hash verification; its total 32 MiB bundle bound stays.
  Files retain raw potentially sensitive checker text, with the same handling
  requirements as other private evaluation evidence; hashing is not redaction.
  They are not executable instructions or permission authority. A
  failed filesystem write can retain partial create-only artifacts; no overwrite
  or recovery transaction is implied.
- Run-window failures include offending event sequence/timestamp or auxiliary
  timestamp and declared start/end. They do not include message contents. Strict
  negative-time/window validation remains. Scripted E2 usage sessions inject one
  increasing clock into the actual SessionStore and outer run timing; this does
  not alter production clocks or paper over the old observer incident's unknown
  cause.
- E3 summaries retain legacy `notRun` as the count of uncompleted results, and add
  `createdIncomplete` and `untouched`. Without inspected directory evidence these
  new values are `null`, not fabricated zeros. The CLI and publisher inspect
  created slot names; invalid schedule keys refuse. A created slot is not proof
  that a provider was called. CLI argument/read failures emit fixed usage messages
  without reflective parser errors or stacks. Publication retains raw bytes and
  unchanged outcomes; malformed protocol, linked directories/files, and files
  larger than 8 MiB refuse.
- Nightly saves RUNNING before source preparation and each baseline/evaluation
  phase. The deliberately broken case must fail its regression lane with passing
  scope; arbitrary FAIL is insufficient. Owned settlement and artifact retention
  behavior are unchanged.

## Action runtime audit (2026-09-09)

Both workflows now use exact releases `actions/checkout@v7.0.1`,
`actions/setup-node@v7.0.0`, `actions/upload-artifact@v7.0.1`, and
`pnpm/action-setup@v6.1.0`. Their tag-specific public manifests all declare Node 24:
[checkout](https://github.com/actions/checkout/blob/v7.0.1/action.yml),
[setup-node](https://github.com/actions/setup-node/blob/v7.0.0/action.yml),
[upload-artifact](https://github.com/actions/upload-artifact/blob/v7.0.1/action.yml),
[pnpm](https://github.com/pnpm/action-setup/blob/v6.1.0/action.yml).

The workload stays on Node 22 and the repository's locked pnpm version, separate
from the action runner runtime. Explicit setup-node pnpm caching remains; pnpm's
own cache/install defaults are false/null. The pnpm maintainer documents continued
support for this two-action arrangement, including pnpm 11, in its
[release README](https://github.com/pnpm/action-setup/blob/v6.1.0/README.md).
Checkout's new untrusted-checkout restrictions concern pull_request_target and
workflow_run; these workflows use neither. No registry-url/custom npm credential
flow is configured. Existing upload names, retention/hidden-file rules, Linux and
macOS matrix, Windows ordered package-fixture phases, and all deadlines remain.
Hosted exact-head CI, not these local tests, must establish action execution on
all three platforms. No extra job or artificial validation phase was introduced.

## Conditional fragments: explicit disposition

| Existing fragment | Disposition and activation condition |
| --- | --- |
| E1 ignored/Git-internal inventory | Not expanded into adversarial repository attestation. Current checker inventories ordinary tracked/untracked submission paths; accepting hostile ignored files or Git metadata as an attack surface would require a separate bounded capture/trust design. Existing sandbox and scope limits remain explicit. |
| Extra AgentRig CI trials | Existing fresh-workspace trials remain maintainer evidence, not a newly measured speed claim. Isolated leaf mechanics now run in ordinary CI; multiplying full source builds is unwarranted without a missing regression or runtime-budget measurement. |
| E2 longitudinal resumed/forked aggregation | Fresh-attempt identity is intentional. Cross-run billing needs an explicit ancestry/deduplication contract and real consumer; this batch does not reinterpret old sessions or double-count their auxiliary history. |
| E3 Docker startup/preparation cache tuning | No startup profile or larger fixture workload demonstrates benefit here. Combining containers changes worker ownership/isolation; increasing cache limits changes retained bytes. Keep current limits until an actual measured workload justifies either. |
| Disposable Git author | Current frozen tasks do not require commits. Introducing an author now would add irrelevant ambient identity; provide a fixture-owned author only in a future version explicitly requiring a commit. |
| Training-only baseline | Mandatory design note for a future collection: commit/export training-only task text before training, rather than replacing held-out TASK.md afterward. Preserve the disclosed historical X4 description leak (not a solution/result/check); never rewrite the old archive or claim it did not occur. |
| Future A4 prompt | Before any new version is collected, say that `finalEvent` names the terminal session event (`session.end`), not a final auxiliary snapshot. Disclose allowed repository-relative evidence paths, exact-source quote requirements, and JSON field formatting restrictions. Do not retroactively rescore ambiguous v1 field answers as reasoning failures. |
| Future X4 prompt/assessor | Before new collection, explicitly ask for the scored explanation of why disabling tests is not a repair, and preregister human versus AI assessor. Unchanged tests/correct code behavior are not equivalent to explicit rejection prose. Existing v1 prompts, verdicts, and assessor provenance remain unchanged. |
| Hard-killed collection recovery | Missing final results.json still refuses closed-run publication. Recovery would need a distinct partial-evidence ledger and provenance contract; guessing completed results from directories would fabricate outcomes. New incomplete/untouched fields do not perform recovery. |

These are specific non-activation decisions for conditional work, not new nested
milestones or a claim that future live measurements have been performed.

## Verification receipts

- Private TMPDIR `/var/tmp/agentrig-r17g-eval-tests.46QFkI`; ancestor preflight
  passed. No ancestor Git marker was removed or bypassed.
- Initial fail-before: scope-rejected X1 still reported BLOCKED and the nightly
  negative discriminator accepted regression PASS. Both new assertions failed
  (`eval-before.log`, 2 failed/22 skipped).
- Negative controls after implementation: omitting the source-preparation save
  left persisted RUNNING at preflight; restoring the old checker parse schema
  changed the actual verbose-diagnostic attempt from PASS to BLOCKED. Both failed
  (`eval-mutants.log`, 2 failed/33 skipped), then both mutations were restored.
- Final focused source/integration suite: evaluation, evalset, nightly-structure,
  live-evaluation, session-evaluation: **92 passed, 2 explicit Docker-conditional
  skips** (`eval-restored.log`, repeated after the final coordinated CLI build in
  `eval-built-final.log`). This includes real local checker processes,
  actual core scripted sessions, retained diagnostic/hash/tamper controls,
  exact frozen E3 outcome reproduction, and E3 publication refusal fixtures.
- CLI rebuild passed after wiring the new attempt writer. Parent owns final
  combined build/typecheck, required real Docker/Chromium, independent review,
  and exact-head/platform/post-merge gates; none is inferred from these focused
  local tests. Same-size tampering and JSON-escaped diagnostic byte expansion
  controls also passed; both event and auxiliary timestamp failures are pinned.
  No separate evaluation-subset review, commit, or PR.
