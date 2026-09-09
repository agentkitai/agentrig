# R17g memory follow-ups

This package batch starts from main `4c82ebb` after R17f. Codex implemented it in the
user-authorized parallel worktree; root records the AgentRig driver limitation and
delivery receipts. No live provider, historical evaluation retuning, or new issue
was used. Supervisor-owned additive core `AuxiliaryCall.state` schema and type
support must land before this batch. Legacy outcome values and records remain valid.

The entire ROADMAP END queue and `/var/tmp/agentrig-r17g-inventory.md` were inspected.
The following table disposes each memory fragment separately; cross-package items
are assigned to their existing package batch, not silently claimed complete here.

| END fragment | Disposition and evidence |
|---|---|
| Persistence #130: metadata-skipped merges | Implemented: `dream/apply.ts` records `skippedMerges`; `types.ts`, `dream/dream.ts`, `dream/report.ts` propagate, render and count them. `persistence.test.ts` checks source retention and exact reason; `write-quality.test.ts` checks legacy report compatibility/render/count. Opaque metadata is never merged speculatively. |
| Scheduler stamp-reset diagnostic | Implemented memory-owned seam: `dream/dream.ts:lastDreamAt` appends the existing reset command to non-ENOENT read failures while preserving error identity/code and absent-stamp behavior. `dream-metadata.test.ts` pins the hint and real backup/no-overwrite recovery. Missing-root CLI errors remain CLI-owned; reset never initializes a missing wiki. |
| Persistence: contention guidance | Implemented in `lock.ts`: distinguish a possibly active writer, recommend wait/retry, and require stopping writers before crashed-owner recovery; age alone proves nothing. `dream-lifecycle.test.ts` holds the actual lock and checks refusal. No lock stealing or timeout change. |
| Persistence: append-cache optimization | Declined: `raw.ts` already maintains a bounded disposable index with immutable originals and separate rebuild/query budgets; no measured append bottleneck justifies a second incremental consistency path. `persistence.test.ts` retains scoped queries, torn/corrupt entries and bounded rebuild controls. |
| Persistence: more lock configuration | Declined: store `lockTimeoutMs`, ingest `lockTimeoutMs`, dream `lockTimeoutMs` and per-operation `MemoryLockOptions.timeoutMs` already cover current callers. No demonstrated caller requires another configuration surface. |
| Persistence: simplify legacy extra/opaque API | Declined: `page.ts` keeps structured legacy extras and opaque unknown human metadata for compatibility; removing or redefining either would expand this diagnostic batch into a serialization migration. `persistence.test.ts` pins round trips, omission preservation and explicit clearing. |
| Persistence: supervisor timer ownership | Already delivered by H5d; memory `maintenance.ts` owns call/run timers and cancellation; supervisor owns its lifecycle. Not another timer implementation. |
| R6d: legacy summary duplication on regrowth | Implemented as advisory inspection in `dream/write-quality.ts`: an inferred `Model synthesis:` source line exactly repeating a legacy observed line with the same references is reported without altering either original or its tag. Distinct text/citations do not qualify. `write-quality.test.ts` has matching and differing-text controls; ingest provenance/raw immutability controls remain. |
| R6d: nested handwritten missing-tag noise | Implemented: untagged indented supporting bullets are excluded from the heuristic; top-level untagged claims still report. Tagged facts retain all other checks. `write-quality.test.ts` covers spaces/tabs and a positive parent. This is heuristic review guidance, not provenance inference. |
| R6e: missing assessor credentials versus adverse judgment | Credential construction belongs to CLI; root owns its fixed unavailable diagnostic. Memory skipped refinement now explicitly identifies an absent provider as unavailable with no adverse claim judgment. `procedures.test.ts` exercises absent provider; effect receipts still distinguish unknown from deny. |
| R6e: duplicate CLI pre/post-assessment output | Assigned to root's CLI batch (`memory promote`); memory has no CLI preview sequencing. |
| R6e: 1,000-character rationale cap | Implemented in `dream/guardrails.ts` assessor instructions: 1–1,000 characters after trimming, whole assessment rejected rather than truncated. `promotion-guardrails.test.ts` checks prompt disclosure and 1,001-character rejection. Existing fail-closed one-call dream budget preserved. |
| R6a: skipped refinement | Implemented additive `refinementSkipped` in `dream/procedures.ts`; `dream/dream.ts` names incomplete scan, failed consolidation, structural-only, missing provider or no pages; `dream/report.ts` explains retained unassessed candidates. `procedures.test.ts` covers scan failure, consolidation failure, no provider and structural-only. |
| R6a: primary artifact beside deduplicated sources | Implemented in `dream/report.ts`; `procedures.test.ts` asserts primary artifact and retains exact deduplication/witness controls. |
| R6a: common-family matching before slicing | Declined: no measured false-negative case supplied; the current per-claim exact runtime witness and shared-family gate is conservative. `procedures.test.ts` retains independent/single/fork/copied evidence, fake receipts and unrelated support controls. Rearranging witnesses to improve counts without a real coverage example is unjustified. |
| R6a: observed-only dialect | Declined: existing stated/observed/inferred tags remain advisory; no consumer requiring observed-only syntax was introduced. Exact runtime evidence remains mandatory independently of tags. |
| Windows replacement: mockable platform probe docs | No refactor was needed. `store.ts` imports `node:os.platform`; `windows-memory-replace.test.ts` explicitly mocks it for Windows retry and Linux/macOS no-retry controls. That is the probe seam, not a claim about an actual Windows lock owner. |
| Windows replacement: 250 ms tuning | Declined: no measured retry-window failure supports changing the bound. Existing access-error retries, cancellation and old-target preservation tests remain unchanged. |
| R6b: session-count cap | Already delivered in PR #220: `dream/skills.ts` refuses more than 128 distinct references; `skill-emission.test.ts` checks 128 accepted/129 refused and duplicate normalization. |
| R6b: occupied/empty directory recovery | Implemented in `dream/skills.ts`: stop writers, inspect the named directory, remove manually only if empty, retain foreign contents. `skill-emission.test.ts` checks no writes and recovery hint. No force overwrite or cleanup automation. |
| R6b: model rejection alongside changed digest | Implemented in `dream/skills.ts`: retain primary digest refusal and append actual fresh model rejection or refinement failure. `skill-emission.test.ts` checks unsafe/nonrepeatable review plus changed digest and no emission; stale reports never authorize writes. |
| R6c: literal-generated schema gate comment | Assigned to core owner; the gate and marker propagation live in core skill loading, outside this package. |
| R6c: TUI/resume option-key tests | Assigned to root CLI batch; resolved roots and permission separation remain its contract. |
| R6c: empty memory paths | Declined compatibility change: empty CLI spelling is a caller path-resolution choice, not a memory store security repair. No scope evidence warrants changing that existing interpretation here; CLI owns any future explicit change. |
| R6g: fully sanitized-away hints, first entry/example accounting | Assigned to core owner: prompt skill hint selection/sanitization is core, not memory. Root confirmed ownership. Total cap and first-entry admission remain unchanged. |
| Auxiliary #131: neutral pending state | Implemented memory alignment: `maintenance.ts` marks running then settled while preserving outcome/usage; shared formatter renders any running call as unfinished even when the outer flag is omitted. `ingest-lifecycle.test.ts` observes gated pending state and both completion/failure, plus neutral/settled/legacy rendering. Shared optional core schema/type is supervisor-owned. |
| Auxiliary #131: explicitly undefined limits | Declined compatibility change: validation currently rejects explicitly undefined values before work. Silently supplying defaults could conceal malformed trusted caller configuration; no caller needs that behavior. Omitted fields continue using defaults. |
| Maintenance timeout #275 | Already delivered by PR #287: `maintenance.ts` names operation, per-call limit and overall budget; `ingest-lifecycle.test.ts` preserves partial usage and exact timeout controls. No historical cause inferred. |
| Checkpoint/session-end memory #235 | Broad integration declined in this batch: deciding whether undo reverts maintenance needs exact writer ownership/quiescence and recovery semantics. Memory changes here never adopt unrelated wiki edits or broaden exclusions. Existing refusal diagnostic delivered (#247); bounded replay follow-up belongs to root/core/CLI. |

Validation uses frozen dependencies and private `TMPDIR=/var/tmp/r17g-memory-test.GkOiOi`.
Fixture preflight verified every ancestor through `/`; no foreign marker was removed
or bypassed. Six new behavioral assertions failed against the original implementation
(metadata merge, nested lint, procedure display, two model/digest refusals, occupied
directory recovery), then all 67 focused tests passed after implementation. Additional
refinement failure, rationale boundary, lock contention and call-state controls are
included. Final build/typecheck/package results and mutation receipts follow below.

Final local verification: `pnpm build` and `pnpm typecheck` passed for all four
packages; `pnpm exec vitest run packages/memory/test` passed 647 tests in 29 files
with two existing platform-gated skips (649 total). `git diff --check` passed.
The shared core schema/type prerequisites are supervisor commits `2c2fbf8`,
`64e7c49`, `7c11e4e` (cherry-picked here solely to verify integration).

Two temporary production mutations were tested and restored: disabling the opaque
metadata merge guard failed the retained-source test (1 failure/13 passes); removing
the running-state renderer check failed the neutral pending-output test (1 failure,
50 unrelated tests filtered). The final full memory run above used restored code.
Those controls establish discrimination for the stated behavior, not semantic
correctness of model judgments or untested host platforms. Root owns bounded
independent review, exact-head/full CI, sequential merge and post-main verification.

Root then assigned the memory-owned stamp-read hint. Its new oversized-stamp
assertion failed before the change and passed afterward; 38 metadata/runtime tests,
memory build/typecheck and diff whitespace checks passed on that final delta.

Independent review: Claude `8cf96304-d4bf-42b3-9635-2c2e1cfba7db` and Codex
`01a08777-3df9-72d2-bf13-0dffa43f7e4d` returned clean on `98a0358`.
Claude independently passed build/typecheck and package suites; Codex passed
static/type checks but could not pass fixture preflight in its sandbox, which is
not claimed as behavioral execution. Optional notes did not identify a product
defect: schema/state producer coverage belongs to prerequisite PR #291; direct
producer and renderer coverage exists without a new model-consolidation end-to-end
case. No unrelated silent-merge redesign or cosmetic review round was added.

After PR #291 merged, its three temporary prerequisite cherry-picks were dropped
and the two memory commits rebased unchanged (range-diff equality) onto `528ee21`.
The integrated build/typecheck and full suite passed **3618 tests / four existing
skips / 233 files**. Landing head, exact-head and post-merge CI receipts belong to
the delivery PR; local results do not imply hosted checks have already passed.
