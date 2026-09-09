# R17g — CLI runtime followups

This is the runtime portion of the existing CLI package batch, not a new milestone.
Evaluation/workflows and UI/input/theme dispositions are recorded in
[R17g-cli-evaluation.md](R17g-cli-evaluation.md) and [R17g-cli-ui.md](R17g-cli-ui.md).
Root owns the single package review, integration, PR and delivery gates. No live
provider, OAuth, desktop notification, clipboard or evaluator experiment was run.

## Fragment dispositions

| Existing fragment | Disposition and evidence |
| --- | --- |
| R15k ignored clipboard gesture | Implemented: controller prints a fixed busy notice before reading or queuing clipboard work. Actual Ink/startup fixture checks permission-pending notice and unchanged read count; ordinary/protocol input controls remain. Pre-session completion audit is declined: no session exists to own a canonical event; existing local UI output is not execution or provenance authority. |
| R4c disabled restore adapter / omitted option | Implemented: run/start construct adapters only for explicit enabled restoration; shared supervisorOptions also omits disabled adapter and callback. checkpoint-undo tests cover omitted and false options through actual supervisor-requested abort, changed bytes retained and no restoration call. Enabled joined restore controls are preserved. Existing abortNotice/SIGINT paths retain the join notice; no forced cleanup. |
| Exact-repeat partial-ledger warning | Implemented in run.ts supervisorOptions callback: deduplicate only identical corruption lists; healthy observation resets dedupe and changed unknown history is printed. run-flags controls distinguish repeats, changes and reset. No generic cache or evidence suppression. |
| Scheduler stamp reset | Implemented fixed existing-command recovery guidance for a missing dream stamp/wiki in memory.ts. Existing protected writer/lock contract is unchanged; no automatic deletion. |
| R6e promotion diagnostics | Implemented separate provider-construction/credentials failure category and single proposal print on confirm; memory-promotion controls retain assessment refusal and unknown semantics. Core/memory owns the bounded rationale contract. |
| R9a export redaction | Implemented logical-value counting without recounting placeholders and safe post-redaction label/field-bound refusal. session-export controls retain unchanged raw logs. |
| R7a preview | Implemented explicit model-free/ignored execution-option explanation; it does not create claims or validate provider readiness. Decimal-spelling tightening and an alternate cwd selector are declined: current finite numeric spelling/configured project contract is intentional, and neither fixes a demonstrated acceptance defect. |
| R7b heartbeat | Implemented typed heartbeatMaxTurns on RunOptions and explicit question-disabled assertion in heartbeat test. Trusted runtime-only heartbeat profile remains internal; introducing a new public checklist schema is declined because the actual schedule loader already validates the file and builder distinguishes empty/checklist without interpreting prose. Quiet success retains accounting-only artifacts. |
| R7c receipt diagnostics | Implemented safe log/ack/lock filenames, malformed-ack and UTF-8/read diagnostics, maintenanceFailed comment includes startup hooks/MCP/skills, and stat avoids reading the log twice. Tests retain malformed bytes, live lock and acknowledgment cutoff semantics. Lock retry is declined: no observed starvation justifies new waiting/cancellation behavior; never steal locks. Custom-memory dream cadence is declined: changing configured maintenance selection would expand a diagnostic followup into a new scheduling policy. |
| R8a ACP | Added explicit cancellation-versus-completion race documentation and actual 33 advisory-block refusal before any model request. Existing SDK cancellation/late-approval reservation tests remain authoritative. Frame deduplication and count tuning are declined absent measurement; byte/count reserves must not be relaxed. |
| R8b MCP | Implemented Unicode-safe task chunks and one fixed stderr notice per server for SDK errors, with no raw exception content. Actual runtime Unicode fixture and installed real-SDK callback control cover the two paths. This does not promise all SDK errors terminate the connection or reach this callback. Partial-frame concatenation optimization is declined without measured pressure under the existing bounds. |
| R15e review | Implemented fixed malformed-input and policy refusal categories; unknown Git/provider/path exceptions remain generic. Actual review controls verify no provider/process call for invalid arguments and no secret reflection. |
| R15f CI reports | Implemented inert multiline preservation and UTF-8-safe prefix capture/render. Once any code point is omitted, later deltas cannot fill remaining bytes and splice a non-prefix suffix. New-turn capture resets independently; partial warning remains. Redundant canonical-parent symlink check removal is declined: no correctness benefit warrants weakening defense in depth. |
| R15i standalone cap wording | Implemented refusal names both --daily-cap and trusted dailyCap config; direct role construction test proves no fetch. Ledger folding cache is declined without measurement and a design retaining prefix-integrity checks. |
| R15j provider effort cache | Implemented configured-default/explicit-same-effort cache identity; different efforts remain separate and are metered once. Duplicate validation removal is declined because admission checks must precede construction/decoration and no measured cost warrants relaxing them. |
| R16e notifications | Small help typo and typed schedule preview option corrected. Config schema split and headless typing are owned by the UI subset; no delivery claim is duplicated here. |
| R8d web | Implemented fixed actionable loopback bind/port refusal; tests prove bad hosts do not start the bridge. Unknown permission-kind policy and Writable.end(chunk) support are declined: neither is emitted by the supported server/bridge contract; hypothetical compatibility must not widen authority or bypass output reservations. |
| R5c linked sources | Updated plan explains pnpm-store hardlinks deliberately refuse and independent source trees are required. Filename casing is already delivered in #214, not reimplemented. |
| Generated discovery propagation | Added actual program parser TUI and sessions resume controls for positive/negative generatedSkills and memory option keys. Existing runtime tests cover emitted/manual/provenance behavior. |
| R10c stale plan header | Corrected to delivered #181 while preserving original implementation/review history. |
| R15l optional runnable SDK composition | Declined: shipped R15l already documents trusted finite fanout, independent candidate checks, serial authorized application and stale-parent refusal, with executable real-Git isolated-subagent tests. A credible runnable example requires operator-specific verifier/applicator policy and credentials; an abbreviated automatic merge recipe would conceal those boundaries rather than add a tested user capability. No loader, engine, automatic merge or new issue. |
| Install journal/recovery | Declined a new durable recovery command: ownership/quiescence and evidence retention require a separate explicit design; preserve existing protected backups and manual recovery, never infer safe deletion from a stale marker. |
| Fixture preflight / historical Windows races | Already delivered fixture-preflight.mjs detects foreign ancestor .git before tests without deleting or bypassing it; #284/#287 controls remain evidence only for their precise failures. No speculative global timeout, retries or historical-cause claim. This batch uses a private checked TMPDIR. |

## Cross-package / attribution boundaries

- R12c sandbox escalation still had two uncorrelated live permission decisions in
  core/tool-execution.ts. A minimal additive patch was provided to the root for
  the core owner (toolUseId/tool; boundary ask and handler/unattended final source).
  It is not applied or claimed delivered by this CLI subset. The ordinary final
  dispatch receipts already have correlation; do not suppress their separate ask
  and answer lines as duplicates.
- MCP definition-change approval occurs in buildAgent **before a session or live
  tool call exists**. Its callback and startup receipts/pinning tests are evidence
  of startup validation, not canonical tool permission decisions. A synthetic
  toolUseId or borrowed future session would be false attribution, so a new
  pre-session event contract is explicitly declined here.
- R15a controller null replies mean unavailable, not necessarily timeout. Core
  installs its deadline before question.asked emission and before invoking the
  controller handler; it owns canonical timeout/cancelled attribution. The later
  controller timer also bounds direct trusted SDK use without a core question
  runtime. Do not classify every null/closed UI reply as a timeout or lengthen
  deadlines to hide the distinction. `question-deadline.test.ts` exercises the
  actual core handler and controller: deadline advancement starts only after
  handler readiness, canonical answered outcome is timeout, no second provider
  request or permission grant appears, and cleanup joins the session.
- Role directory canonical diagnostics belong to the core role-loader fragment,
  not a second CLI role parser. Integer turn-limit startup validation is already
  delivered #216; current CLI changes do not alter budgets or delegation.

## Validation and negative controls

Private TMPDIR `/var/tmp/agentrig-r17g-cli-runtime-tests.5MPOfk` passed the fixture
preflight; no foreign marker was removed. Source typecheck passed after the typed
heartbeat option and runtime additions. Coordinated CLI rebuild completed before
subprocess controls; final combined root build/full gates remain separate.

- Real prefix fail-before: 16,383 ASCII bytes + emoji, then a later `Z`, incorrectly
  captured `Z`. Original log `/var/tmp/r17g-cli-prefix-before.log`. Fixed case passes;
  an initial after-test typo expected the word "truncated" instead of the existing
  "omitted remainder" marker; corrected without changing production wording.
- Ack diagnostics fail-before lacked schedule.ack.json; after correction notice
  and acknowledge retain malformed bytes and expose only a safe filename.
- Mutant removing the SDK stderr notice fails the once-only callback control.
- Mutant reinstating the disabled restore adapter fails both omitted/false cases.
  Both mutants restored; no altered production source retained.
- Initial focused runtime run: 47 tests / five files pass. Subsequent ten-file
  actual runtime suite: 152 tests pass, including Ink, local HTTP adapters, ACP,
  reports, heartbeat, export and MCP. These are focused results, not a claim that
  the root's required Docker/browser/full-suite delivery gates have run.
- Final restored combined focused run: **200 tests / 16 files passed** in 12.27s,
  including the actual deadline and aborted omitted-restore controls. Log:
  `/var/tmp/r17g-cli-runtime-handoff.log`. `git diff --check` passed.

Root-authored earlier evidence is preserved: initial report fail-first accidentally
ran the full suite (3,601 pass, two intentional failures, four skips), then the three
report tests passed. Provider-effort and MCP Unicode controls had two valid original
failures; one meter-count expectation was corrected to measure construction delta.
Original logs remain under `/var/tmp/agentrig-r17g-work.jgHSd9`; no new broad review
has been initiated by this helper.
