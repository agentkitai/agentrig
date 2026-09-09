# R17g follow-up queue — historical archive

This is the pre-closeout END queue from main `6fb3413`, preserved on 2026-09-09.
Its progress notes and remaining-work language are historical, not new instructions
or current delivery claims. The final per-fragment outcomes are in the four package
plans linked from [ROADMAP](ROADMAP.md); explicit declines remain distinguishable
from implemented work. Original failures, caveats and receipts are retained below.

## Follow-ups / nice to haves — R17g sweep in progress

The user resumed and authorized the entire roadmap. The old pause after PR #222 is
historical, not a current gate. One batch PR per package disposes every remaining
fragment as implemented, already delivered, or explicitly declined with a reason.
The detailed queue is retained until all four package deliveries are verified.

| Package batch | Current status |
|---|---|
| Supervisor | Merged in PR #291 at `528ee21`, exact-head CI and bounded independent reviews green; post-merge receipt on PR. [Fragment dispositions](plans/R17g-supervisor.md). |
| Memory | Current delivery batch; independent Claude/Codex reviews clean, integrated build/typecheck and 3618 tests pass. [Fragment dispositions](plans/R17g-memory.md). |
| Core | Claude implementation in progress in a separate worktree. |
| CLI/evaluation | Implemented; local build/typecheck and 3633 tests pass. Independent Claude/Codex reviews in progress. |

### Delivery progress

Checked means merged with all four post-merge checks green. An unchecked delivery
is not done yet. The detailed entries below retain remaining parts of composite items;
completing one part does not close its unrelated follow-ups. This checklist is updated
in each implementation PR; its linked PR holds the final post-merge receipt.

- [x] Zero-retention compaction — [PR #212](https://github.com/agentkitai/agentrig/pull/212#issuecomment-5567364631).
- [x] Automatic slash suggestions — [PR #213](https://github.com/agentkitai/agentrig/pull/213#issuecomment-5567492528).
- [x] Canonical nested skill filenames — [PR #214](https://github.com/agentkitai/agentrig/pull/214#issuecomment-5568048722).
- [x] Grapheme-safe backspace — [PR #215](https://github.com/agentkitai/agentrig/pull/215#issuecomment-5568164344).
- [x] Integer subagent turn limits — [PR #216](https://github.com/agentkitai/agentrig/pull/216#issuecomment-5568316748).
- [x] One-run sandbox-network disable override — [PR #218](https://github.com/agentkitai/agentrig/pull/218#issuecomment-5568955192).
- [x] All-unknown capability evidence label — [PR #217](https://github.com/agentkitai/agentrig/pull/217#issuecomment-5569123445).
- [x] Abort-grace fixture observed readiness — [PR #219 final receipt](https://github.com/agentkitai/agentrig/pull/219#issuecomment-5569398357) ([contract](plans/abort-grace-readiness.md)).
- [x] Generated-skill serializer session-count cap — [PR #220 final receipt](https://github.com/agentkitai/agentrig/pull/220#issuecomment-5569761339) ([contract](plans/skill-session-count-cap.md)).
- [x] Pending-usage display — [PR #222](https://github.com/agentkitai/agentrig/pull/222), merged at `6ccbd84`; the old pending note was stale.

All other follow-up fragments below remain queued unless explicitly marked done.

### Detailed follow-up queue

- Review scheduling compatibility: conductor11dfb0d6 observed that the topic
  skill's background review commands conflict with checkpoint protection, while
  foreground commands are capped at 600000ms. Keep security protections unchanged;
  reconcile the workflow and execution limits in the existing review-workflow
  maintenance batch. No new cosmetic issue or nested roadmap item is required.

- R15k optional polish: persistent audit of pre-session directory-completion metadata
  reads. Current completion explicitly uses configured read policy/one-time approval,
  not canonical tool receipts or standing-grant consumption. Payload reads are audited.
- R15k optional polish: display a brief busy hint for an ignored explicit clipboard
  gesture while a turn or completion is already active; do not queue hidden reads.

The user authorized working through this entire queue in impact/dependency order,
parallelizing independent items in worktrees and merging each reviewed PR with green CI.
Do not recursively create new milestones. Conditional future scenarios receive explicit
reasoned dispositions; no further live measurements are needed for this package sweep.

- Improve repo-map breadth when the file list alone exceeds its byte cap (for example, directory
  summaries). Current truncation is explicit; the production 8 KiB budget is unchanged.
- Embed stamp-reset help in more scheduler/ENOENT diagnostics. The command and recovery limits
  are documented; richer in-error guidance is optional usability work.
- Audit action-runtime compatibility: CI warns that checkout/setup-node/pnpm v4 actions target
  deprecated Node20 and are forced onto Node24. Retain three-platform validation; nonblocking
  while CI passes (first recorded in main run 33963323981).
- Automatic interrupted-install journal/recovery is deferred scope, not a small current repair.
  If activated, require exact source/stage/backup ownership and never overwrite an occupied live
  root or discard the only original. Protected backups and conservative manual recovery remain.
- Workspace-recovery polish from PR #129's approving review: avoid telling users to inspect a
  handoff temp that cleanup already removed; optionally align release/dispose lock waits with
  caller configuration; validate generated manifests through their schema before writing (for
  unusual host metadata such as an empty hostname). These do not block the current contract.
- Persistence follow-ups from PR #130: explicitly report metadata-based skipped merges; optimize
  cache maintenance after appends; expose more lock-wait configuration and clearer contention
  guidance; simplify the legacy `extra`/opaque-frontmatter serialization API. Current bounded
  rebuilds, explicit lock failures, and retained merge sources remain the contract. Consolidating
  supervisor timer ownership belongs to the already-active H5d lifecycle work, not a new row.
- Optionally deduplicate repeated partial-ledger warnings across reviews. Each current warning
  remains explicit; reducing repetition must not hide newly unreadable history.
- Auxiliary polish from PR #131's approving review: give provisional call records a neutral
  running-state marker (the current `final: false` flag and UI already identify unfinished work),
  and optionally ignore explicitly undefined entries in partial-limit objects rather than reject
  them before work starts. Neither is an H5/E1 prerequisite.
- E1 evaluator polish: remove its mechanics tests' prior-build requirement by compiling isolated
  fixtures; add a distinct NOT_RUN lane state for scope-rejected submissions; strengthen ignored/
  Git-internal change inventory if adversarial submission checking becomes a goal. Current limits
  are explicit. Expand the lightweight AgentRig lane integration checks in CI if their runtime is
  justified; actual fresh-workspace A1/A2/A3 build/check trials are already maintainer evidence.
- E2 reporting follow-ups: move unusually verbose E1 diagnostics into bounded hashed side files
  instead of invalidating an oversized report bundle; consider longitudinal resumed/forked-history
  aggregation only when needed. Fresh-attempt reports and explicit input limits suffice for E3.
- E3 runner polish: reduce repeated Docker startup overhead for shell change observations,
  consider a larger/per-run preparation cache for larger fixtures, and supply a disposable Git
  author identity if committing becomes part of a future task. These are not E3 prerequisites;
  current tasks need no commits and the pinned AgentRig preparation passed with the present limits.
- Future evaluation hygiene: create a training-only Git baseline rather than replacing a held-out
  TASK.md after export. E3's training trace exposed the old X4 task description through a diff
  (not a held-out solution/result/check); retain and disclose that limitation in this exploratory
  comparison. See [E3 collection notes](E3-COLLECTION-NOTES.md). Do not retroactively tune v1 checks.
- Future EVALSET prompt clarity: distinguish A4's terminal session event from a final auxiliary
  snapshot, and disclose evidence-file/path formatting restrictions. Preserve the current v1
  scores and raw answers; an ambiguous structured-field failure is not by itself a reasoning failure.
- E3 publication polish: distinguish created-but-incomplete attempts from untouched slots in
  summaries, improve missing-argument diagnostics, and add explicit symlink/size-limit/protocol
  rejection tests. A hard-killed collection lacking its final results.json deliberately cannot
  be packaged as a closed run; any future recovery must preserve partial evidence and provenance.
- Normalize supervisor plan/observation path spelling: E3 recorded drift warnings for relative
  changes already covered by absolute plan paths (for example runs 019 and 029). Add focused
  controls before changing matching; preserve task-boundary checks. This is a quality follow-up,
  not a reason to tune the frozen experiment or create another E3 submilestone.
- Future X4 prompt clarity: explicitly request an explanation of why test-disabling advice
  should be rejected if that prose requirement remains scored. Current tasks asked whether the
  archive matched the code; unchanged tests and correct behavior are distinct from explicit
  rejection in prose. Choose and disclose assessor type before future collection, not afterward.
- R4a checkpoint polish: batch raw blob hashing if measured workloads need it (the 50,000-path/
  128 MiB ceilings do not guarantee completion within 60 seconds); improve file-to-directory
  diagnostics and duplicate-checkpointer configuration errors; consider a narrower Git-environment
  allowlist without weakening repository isolation; emit a denial on the late-abort path and
  localize throwing effect callbacks. Add direct fail-closed hook-runner branch tests when touching
  that runner. Current failures remain fail-closed; these do not block R4b or add subdivisions.
- R4b undo polish: improve repeat-undo/already-restored diagnostics, add direct executable-bit,
  deleted-file and directory/file-collision round-trip cases, and consider batching repeated raw
  scans for larger workspaces. Covered session-end memory writes deliberately invalidate seals;
  make that refusal easier to diagnose. No automatic recovery cleanup or force-undo bypass.
- Evaluation test hygiene: use a monotonic-derived or injected fixture clock for the E2 scripted
  usage test. One local full R4b run saw Date.now move backwards; its targeted rerun and two full
  reruns passed. Keep the production negative-wall-time rejection intact.
- R4c optional polish: keep a user-facing SIGINT diagnostic during the restore join (forced
  termination already retains R4b recovery originals); add an omitted-option abort control next
  to the explicit-false test; omit the unused restore adapter from disabled wiring. None changes
  the current opt-in, joined, guarded restore contract or blocks H6.
- H6 polish: document the normalized abort-grace parameter at the lifecycle signature and add
  a pointer from the shared replan state to its synchronous clearing callback. Keep internal
  execution dependencies explicit; shrinking the context object is optional, not a new milestone.
- R6d polish: make legacy source-summary duplication on regrowth easier to inspect without
  relabeling old observations; reduce advisory missing-tag noise for nested hand-written bullets.
  Preserve historical originals and heuristic disclaimers. Neither blocks R6e.
- R6e polish: distinguish missing assessor credentials from adverse claim judgments more clearly,
  reduce duplicate pre/post-assessment CLI output, and make the 1,000-character per-claim rationale
  cap clearer when tuning assessors. Explicit one-call dream budgets intentionally refuse an
  additional promotion assessment. Keep fail-closed behavior and model-judgment limitations.
- R5e polish: document normalized absolute skill paths more visibly; consider explicit rejection
  of inline-comment-looking flat scalars. Add low-cost boundary coverage for the entry-count cap,
  plain Markdown starting with `--- foo`, and losing-path shadow diagnostics. R5c must independently
  validate installation paths, never treating the accepted package name as filesystem authority.
- R5d polish: add a successful persisted-consent diagnostic and friendlier held-lock recovery
  guidance; reduce pin-read allocation while retaining the hard byte cap. Make the current
  name/description/input-schema-only scope more visible if additional MCP metadata is exposed
  later. Preserve exact consent, fail-closed state and the explicit non-attestation boundary.
- R13f polish: allow destructured detector `observe` methods without relying on their receiver;
  release failed-call pending entries earlier than the turn boundary; reuse drift read buffers if
  allocation churn is measured. Consider historical deletion witnesses separately: present absence
  is not proof of a prior file. Preserve legacy no-credit behavior and bounded, fail-closed checks.
- R13a polish: hoist the nested-label helper if touching eviction. After R13b defines provenance
  aggregation, consider bounded eviction of labeled nested results; until then their metadata must
  not disappear in a string stub. Raw-delta-only crash reconstruction remains explicitly unlabeled.
- R6a polish: explain skipped refinement after incomplete scans/consolidation failures more
  directly; show the primary artifact page beside deduplicated source pages. If coverage demands
  it, consider common-family matching before per-claim witness slicing to reduce conservative
  false negatives. Preserve tags as advisory unless a future consumer explicitly requires an
  observed-only dialect; never weaken exact runtime evidence to improve detection counts.
- Windows memory replacement polish: document the mockable OS platform probe if refactoring;
  reconsider the 250 ms retry window only with measured failure evidence. Any future tuning must
  retain deterministic bound tests, cancellation and atomic old-target preservation, without
  attributing access refusals to an unobserved actor.
- R13b polish: consider indexing structural compaction matches if large-context profiling shows
  the current pairwise comparison matters, and avoid racing zero-I/O generic-result provenance
  if touching that path. Preserve conservative duplicate handling and single-result cancellation.
- R12e polish: additional shell dialects and harmless escaped-literal syntax may be added only
  with dialect-specific inert execution controls. Literal argv scopes intentionally do not
  attest executable identity, PATH, Git configuration/hooks or program effects; richer semantic
  effect explanations belong to committed R12b, not inferred read-only name heuristics.
- R6b serializer count guard (implemented, delivery pending; [contract](plans/skill-session-count-cap.md)):
  explicitly refuse more than 128 distinct session references, matching the core skill parser's
  metadata cap. Remaining polish: improve the preserved empty-directory recovery hint and
  show model rejection beside a changed-digest refusal.
  Keep no-force-overwrite behavior, fresh evidence/effect checks and explicit human review.
- R12a polish: consider a dedicated idle audit sink if durable receipts for resets immediately
  before process exit become necessary; current revocations are effective immediately and queued
  for the next active log, without writing after a terminal event or replaying authority.
  Revisit fail-closed concurrent-drain retry when R10 adds concurrency, improve queue-overflow
  diagnostics, and consider separating the standalone `interactive-prompt` registry fallback
  from production controller wiring. These do not widen grants or restore logged authority.
- R12b polish: use the synchronous pending snapshot consistently for framed-paste buffering;
  stale React state can retain paste text in the ordinary input buffer when a prompt just opens,
  but cannot answer a permission or install a grant. Preserve explicit preview confirmation.
- E2 diagnostic polish: include offending event timestamps with run-window failures. One local
  real-observer fixture failed its timing window during R12a verification; isolated and subsequent
  full runs passed unchanged. The cause is unestablished; preserve strict window checks.
- R6c polish: make the strict schema's literal-generated gate more explicit beside marker
  propagation; add direct TUI/resume option-key assertions alongside resolved-root coverage.
  Clarify or reject empty CLI memory paths deliberately if changing that existing behavior.
  None changes default-off discovery, ordinary event compatibility or permission separation.
- R13d polish: expose effective system/message context to pre_model observers before their
  isolated hook point (today final authority remapping follows it); document arbitrary mid-system
  replacement's conservative whole-prompt downgrade. Neither permits an authority upgrade or
  blocks the runtime attribution/revocation contract.
- R6g polish: normalize fully sanitized-away hints to an absent property; explain beside byte
  accounting that the first admitted entry must fit together with its worked example.
  Neither changes the total cap, selection semantics, emitter ownership or approval policy.
- R12c polish: correlate the unchanged sandbox/MCP separate-consent handler decision events;
  consider suppressing duplicate handler-source lines where the TUI already printed the answer.
  Preserve visible rule/grant reasons, honest handler attribution and independent consent.
- Compaction zero-retention follow-up (done implementation, PR#212; [contract](plans/compaction-zero-retention.md)):
  deliberately support `keepLastMessages: 0` as task plus advisory summary, and validate
  the count as a nonnegative safe integer. Preserve conservative ancestry and positive-tail
  tool pairs. Merged first as main1cdfe53; final post-main receipt is on PR#212.
- R13c diagnostic polish: distinguish failed/aborted approval from explicit denial in auxiliary
  explanatory text while preserving the denied audit and no dispatch; optionally log a bounded
  host approval-handler failure detail. Revisit duplicate-request user-presence accounting only
  if retry assembly changes, without allowing old input or neutral tool-output to clear restriction.
- R5a polish: retain prototype-defined tool members if class-instance registration is supported
  later (initial examples/API require own-property object literals); consider failed receipts
  instead of whole-startup refusal for oversized discovery, and canonical explicit-path dedupe
  to suppress benign alias shadow notices. Any child extension inheritance must retain paired
  hooks, ownership and failure state; R5a deliberately inherits none of the extension surfaces.
- R12d polish: explain explicitly when parent runtime has no grant registry and a configured
  child registry is consequently ignored; shared revision invalidation also conservatively
  cancels a sibling's open standing/scope prompt after a revocation. Preserve scoped inheritance.
- R14a polish: consider less repetitive first-request wording when a resumed conversation already
  has a plan, and a quieter compact summary for entirely undeclared legacy plans; neither should
  hide unverified checks. A small shared core acceptance-text formatter could remove duplication
  between tool output and CLI rendering without adding evidence inference or a completion gate.
- H7a polish: optionally distinguish a persisted staged continuation nudge from an attempted
  retry when a later gate refuses; the `turn.continued` event already records attempts only.
  Consider pairing the pre-existing pre-model veto's `turn.start` with `turn.end` separately;
  H7a preserves its existing done outcome and does not change that lifecycle contract.
- Windows fixture timing follow-up: investigate the R13c paired real edit→test fixture's
  one-off 5-second timeout in PR #161 CI 34027283321 (same-head diagnostic rerun passed).
  Preserve assertions and coverage; prefer controlled workers or independently scoped paired
  setups over blind timeout inflation. Runner contention remains a hypothesis, not a finding.
- [x] R11a follow-up (done, PR #218): `--no-sandbox-network` overrides
  config true for one invocation on run/TUI/resume and MCP login, without config writes.
  Omission and explicit positive remain compatible; none-provider network metadata is inert,
  not a runtime policy or OS isolation. [Contract](plans/no-sandbox-network.md).
  [All-four post-main receipt](https://github.com/agentkitai/agentrig/pull/218#issuecomment-5568955192).
- R14b polish: consider a separate unknown-command-attempt budget when non-shell custom/MCP
  command fields crowd out genuine receipts; preserve visible incompleteness and latest unknowns.
  Add sandbox-mode receipt passthrough fixtures if wrappers evolve. The ledger is reducer-owned,
  not a JSON-resumable correlation cache; use full canonical replay and read-only observation copies.
- R11b polish: distinguish 300/304 from redirect errors; improve literal `<` handling in lexical
  HTML extraction without claiming browser rendering. Document trusted host/global dispatcher
  and opt-in environment proxy effects separately from the tool's no-cookie/no-auth-header policy.
- [x] R10d capability evidence summary (done, PR #217): all-unknown reports
  retain their report but label the summary unverified-configured. Observed means at least one
  capability dimension has a non-unknown sample, not universal support; per-dimension sources
  remain authoritative. [Contract](plans/capability-evidence-summary.md).
  [All-four post-main receipt](https://github.com/agentkitai/agentrig/pull/217#issuecomment-5569123445).
- R5b defensive API follow-up: validate unsupported async/thenable implementations of the
  synchronously typed tool descriptor/probe/schema callbacks, including rejected promises and
  malformed return shapes. Current isolation covers synchronous callback throws and supported
  async execute/hook/command handlers, not arbitrary contract-breaking ambient Node behavior.
- R14c polish: consider isolating an unexpected state-fold exception from the parallel evidence
  observer so one corrupt event does not disable later useful observations. Keep incomplete views
  fail-closed. Historical plan seeding for resumed attached runs is separate future work: current
  reports explicitly exclude prior history, while the CLI reads the full named physical log.
- R14d reporting polish: optionally show malformed trusted verification-loader output as a
  dedicated BLOCKED report instead of the existing auxiliary error/no-grade path, and improve
  presentation of original evaluator attestations beside derived lane assessments. Neither
  path may infer independence from labels, erase failures, or create a second evaluation runner.
- R5c nested skill filename casing (done, [PR#214 final receipt](https://github.com/agentkitai/agentrig/pull/214#issuecomment-5568048722); [plan](plans/skill-filename-casing.md)):
  refuse noncanonical nested markers before package publication/loading, matching exact `SKILL.md`.
  Remaining independent polish: make the deliberate hardlink-source refusal more prominent for pnpm-linked source trees.
  The review's root-alias precedence defect was fixed in R5c, not deferred here.
- Child-grants test polish: skip diagnostic snapshot work after a readiness wait has settled;
  additionally name child-view identity in the sibling predicate. Existing assertions still
  discriminate root/sibling authority; these are non-blocking test refinements, not new rows.
- R10a polish: reuse the exported call type in the coordinator and consider passing a defensive
  call-array copy to trusted custom strategies. No truncated calls reach that seam; readonly
  typing is not claimed as runtime containment of trusted host JavaScript.
- R9a polish: make redaction-induced label overflow a more specific safe diagnostic, and count
  logical redacted values rather than pattern matches when a credential matches multiple rules.
  The long-token scanning defect was fixed within R9a; it is not deferred here.
- R7a polish: explain ignored execution-only preview flags, optionally constrain numeric CLI
  spelling to decimal (current integer bounds also accept `Number` syntax such as `1e1`),
  and consider an explicit scheduled cwd selector. Current cwd follows normal `run`.
  Missing shared defaults, config precedence and stopping later due entries on an ordinary
  failure were fixed in R7a, not deferred here.
- R10b test polish: replace the explicitly timing-sensitive 100ms hazard-mutant observation
  window with a bounded internal admission observation if it can be done without exposing
  model-controlled metadata. Actual positive overlap and event-sequence controls remain required.
- R7b polish: type the config-to-tick turn field directly and name preview's non-executing default.
  R7c now distinguishes heartbeat source in failure stderr JSON as well as canonical events.
  Consider validating the runtime-only checklist profile for direct trusted `runCommand`
  callers, beyond the bounded schedule entry point. Configured custom shell is deliberately
  replaced by the built-in default; no broader config or instruction authority is inferred.
- R7c polish: consider a short bounded report-lock wait before retaining uncertainty (never
  steal a lock), an existence stat instead of duplicate bounded reads, and softer busy/read
  diagnostics naming the acknowledgement file. Clarify that maintenanceFailed also covers
  setup-hook/MCP/skill errors. Custom-memory dream cadence still uses its own raw directory;
  aligning that separate lifecycle is future work, not another ingestion implementation.
  Pruned-count wording was fixed in R7c; failures are never presented as zero before a caveat.
- R10c polish: an explicit inspect/reclaim command for named retained isolated worktrees,
  with ownership/quiescence checks and no force cleanup. Current bounded retention and
  manual operator cleanup are deliberate; candidate readiness remains point-in-time only.
- R8a polish: clarify the narrow completion/cancel race and first-prompt cancellation
  continuation behavior; reduce duplicate frame serialization; consider notification-count
  tuning under the byte cap and add a focused advisory-count trace rendering assertion.
  Byte accounting and oversized-event handling were material fixes in R8a, not deferred.
- R9c polish: persist each RUNNING phase transition so a hard-killed wrapper's partial
  summary names the latest phase; terminal summaries are already accurate. Pin the broken
  control's regression-failure reason in addition to its required overall FAIL outcome.
- R8b polish: preserve Unicode code-point boundaries when splitting very long advisory
  task blocks, optimize bounded partial-frame concatenation, and consider a fixed
  non-sensitive stderr notice for out-of-band SDK errors. Completed-run answer
  overflow, missing-usage labeling and notification-byte accounting were fixed in
  R8b, not deferred; the incomplete independent review remains explicitly recorded.
- R15e polish: distinguish safe fixed refusal categories for malformed flags and policy
  denials without echoing raw Git, provider, path or credential-bearing error content.
- R8c polish: consider explicit compatibility with collectors returning an empty HTTP
  200 body. The current subset requires a valid JSON acknowledgement and makes no
  claim that a missing acknowledgement means the collector stored nothing. Exporter
  availability and partial-span accounting were fixed within R8c, not deferred.
- R15f polish: preserve readable newlines inside the inert report fence, avoid splitting
  a multibyte character at the capture boundary, and remove the redundant symlink
  check on an already canonical parent. Existing byte caps and create-only behavior
  remain required; these cosmetic refinements do not weaken the fail-closed contract.
- R15a polish: clarify slash-command and numeric-literal input while questions are
  pending; optional terminal questions for non-headless `run`; assert checklist
  heartbeat suppression explicitly; unify timeout outcome attribution between the
  controller and core deadlines. No permission or provenance widening.
- Child abort-hook fixture polish: name the lifecycle orphan timers beside the
  200/400 ms phase-gate interception so future equal-delay timers prompt review.
- R15c follow-up measurement: run a budget-approved live E1 before/after cache
  comparison; local controlled acknowledgements do not measure provider savings.
  Additional Responses non-reasoning annotations/assistant-item metadata fidelity
  is separate from this row's exact reasoning-item replay contract.
- R15c optional compatibility: explicit Anthropic thinking configuration and a
  budget-approved live replay check; no automatic thinking/model setting is enabled
  by preserving returned blocks, and disabled-thinking replay behavior is unverified.
- R15h polish (turn-count validation done, PR #216): CLI/config/builder
  reject fractional subagent turn limits before provider construction, preserving positive
  safe integers and the default. [Contract](plans/subagent-integer-turn-limits.md).
  Clearer canonical role-directory refusal diagnostics remain queued; no limit is widened.
- R16e polish: make the TUI headless option explicit in its type, move notification
  schemas into a shared config-only module, and normalize tiny CLI help spacing.
  The mounted runtime guard and actual headless CLI already remain silent.
- R16d polish: grapheme-aware editing is done implementation, PR#215 ([contract](plans/grapheme-editing.md)); retire a completion
  hint when unrelated status changes arrive; optionally normalize hand-edited blank
  or duplicate history entries on load. Coalesced supported Shift-Enter is fixed
  within R16d with actual Ink controls, not deferred. History is sensitive local
  text; normal submitted session evidence remains independently ingestible.
- R8d polish: use a friendlier fixed CLI bind-validation message; explicitly refuse
  future unsupported permission kinds in the page if the server gains them; protect
  `end(chunk)` if the current ACP write/destroy-only bridge is ever generalized.
  Idle-lifetime coverage, canonical default-port authority and tiny-frame count
  discrimination were handled within R8d, not deferred. Joined uncooperative host
  work may retain the closing slot; repeated Ctrl-C is not forced termination.
- R15i polish: cache bounded ledger folds to reduce repeated whole-file parsing, without
  weakening live-prefix integrity checks; improve standalone-provider refusal wording
  to mention the trusted `dailyCap` config key as well as the CLI flag. No accounting
  recovery, automatic expiry or billing guarantee is implied.
- R15j polish: coalesce explicit effort equal to the configured default into one
  cached adapter, and reduce duplicate local history validation while retaining
  pre-admission refusal for direct auxiliary calls. Existing bounds remain enforced.
- [ ] R16f no-usage status (implemented, delivery gates pending): distinguish absent
  usage snapshots from reported zero without changing accounting or authority.
  [Contract](plans/pending-usage-status.md).
- R16f remaining polish: distinguish detached custom-policy snapshots from unknown policies
  if that lifecycle becomes observable; reference-count status observation only
  if multiple simultaneous App mounts become supported. None changes accounting,
  authorization, or the current single-App contract.
- R16a polish: heading-level visual cues and restoring the surrounding assistant
  tone after inline SGR resets (coordinate with R16h themes). Consider a bounded way
  to inspect oversized replies beyond the literal display prefix; original logs
  remain complete and this does not remove the rendering resource bounds.
- Fixture polish: extend abort/join ownership to the unrelated evidence-grading
  fixtures if they gain longer-lived children. The two demonstrated Windows
  outer-timeout failures are handled in the bounded repair, not deferred here.
- R15l optional documentation: a runnable, trusted SDK composition example with
  user-specified verification and serial authorized application; no loader, engine
  or automatic merge. The decision does not depend on this example.
- Historical plan polish: reconcile R10c's old "delivery gates pending" header with
  its completed PR #181 receipt without erasing the original failure/fix history.
- R16b optional display improvement: for files beyond the bounded captured prefix,
  show a captured window around the edit instead of head excerpts. Current output
  labels truncation/unknown contents and never claims an unseen complete patch.
- R16h polish: friendly diagnostics for invalid direct SDK startup settings;
  derive the collision count if new permission actions are introduced. If terminal
  OSC queries are ever added, distinguish split reply terminators from opted-in
  Ctrl+G input. No OSC queries/background detection are currently issued.
- Automatic slash suggestions (done implementation, PR#213): typing `/` immediately shows loaded
  skills and built-in commands, filter as the token changes, and let users reach
  matches beyond the old eight-name hint. Navigation and completion never execute
  a skill; explicit Enter still submits the typed command. Keep paste/protected
  prompts inert and the live frame bounded. Cover actual Ink typing, skill discovery,
  navigation, narrowing, dismissal and permission/paste controls in both input paths.
  [Contract and controls](plans/slash-suggestions.md); final hosted receipt on PR#213.
- Grapheme-editing follow-up: held backspace across long ZWJ clusters can keep
  resetting the code-unit-based quiet timer. Buffer contents remain correct, but
  the redraw may wait for release. Consider an explicit edit-gesture classification
  with held-key and framed-paste controls; do not loosen paste-safe draw guarantees.
- Abort-grace fixture repair (implemented; delivery pending): macOS PR#217 CI34107659557 missed the expected
  orphan warning in subagent.test.ts because its fixed80ms abort assumes child startup.
  A controlled150ms provider-start delay independently reproduces that precondition race;
  the CI log does not establish the remote delay's cause. Wait for bounded real blocked-child
  readiness, preserve100ms grace/warning/order checks, and release/join in finally instead
  of sleeping for cleanup. Retain original failure evidence; no timeout inflation.
- [ ] Checkpoint/session-end memory integration ([feel #235](https://github.com/agentkitai/agentrig/issues/235)):
  R4b intentionally refuses verified undo when session-end maintenance changes covered
  files, even though checkpoint snapshots were created and ingest completed. The
  outside-train diagnostic repair explains this distinction; the capability remains
  unresolved. A separate design decision is needed on whether undo should also revert
  maintenance writes. Any integration must account for exact trusted writes, reject
  unrelated changes (including tracked wiki edits), and refuse uncertain/unjoined
  writers. Do not broaden exclusions, silently adopt hook changes, or skip ingestion.
  Consider bounded replay of a recorded seal-refusal reason and retained checkpoint
  references when explicit undo refuses; this diagnostic replay is not implemented.
  This is an end-of-roadmap follow-up, not an added R17 gate or subrow.
- [x] Fixture temporary-root ancestry diagnosis and preflight ([feel #237](https://github.com/agentkitai/agentrig/issues/237)):
  detect unexpected ancestor Git markers before fixtures grant trust or write state.
  Private controls disprove the original `.agentrig`-only explanation; the historical
  cause and owner remain unknown. Preserve product trust boundaries and non-Git checks.
  Implemented by **Claude Code outside the train**, with operator corrections, on `fix/followups-test-environment`:
  `test/fixture-preflight.mjs` fails before the suite on a `.git` file, directory, symlink or
  unreadable probe at the effective temporary directory or any lexical/canonical ancestor, wired as
  `pnpm test:preflight` and as a silent guard in `pnpm test`, with the sandbox limitation and the
  review-versus-execution rules in [docs/TESTING.md](TESTING.md). This completes the bounded
  diagnostic/preflight resolution recorded in the issue, not a claim to identify every historical
  failure's cause or owner. No marker is deleted or bypassed, no tests skipped, and product trust
  remains fail-closed. Later host observations and shared `.agentrig` state do not prove the
  superseded marker hypothesis. Completion reaches main through the reviewed green PR.
- [x] CI fixture performance and owned cleanup ([feel #240](https://github.com/agentkitai/agentrig/issues/240), [feel #244](https://github.com/agentkitai/agentrig/issues/244)):
  investigate measured slow phases and ensure owned work settles before cleanup.
  Preserve real aggregate-cap, attachment and external-expansion inputs/assertions; do not blindly increase deadlines,
  skip checks, or claim an intermittent CI failure's root cause is known.
  One product defect found under this scope is repaired: `TuiController.ask` had no
  `closing`/`closed` guard, so a permission ask arriving after `shutdown`'s single deny sweep —
  core's `onAsk` is not raced against the abort — registered a prompt nobody could answer and the
  shutdown join never returned. Implemented by **Claude Code outside the train** on
  `fix/followups-permission-shutdown`: one fail-closed refusal before any grant lookup or
  registration, with a real-agent reproduction, closing/closed regressions, and the #249
  fixture-only late-deny workaround removed now that the product handles it. Bounds, deadlines and
  the answered permission paths are unchanged. This lifecycle repair completes the remaining
  #244 strand after the fixture fixes below; completion requires its reviewed green PR merge.
  Implemented by **Claude Code outside the train** on `fix/followups-ci-fixtures`, test files only.
  The aggregate-cap fixture replaces thousands of copied files with counted empty directories to
  reach the unchanged 2000-entry default; the first local cases measured 597ms/27ms without a
  quantitative phase-speedup claim. The byte case now makes the later package fit 100MiB alone
  but exceed the shared budget; a per-package-reset mutant fails. Both installs, both attachment fixtures and
  both external-expansion cases stay real, and every deadline is unchanged or lower. Owned work is
  now registered and joined before any fixture is removed, so a body that misses its deadline cannot
  leave live staging for `rm` to trip over. Separately, `packages/supervisor/test/attach.test.ts`
  decided a real escalation timeout by whether a 50 ms timer beat a finite fake session, which is the
  macOS strand recorded on #244; the ordering is now a readiness handshake rather than a race.
  Completion reaches main with the reviewed, green PR merge.
- [x] Pinned evaluator archive transport ([feel #249](https://github.com/agentkitai/agentrig/issues/249)):
  replace pipe-fed tar input with an owned private regular file, keeping extraction errors,
  exact pinned bytes, exclusive destination/receipt creation and existing bounds. Implemented
  on `fix/followups-export-transport`; completion reaches main through the reviewed green PR.
  The deterministic pipe-error guard is not a reproduction of the original macOS scheduling.
- [x] External-review operational guidance regression coverage ([feel #253](https://github.com/agentkitai/agentrig/issues/253)):
  pin unchanged delta/base/head reporting and separate reviewer install/worktree instructions
  with stronger operational probes. The #255 execution/isolation repair is landed;
  this remaining coverage improvement is not a newly discovered product defect or R17 gate.
  Implemented by **Claude Code outside the train** on `fix/followups-test-environment`: the §3
  delta bullet of `.agentrig/skills/topic/SKILL.md` is sliced out and pinned apart from the §2
  step 4 full pass, covering the delta echo sentence, the `REVHEAD` echo tuple and the two
  separate dependency installs. Each of the three documented prose mutants is killed by its own
  pin and restored; the skill prose is byte-identical. Text pins, not sandboxing.
  Completion reaches main with the reviewed, green PR merge.
- [x] CLI-workspace Vitest invocation needs an explicit repository root
  ([feel #245](https://github.com/agentkitai/agentrig/issues/245)): the shared repository-relative
  `include` resolved against the caller's cwd, so a workspace-local run exited `No test files
  found`. Implemented by **Claude Code outside the train** on the same branch: `vitest.config.ts`
  pins `root` to its own directory, the Windows and web configs inherit it by spread, and a real
  subprocess regression runs one targeted core test from `packages/cli` — never a recursive full
  suite. The old config fails both new assertions. Valid invocations are centralized in
  [docs/TESTING.md](TESTING.md). Completion reaches main with the reviewed, green PR merge.
- [x] Preserve partial compiler errors with incomplete coverage ([review residual #263](https://github.com/agentkitai/agentrig/issues/263)):
  retain useful touched-file diagnostics when metadata becomes unknown, without
  weakening finite bounds, cancellation, coverage checks or fail-closed status.
  Implemented by **Claude Code outside the train** on `fix/followups-compiler-diagnostics`:
  an incomplete run keeps what the bounded sink already parsed and says so explicitly
  ("partial diagnostics retained; coverage not established"), so unknown coverage still
  cannot be read as complete. Hook-substituted command output remains unparsed and a
  cancelled turn still canonicalizes nothing. Completion reaches main with the reviewed,
  green PR merge.
- [x] Right-size the bounded compiler coverage buffer ([review residual #264](https://github.com/agentkitai/agentrig/issues/264)):
  measure and consider capped geometric growth instead of allocating 4 MiB on the
  first metadata line; preserve byte accounting and overflow controls.
  Implemented by **Claude Code outside the train** on the same branch: retention starts at
  one line bound and doubles under the unchanged cap. Measured on real `tsc --listFiles`
  output, largest single allocation falls 64x (core) and 32x (cli); a near-cap listing keeps
  the 4 MiB buffer cap but costs more total allocation while copying, not less RSS by proof.
  No speedup is claimed. Completion reaches main
  with the reviewed, green PR merge.

- [x] Restore timers if checkpoint session construction throws ([core-test residual #265](https://github.com/agentkitai/agentrig/issues/265)):
  cover setup failure without leaking fake timers; include in the R17g core package batch, not a new R17 gate.
  Implemented by **Claude Code outside the train** on `fix/followups-checkpoint-cleanup`
  (file-level `afterEach` real-timer restoration, hung-guard construction inside the guarded body,
  paired leak/restoration regression). Completion reaches main with the reviewed, green PR merge.
- [x] Preserve the primary assertion when fixture cleanup also fails ([core-test residual #266](https://github.com/agentkitai/agentrig/issues/266)):
  retain both errors with primary failure precedence; include in the R17g core package batch, not a new R17 gate.
  Implemented by **Claude Code outside the train** on the same branch: the bounded cleanup
  join rethrows the primary body failure with the cleanup failure as its `cause`, and still reports
  a cleanup-only failure. Completion reaches main with the reviewed, green PR merge.
- [x] Join checkpoint pre-attempt verification before session cleanup ([review residual #272](https://github.com/agentkitai/agentrig/issues/272)):
  register every started per-session verification/Git promise and drain it in `endSession` before
  releasing the lease, so a later-turn hook timeout cannot abandon work whose Git children still own
  the repository. Implemented by **Claude Code outside the train** on the same branch, with
  a deterministic abandoned-verification regression; fail-closed denial, lease refusals and bounded
  cancellation unchanged. Not a fix for the #244 Windows fixture timeouts.
  Completion reaches main with the reviewed, green PR merge.
- [x] Refresh the skill catalogue at a fresh-conversation boundary ([feel #267](https://github.com/agentkitai/agentrig/issues/267)):
  slash completion/composition, the model's `skill` lookup, the system-prompt catalogue and the
  next children move together to one immutable generation at `/new`; a running conversation and an
  already-spawned child keep the generation they started with. Implemented by **Claude Code outside
  the train** on `fix/followups-skill-refresh`: a `SkillCatalog` holds the generation, `/new`
  rescans exactly the roots configuration resolved, and a refused rescan is reported with the
  previous generation left in force — never a partial swap. Trust, source precedence, symlink,
  byte and collision controls are the same loader's, unchanged. A session that started with no
  skills has no `skill` tool or catalogue block to move and still needs a restart; that limit is
  deliberate, since conjuring a tool mid-process would change the advertised tool list.
  Completion reaches main with the reviewed, green PR merge.
- [ ] Isolate tests from shared `/tmp` Git-root interference ([feel #271](https://github.com/agentkitai/agentrig/issues/271)):
  preexisting reviewer first-run failure, followed by passing isolated/full runs;
  include with END test followups, not a new R17 gate or parent code workaround.

- [x] Historical review evidence [#261](https://github.com/agentkitai/agentrig/issues/261): independent exact-head build/test/typecheck reproduced and publicly recorded; original Codex limitation retained, not rewritten. [Verification receipt](https://github.com/agentkitai/agentrig/pull/234#issuecomment-5588358212).
- [x] Core lifecycle: [#272](https://github.com/agentkitai/agentrig/issues/272) later-turn cleanup is implemented in the checkpoint batch above; #244's fixture strands landed separately in PR #284, with its late-permission shutdown repair still pending.
- [x] Memory session-end ingest: [feel #275](https://github.com/agentkitai/agentrig/issues/275),
  timeout errors now name the operation and distinguish a per-call limit from the overall run
  budget. Defaults and partial-usage accounting are unchanged; the original 30s message does not
  establish that the 300s budget expired. Implemented on `fix/followups-maintenance-timeouts`;
  completion reaches main through the reviewed green PR.
- [x] PR276 probe followups: [#277](https://github.com/agentkitai/agentrig/issues/277) stop evidence asserted; [#278](https://github.com/agentkitai/agentrig/issues/278) natural failure exit flushes pending output while remaining fail-fast; [#279](https://github.com/agentkitai/agentrig/issues/279) independent four-of-five fail-first receipt recorded alongside staged history. Implemented in the separately authorized existing-issue sweep, not another PR276 repair cycle. Completion reaches main with the reviewed, green batch merge.
