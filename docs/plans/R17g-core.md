# R17g — core package follow-up batch

One batch over `packages/core/**`, based on merged R17f (`4c82ebb`). Every core END group and every
remaining core fragment recorded below is **implemented** (with its files and tests), **already
delivered** (with concrete evidence), **declined** (with a precise reason), or **out of scope for
this package** (with the owning package named). No row is silently checked off, and nothing here
claims a historical failure's cause.

Builder-only verification before root integration: `pnpm build`, `pnpm exec tsc -p packages/core --noEmit`, and the whole repository
suite under a private `TMPDIR` created with `mktemp -d`, with `node test/fixture-preflight.mjs`
green in that root. Result: **3649 passed, 3 failed, 4 skipped** — the three failures are all one
cross-package assertion in `packages/memory/test/checkpoint-ingest.test.ts`, recorded in
[§4](#4-cross-package-items-not-in-this-diff) with the exact repair, and are outside this diff's
ownership. `packages/core/test` alone is **1404 passed, 0 failed**.
Root's integrated changes and verification supersede that preliminary result in §5 below.

Mutation controls are recorded per row. "Mutant killed" means the production change was reverted or
disabled, the named test failed, and the mutant was restored; the restored tree is what is committed.

## 1. Implemented

| END group / fragment | What changed | Files | Tests | Mutation control |
|---|---|---|---|---|
| **R6g hints** — normalize fully sanitized-away hints to an absent property | A `trigger` whose characters are all stripped or collapsed by `sanitizeLine` (zero-width, word joiner, BEL) passed the manifest's `min(1)` and became `trigger: ""`. Empty is not a shorter hint; the property is now absent, so `fingerprint`, the catalogue line and any `"trigger" in skill` check agree on one shape for "no hint". | `src/tools/skills.ts` | `test/skill-guidance.test.ts` — manual and generated (`metadata.agentrig-trigger`) dialects, plus a surviving hint that still lands | Restoring `hint === undefined ? {} : …` fails `not.toHaveProperty("trigger")` with `""` |
| **R6g byte accounting** — explain the first-admitted entry beside the worked example | Comment at the catalogue cost calculation: the example is charged to whichever entry is admitted first; a candidate that cannot carry both its line and the example is dropped and the next tried; with none fitting the catalogue is header + omission note and no example, never an example naming an unlisted entry. | `src/tools/skills.ts` | Existing `test/skill-guidance.test.ts` "selection guidance accompanies listed names" already pins the oversized-first behaviour (evidence, not new code) | n/a (comment) |
| **R5e skills parser** — absolute-path docs | `DiscoverOptions.roots` documents `resolve()` normalization: relative roots resolve against the harness cwd and never a model-chosen path, two spellings of one directory collapse to one root, and `Skill.path` is therefore always absolute — which is what the shadow diagnostics report. | `src/tools/skills.ts` | — | n/a (docs) |
| **R5e skills parser** — entry cap / `--- foo` / shadow boundary coverage | Boundary tests only; no behaviour change. | — | `test/skills.test.ts`: exactly 1024 root entries loads and 1025 loads nothing (counting non-skill files); `--- foo`, `----` and indented `---` are prose while an unterminated `---` still throws; the shadow diagnostic names loser and winner and omits the ambiguity suffix | n/a (new coverage of existing behaviour) |
| **Repo-map breadth beyond the file-list cap** | A tree that cannot fit is now summarized by directory before being prefix-truncated: files shallower than the collapse depth keep their names, everything below becomes one counted `- dir/: N file(s), not listed` line, and the deepest depth that fits is chosen. Prefix truncation remains the fallback when even the top-level summary is too large. The 8 KiB production budget is unchanged. | `src/repo-map.ts` | `test/repo-map.test.ts`: a 200-file directory is summarized rather than prefixed (and the freed bytes buy signatures); three sibling directories are each named where a prefix would have hidden `zeta/`; a 256-byte budget still falls back to prefix truncation | Disabling the summary branch fails both tests |
| **R5b unsupported callback contracts** | `extensionCallback` now refuses a thenable returned by a synchronously typed descriptor — settling the promise first, so a rejected one cannot become an unhandled rejection naming core — and validates the returned shape. Per-surface validators: `permission` (`PermissionClass`), `paths` (`string[]`), `effects` (enum), `operation` (`ShellOperationSchema`), `hasBackgroundWork` (boolean, conservative `true` fallback), `resultSource.file`/`.external` (string / boolean, conservative `true` fallback), `inputSchema.safeParse` (success implies `data`). Existing throw/disable/receipt behaviour is unchanged. | `src/extension-runtime.ts`, `src/extensions.ts` | `test/extension-failure.test.ts`: six async-implementation cases, six wrong-shape cases, and a rejected-promise case asserting no `unhandledRejection` reaches the process | Removing the thenable check and the validator call fails all 13 |
| **R4a** — file-to-directory diagnostics | The capture loop's directory refusal now names the path and both causes (an uncovered nested repository/submodule, or a tracked file replaced by a directory). | `src/checkpointer.ts` | `test/checkpointer.test.ts` "names the path when a listed file is a directory" | Replacing the message fails the test |
| **R4a** — duplicate-checkpointer configuration error | Two `Checkpointer` instances keep separate leases, so the second reported "another session or retained lock exists" and sent the operator hunting for a stray process. `createAgent` now refuses more than one. | `src/agent.ts` | `test/checkpointer.test.ts` "refuses two configured checkpointers"; one instance still constructs | Disabling the guard fails the test |
| **R4a** — denial on the late-abort path | The post-checkpoint `signal.aborted` return now emits `tool.denied` first, so an authorized call with no result is not indistinguishable from a lost append. | `src/tool-execution.ts` | `test/checkpointer.test.ts` "records a denial when the run aborts after the checkpoint" pins that an abort in this window always leaves a denial receipt. **Coverage limit, recorded honestly:** the specific branch is defensive — through the public agent path the hook runner observes the abort first and denies at its own branch, so the narrow window between the runner returning and this check is not deterministically reachable. No mutation control is claimed for that line. | — |
| **R4a** — localized throwing effect callbacks | A trusted host `effects` descriptor that throws no longer ends the turn: the failure is reported as a non-fatal `error` and the effect falls back to the conservative `"workspace"`, so the checkpoint is still taken and the scheduler still serializes. An extension's `ExtensionHandlerError` is rethrown so its existing disabling receipt path is untouched. `paths` and `operation` deliberately still propagate — falling back to "no declared paths" would silently un-confine a `cwdOnly` rule. | `src/tool-execution.ts` | `test/checkpointer.test.ts` "a throwing effects descriptor is contained" | Rethrowing instead of containing fails the test |
| **R4a** — direct fail-closed hook-runner branch tests | Tests only. Every branch of `runHooks` that can refuse is now reached directly: already-aborted session, spent chain budget, throwing handler, timing-out handler, result with no action, action unsupported at the point, and explicit deny — each paired with its fail-open counterpart. | — | `test/hooks.test.ts` "fail-closed hook runner branches" (7 cases) | Making `failClosed` inert fails 4 of the 5 refusal branches; the handler-failure branch has its own exact-text assertion |
| **R4b** — repeat/already-restored diagnostics | A second undo saw its own restoration as "non-session changes". When the worktree already matches the target checkpoint (and HEAD/index still match the seal) it now says `undo already applied: … nothing to restore`. A genuine foreign change is still reported as one. | `src/checkpoint-undo.ts` | `test/checkpointer.test.ts` "a second undo says the worktree already matches the turn" | Disabling the branch fails the test |
| **R4b / #235** — maintenance-seal wording and bounded refusal replay | When a run has no seal, the refusal now replays the `checkpoint seal failed:` reason recorded at session end and lists the checkpoint references that do exist, explicitly labelled *not restorable without a seal*. Diagnosis only: no seal is inferred, nothing is restored, no exclusion is broadened. | `src/checkpoint-undo.ts` | `test/checkpointer.test.ts` "replays the recorded seal refusal", driven by a real `session_end` hook writing a covered file | Removing the replay lines fails the test |
| **R4b** — executable-bit and deletion round trips | Coverage only. | — | `test/checkpointer.test.ts` "round-trips an executable bit and a deletion" | n/a (new coverage of existing behaviour) |
| **R4b** — directory/file collision | A directory standing where the checkpoint holds a file was reported as an "ignored or unowned path", sending the operator to `.gitignore`. The non-file check now runs first and names the collision. Both orders refuse; only the diagnostic changed, and nothing is restored. | `src/checkpoint-undo.ts` | `test/checkpointer.test.ts` "refuses a file/directory collision as a collision" | Removing the directory clause fails the test |
| **R11b** — 300/304 are not redirects | `300` and `304` get their own refusals; only `301`–`399` keep "request the destination URL explicitly", which for the other two named a destination that does not exist. | `src/tools/web-fetch.ts` | `test/web-fetch.test.ts` "reports %i as itself rather than as a refused redirect" | Folding them back into the redirect branch fails both cases |
| **R11b** — literal `<` in lexical extraction | A `<` that cannot open a tag is text. Scanning it as a tag swallowed everything to the next `>` and, with no `>` at all, discarded the rest of the document. Suppressed script/style bodies still emit nothing. No browser rendering is claimed. | `src/tools/web-fetch.ts` | `test/web-fetch.test.ts` two cases: literal `<` in prose, and a literal `<` inside a script body | Disabling the check fails the prose case |
| **R11b** — dispatcher/proxy trust documentation | A block comment separates the tool's own policy (no cookies, no caller headers, no redirects, no URL credentials) from what it does not control: undici's global dispatcher and Node's opt-in environment proxy are trusted-host configuration, so the tool cannot attest the bytes came from the URL it was given — only that it contributed no credentials of its own. Destination filtering remains the sandbox network policy's job. | `src/tools/web-fetch.ts` | — | n/a (docs) |
| **R12a** — concurrent-drain behaviour under delivered R10b | **Assessed and repaired.** `flush` took a snapshot count on entry, so under R10's parallel tool calls another call's grant landing in the shared queue mid-flush failed the flushing call with "audit changed while flushing" — a refusal for someone else's work. It now drains the queue, bounded by `maxPending`; reaching the bound is still the same fail-closed "retry before dispatch". Nothing dispatches without its receipt logged. | `src/permission-grants.ts` | `test/permission-grants.test.ts`: a grant queued by a concurrent call is drained; a queue that never empties still fails closed after exactly `limit + 1` appends | Restoring the snapshot loop fails both |
| **R12a** — queue-overflow wording | The full-queue refusal now names the depth, the limit and how many receipts the change needed, says nothing queued is discarded, and says explicitly that a queue which never empties is a host that is not draining it — not a limit that is too small. | `src/permission-grants.ts` | `test/permission-grants.test.ts` "the full-queue refusal names the depth, the limit and what actually unblocks it" | Restoring the old message fails the test |
| **R12d** — ignored child registry explanation | A registry configured on a child config is not authority; a child's grants are derived from the parent's live view. With no parent registry the configured one was dropped silently, which reads exactly like inheriting it. The subagent result now says so. | `src/tools/subagent.ts` | `test/permission-grants.test.ts` "says so when a configured child registry is dropped" | Forcing the flag false fails the test |
| **R13c** — failed/aborted approval vs explicit denial | A handler that throws or is aborted produced the same `{kind:"approval-handler"}` receipt as a person answering "no". It is now `{kind:"boundary", reason:"approval-handler-failed"}` (or `"approval-aborted"`), a bounded one-line host-failure detail goes to the log, and the model-visible refusal says "fail-closed … not an explicit denial" without the host detail. The denial, the audit and the non-dispatch are unchanged. | `src/tool-execution.ts` | `test/external-expansion.test.ts` "a failed handler is audited apart from an explicit denial", including the discriminating pair against a real `deny` | Restoring the flat attribution fails both cases |
| **R13d** — observer-order assessment | **Assessed; documented, no API change.** A `pre_model` observer sees the rendered request, and the manifest's authority labels are recomputed after every patch — because a patch is one of the things being labelled. Exposing post-remap labels at that point would let a hook read a label of its own patch. Contributions are `authority: "data"` with the hook as origin whatever the hook returns, so the ordering cannot be used for an upgrade either way. Documented at `HookContext.request` and at the call site. | `src/hooks.ts`, `src/agent.ts` | — | n/a (docs) |
| **R13d** — whole-prompt downgrade documentation and coverage | The arbitrary-rewrite branch documents why the whole rendered prompt collapses to one hook-owned `data` block: after a rewrite there is no way to say which surviving byte came from which source, so per-source blocks would be claims about text the hook may have edited. A loss of resolution, not of authority. | `src/agent.ts` | `test/hooks.test.ts` "an arbitrary pre_model rewrite downgrades the whole prompt" — one block, hook origin, `data`, and the original system-prompt origin gone | n/a (new coverage of existing behaviour) |
| **H7a** — staged nudge vs attempted retry | The continuation message is persisted before the next turn, but `turn.continued` is emitted only for an actual provider attempt, so a budget stop, abort or `pre_model` veto left a continuation message with no attempt beside it — the same log shape as a retry that ran and did nothing. A non-fatal line now names it. No counter is spent, no attempt is claimed, no retry is re-enabled. | `src/agent.ts` | `test/token-continuation.test.ts`: three gate modes report it, and an attempted continuation does not | Disabling the branch fails all three modes |
| **H6** — normalized abort grace at the lifecycle signature | `createSessionLifecycle` documents that `graceMs` is already through `abortGraceOf`: finite, non-negative, and `0` is legitimate and means "do not wait" — which a second `?? DEFAULT_ABORT_GRACE_MS` inside would silently turn into a full second. | `src/session-lifecycle.ts` | — | n/a (docs) |
| **H6** — pointer from the shared replan state to its synchronous clear | `ReplanState` documents that the gate is cleared synchronously by the lifecycle's `onEmit` on `plan.updated` — before the append is awaited and before the emitting call returns — why waiting or making the raiser own the clear would both be wrong, and that `TOOL_EMIT_SOURCES` is what keeps the synchronous clear from being a forgery seam. | `src/tool-execution.ts` | — | n/a (docs) |
| **Child abort-hook timer comments** | The `setTimeout` spy discriminates only on delay; the comment now names the 200 ms timer as the child's `settleOrphans` grace and 400 ms as the parent's, distinguishes both from the subagent tool's grace + half-grace phase cut, and states that any new equal-delay timer in the abort path would resolve the wrong latch and must be reviewed. | `test/subagent.test.ts` | existing suite green (45) | n/a (comment) |
| **R5d** — successful persisted-consent diagnostic | The refusal path was loud and the approval path silent, so an operator who approved a definition change had no receipt that the new baseline became durable. A notice is emitted, labelled consent recorded, not a safety assessment. | `src/mcp/tools.ts` | `test/mcp-pins.test.ts` "reports a persisted approval…" | Removing the notice fails the test |
| **R5d** — friendlier held-lock recovery guidance | An `EEXIST` on the lock directory surfaced as a raw errno. It now names the lock path, states the lock is never stolen or expired, says to stop every writer and remove the directory by hand, and that no consent has been lost. | `src/mcp/pins.ts` | `test/mcp-pins.test.ts` "names the held lock and what actually clears it" — including that the refusal changes nothing and does not steal the lock | Removing the EEXIST branch fails the test |
| **R5d** — bounded pin-read allocation | The read allocated and zeroed 1 MiB + 1 on every tool call. It now sizes the allocation to the file, still reads one byte past whatever it was given, re-reads once at the full cap if the file turns out larger than its own stat, and keeps the hard 1 MiB cap. | `src/mcp/pins.ts` | `test/mcp-pins.test.ts` asserts the cap still binds on an over-length file | Removing both cap checks fails the test |
| **R14a** — shared acceptance formatter | `renderPlanAcceptance` and `renderPlanItems` are exported from core and used by `update_plan`. The wording is a promise about what the harness knows — declared, never evaluated — and it was previously a maintained-by-hand duplicate between the tool result and the CLI renderer. CLI adoption is [§4](#4-cross-package-items-not-in-this-diff). | `src/tools/update-plan.ts`, `src/tools/index.ts` | `test/acceptance-plan.test.ts` mixed-plan case pins both strings unchanged | — |
| **R14a** — quieter summary for entirely undeclared plans | A plan where nothing is declared said "undeclared (unverified)" once per step. It says it once, for all N steps, and still says unverified. A mixed plan is unchanged: no item loses its own line when any item has one. | `src/tools/update-plan.ts` | `test/acceptance-plan.test.ts` "an entirely undeclared plan says so once instead of once per step" | Disabling the branch fails the test |
| **R14a** — less repetitive resumed first-request wording | A resumed conversation that already declared a plan gets a short instruction; the worked examples and field bounds are already in its own history. Every load-bearing clause is retained in both forms: revise before continuing, a check per item, checks are declarations not proof, and this is not consent. The manifest reason distinguishes the two. | `src/agent.ts` | `test/acceptance-plan.test.ts` "a resumed run with a declared plan gets the short instruction" — asserts each retained clause and both manifest reasons | Forcing the long form fails the test |
| **R10a** — reuse the exported call type | `TurnToolCall` replaces the four inline `{ id; name; input }` re-declarations in the coordinator and the tool pipeline. | `src/agent.ts`, `src/tool-execution.ts` | existing `test/turn-strategy.test.ts` / `test/parallel-strategy.test.ts` green | n/a (type-level) |
| **Child grant tests** — name child-view identity | The three views are named and asserted distinct by subject (three equal views would satisfy every predicate while proving nothing), each assertion carries its view's name, and the sibling predicate states that a sibling is a peer of the granting child, not an ancestor of it. | `test/child-grants.test.ts` | itself | n/a (test clarity) |

## 2. Declined, with reasons

| END group / fragment | Disposition |
|---|---|
| **R10b** — replace the 100 ms hazard-mutant window with a bounded internal admission observation | **Declined after building it and observing the failure.** A fixture that waits for a later, independent call to be admitted as positive evidence that the runtime is live rather than slow *deadlocks*: `executeParallel` serializes admission behind the `prepare` mutex, which the held call keeps while it is parked in `admit`, so no later call can reach `prepare` at all (observed: the fixture timed out at 5 s). The only other observation point is the scheduler's internal `active` map, and exposing it would be new production API existing solely for a test — which the roadmap's own condition ("if it can be done without exposing model-controlled metadata") excludes. The window is retained with that assessment recorded beside it in `test/parallel-strategy.test.ts`; the actual overlap and event-order controls are unchanged. |
| **R8c** — empty-HTTP-200 collector compatibility | **Declined, and the decision recorded in `src/otel-exporter.ts`.** Accepting a 200 with no `ExportTraceServiceResponse` would mean counting spans as `exported` on a response that acknowledged nothing — a delivery claim the wire never made — or adding a third public counter dimension for "sent, unacknowledged". The row's own constraint is "no false delivery proof". The conservative reading stays; it remains explicitly *not* a claim that the collector stored nothing. |
| **R10a** — defensive call-array copy for trusted strategies | Declined. The row already records that readonly typing is not claimed as runtime containment of trusted host JavaScript; a copy would suggest containment it does not provide, and no truncated call reaches that seam. |
| **R5e** — reject inline-comment-looking flat scalars | Declined deliberately, as the row invites. `description: hello # comment` is currently the literal string, which is what the bounded subset promises: it is not YAML and does not strip comments. Adding a rejection would make a legal value in the documented dialect an error, and inferring comment semantics is exactly the YAML behaviour this parser refuses to imitate. |
| **R5a** — class-instance registration, oversize partial startup, explicit-path dedupe, extension inheritance | Declined. Each is a deliberate contract choice, not a defect: prototype-defined members would widen the documented own-property object-literal API; failed receipts instead of whole-startup refusal for oversize discovery changes what a partially loaded extension set means; and R5a deliberately inherits no extension surface. None is decidable inside a follow-up sweep. No inherited extension authority was introduced. |
| **R13a** — hoist the nested-label helper; bounded eviction of labeled nested results | Declined for this batch: both are explicitly conditioned on touching eviction, and this batch does not. Raw-delta-only crash reconstruction remains explicitly unlabeled. |
| **R13b** — index structural compaction matches; avoid the zero-I/O generic-result race | Declined for this batch. Indexing is conditioned on large-context profiling that has not been run and would need an approved budget; the race avoidance is conditioned on touching the generic result path, which this batch does not. |
| **R12e** — additional shell dialects and escaped-literal syntax | Declined. The row permits them only with dialect-specific inert execution controls, which is new capability rather than a follow-up. Literal argv scopes still attest no executable identity, PATH, Git configuration or program effects. |
| **R14b** — separate unknown-command-attempt budget; wrapper receipt fixtures | Declined. Conditioned on observed crowding (none observed here) and on wrappers evolving (they have not). |
| **R10c** — inspect/reclaim command for retained isolated worktrees | Declined. An explicit ownership/quiescence feature, not follow-up polish; bounded retention with manual operator cleanup remains deliberate. |
| **R15c** — live E1 cache comparison; Anthropic thinking option and live replay | Declined. Both require an approved live-model budget, which this batch does not have and did not use. Additional non-reasoning metadata fidelity is separate scope. |
| **Generic evidence-grading fixture joins** | Declined. Conditioned on those fixtures gaining long-lived children; they have not. The two demonstrated Windows outer-timeout failures were handled in the earlier bounded repair, not here. |
| **#235** — whether undo should revert session-end maintenance writes | Declined as a design decision outside a follow-up sweep, exactly as the row states. The row's independent diagnostic opportunity — bounded refusal-reason and reference replay — **is** implemented (§1). No exclusion was broadened and the seal is unchanged. |
| **R16b** — edit-centred capture window for oversized files | Declined here: it is an optional display enhancement and its code is in the CLI, not this package. Current truncated-prefix honesty is unchanged. |

## 3. Already delivered before this batch

Verified against current source; no work was redone.

| Item | Evidence |
|---|---|
| Zero-retention compaction | `src/compaction.ts` validates a safe non-negative retention count |
| Timer restoration / primary-assertion preservation / checkpoint verification join | `test/checkpointer.test.ts` file-level real-timer `afterEach`, `settleFixture` rethrowing the primary error with cleanup as `cause`, and `Checkpointer.running` drained in `endSession` |
| Partial compiler diagnostics; geometric coverage buffer | `src/diagnostic-output.ts`, `src/diagnostics.ts` |
| Coherent skill refresh | `src/tools/skills.ts` `SkillCatalog`; the empty-initial-catalogue restart limitation remains deliberate |
| All-unknown capability evidence label; abort-grace fixture readiness | `src/provider-conformance.ts`; `test/subagent.test.ts` |

## 4. Cross-package items not in this diff

Reported to root rather than edited here, per this batch's ownership rules.

1. **Required — `packages/memory/test/checkpoint-ingest.test.ts`.** Three cases assert the undo refusal
   by exact string equality:
   ```
   await expect(undoSession(store, session.id, { cwd: root })).rejects.toMatchObject({
     message: "undo unavailable: this run has no verified ownership seal (legacy, interrupted, or uncertain work)",
   });
   ```
   The R4b/#235 replay appends the recorded seal-refusal reason and the retained checkpoint
   references after that first line. Proposed repair, preserving everything the test checks:
   ```
   await expect(undoSession(store, session.id, { cwd: root })).rejects.toThrow(
     /^undo unavailable: this run has no verified ownership seal \(legacy, interrupted, or uncertain work\)/);
   ```
   This is the only failing assertion in the repository suite after this batch.
2. **R4c restore polish** (SIGINT join notice, omitted-abort option control, unused disabled adapter)
   belongs to the **supervisor/CLI** batches: `abortRestores` lives in `packages/supervisor/src/supervisor.ts`
   and the SIGINT handling in `packages/cli/src`. Nothing for it exists in core.
3. **Workspace recovery #129** (dead handoff-temp advice, manifest validation before write) belongs to
   the **memory** batch: PR `ba4569c` touched `packages/memory/src/dream/copy.ts` and the CLI only, and
   the surviving "inspect \<temp\>" advice is at `packages/memory/src/dream/copy.ts:110`.
4. **Child-grant test polish — the other half.** "Skip diagnostic snapshot work after a readiness wait
   has settled" and the sibling predicate that reads `state.pending.permissionGrants.subject !== child.subject`
   are in `packages/cli/test/child-grants-ui.test.ts`, so they belong to the **CLI** batch. The core-side
   child-view identity naming is done (§1).
5. **R14a shared formatter — CLI adoption.** `renderPlanAcceptance` and `renderPlanItems` are now exported
   from core. `packages/cli/src/render.ts:434` still keeps its own copy of the same string; replacing it
   with the core export removes the duplication the row names. Deferred to the CLI batch.

## 5. Root integration and final disposition

The preceding builder receipt is historical, not an unresolved request to the user.
Root completed cross-package connections in this final core batch rather than open
another package PR or silently drop a handoff. Supervisor #291 and memory #292 are
merged; CLI #293 owns the already-reviewed general interface/evaluation batch.

- **R4b/#235 diagnostics:** matching trees now say only that the worktree matches,
  not that a prior undo ran or recovery originals exist. A hand-restored tree test
  proves that distinction. Replay is capped at eight entries of 400 UTF-16 units
  plus fixed truncation/omission labels (total below4096); logged checkpoint refs
  are explicitly not proof of current retention. This supersedes the earlier
  builder table's "undo already applied" and "references that do exist" wording.
- **R12c sandbox consent:** actual ask/final decision events carry tool name/id and
  decision source; deny, allow and unattended controls run through real sessions.
  Startup MCP consent has no live session/tool id to invent; CLI's table records
  that separate contract boundary.
- **R15h role paths:** fixed refusal explains unsupported symlinked conventional
  role directories; direct SDK project-root aliases still canonicalize and load.
  These three integration groups passed90 focused tests after seven fail-first
  assertions; source build/typecheck passed in their isolated integration worktree.
- **#129 workspace recovery:** memory's generated handoff manifest is validated
  before metadata is opened/written. Failure guidance names retained output and
  the manifest rather than a temp removed in cleanup. Three fail-first assertions,
  86 recovery/lifecycle/scan tests and build/typecheck passed. Ownership/foreign-file
  preservation remains intact. Optional lock-wait alignment is declined: finalization
  already owns independent bounded waits, with no demonstrated mismatch requiring
  inherited cancellation or altered cleanup timing.
- **Cross-package undo assertions:** memory checkpoint-ingest tests still require
  the no-seal refusal and unchanged task/wiki/human/log bytes, while permitting the
  appended diagnostic context. No restoration or ownership assertion was removed.
- **R14a formatter adoption:** CLI reexports the exact core acceptance formatter;
  `/plan` uses the shared item formatter, retaining explicit unverified wording
  without repeating entirely-undeclared status per step. Identity and actual
  controller-output assertions failed first, then passed.
- **Child-grant test polish:** readiness completion avoids constructing later
  diagnostic snapshots; resolved/rejected-run controls both failed first. The
  sibling predicate now explains the peer-versus-descendant relationship.
  Combined CLI/readiness and memory-ingest integration passed19 tests.
- **R6c generated marker:** the propagation comment explicitly states the strict
  literal-true event gate, ordinary omission and non-authority meaning. Existing
  schema controls and CLI option-key controls retain the runtime boundary.

Remaining conditional fragments explicitly retained without speculative expansion:

| Fragment | Disposition |
|---|---|
| R4a hash batching / narrower Git environment | Declined without measured hashing bottleneck or a demonstrated unsafe inherited variable requiring a new allowlist; existing isolation and hard ceilings remain. A narrower allowlist could remove required host Git behavior and is not justified by these diagnostics. |
| R4b repeated scan batching | Declined without a measured large-workspace bottleneck; independent ownership checks stay at each destructive boundary rather than cache potentially stale state. |
| H6 context-object reduction | Declined optional refactor: current explicit execution dependencies remain useful and no behavioral defect requires regrouping them. |
| R5d future pin metadata scope | Retained current name/description/input-schema scope; no additional pinned metadata is exposed in this batch, so the stated trigger for expanded scope explanation does not occur. |
| R12a idle audit sink / standalone fallback separation | Declined new lifecycle/log surface: resets revoke immediately and queue receipts for the next active log; no post-terminal authority replay. Production controller wiring remains explicit; an extra fallback module split adds no current correctness change. |
| R13c duplicate-request presence accounting | Retained: retry assembly is unchanged by approval-failure diagnostics; old input and neutral output still do not clear restrictions. |
| H7a pre-model-veto turn pairing | Declined separate lifecycle contract change: this batch distinguishes staged versus attempted continuation without inventing a provider attempt or changing the pre-existing done outcome on veto. |

Final full-suite, independent-review and hosted delivery receipts are maintained by
root after integration; none is implied by isolated helper tests.

### Historical Windows paired edit/test fixture (#161) — investigated

Original run34027283321, head `bca33488`, Windows job101470401117 timed out the
paired edit/test case at5013ms against its5000ms deadline, without an assertion
mismatch. Same-head attempt2/job101471243008 passed both original CLI cases in316ms.
PR #284 (`4916cf1`) subsequently repaired this exact fixture's structure: separate
external/non-external cases, one real session per deadline, teardown-owned abort
and join before fixture deletion. Existing assertions and default timeout remain.
The current fixture, byte-identical to main `6fb3413`, passed three diagnostic runs
of four cases each under a verified private TMPDIR; edit/test cases took15–16ms.
Actual shell output and negative external-expansion denial controls remain.
Historical cause is unestablished; no further fixture change or timeout inflation
is justified. This is an explicit investigation outcome, not a new issue or a
claim that runner contention was proven.

Root's combined source build, typecheck and private-fixture preflight pass after
all integration changes above. Full suite: **3682 passed / four existing skips /
233 files** on supervisor/memory main `6fb3413` plus this core batch. The CLI batch
is reviewed separately and will be integrated from its merge before final delivery.
