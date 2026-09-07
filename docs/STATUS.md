# Status

## R17b final repair round 3/3 — builder agentrig, conductor 2aa2f739

Repair session **b12646c7**, sixth known implementation/arbitration child; zero
spawned children. Existing single worktree, branch feat/r17b-defaults, PR #234.
Old head `e5b8044f86b9edbcc7ada95e2c7dde8db6e9d715`; current main is already
an ancestor. No rebase, new arbiter, second exception, review or merge by child.
All prior authorization, sandbox RECORD, human #248 resolution and session
history below remain in force. Prior sessions: builders 7dbfad2b, b9109d9f;
arbiter 1bb8ec86; fixers 12b8dd75, 633e8e44; conductors 8fbde1a3, 38c4612d,
2aa2f739. See [round-3 receipts](plans/R17b-round3.md).

**Historical evidence correction:** round-2's local 213-file/3379-passed/4-skipped
trio and auxiliary receipts are dirty-tree-only, not reproducible from clean old
head. Hosted run 34157135772 failed Ubuntu and macOS at
recommended-defaults.test.ts:117; Windows passed and structure passed separately.
Neither reviewer reproduced the retained PTY/E1 receipts. They are not current
clean-head or independent-review evidence.

Accounting: six known implementation/arbitration children, one historical halt
(#248, human resolved), no new halt. Historical round-2 main-model snapshot is
247595 uncached input + 15526 output + 938752 cached input = 1201873 tokens;
auxiliary separate, never a row total. Prior feel issues remain below, including
#251 orphan worktree index.lock and #252 initial Claude provenance failure
(retry succeeded using sole claude-opus-5). No new AgentRig friction observed.
Current fixer snapshot (session b12646c7 through event 688):
337277 uncached input + 17980 output + 1288576 cached input =
1643833 main-model tokens; auxiliary separate, later turns excluded.
This is the final repair round, not a reset. Independent delta review remains
required; residuals must be tracked, not waived.

Round-3 clean candidate 47b4ecd464a3ef769a4e5753081c15c2ee5adf09: build **0**,
test **0** (213 files, **3386 passed / 4 skipped**, 3390 collected), typecheck **0**;
final receipt-only head gets the same clean trio before push (exact SHA/exits in
PR #234). Hosted at receipt commit: **not yet pushed/not run**, not green; final
hosted snapshot is recorded on the PR. PTY smoke and latency scripts exit **0**;
E1 reproduction exits **1**, six PASS/two manual BLOCKED, all behavior checks PASS,
seven unavailable-checker results retained. No all-E1-green or reviewer-reproduction
claim. Full bounded observations and separate new receipts: R17b-round3.md.

### Historical round-2 record (superseded where corrected above)

## R17b repair round 2/3 — builder agentrig, conductor 2aa2f739

Prior halt feel #248 is resolved by the human outside the train: restore diagnostics
under the existing acceptance, not a new exception; no second arbiter. This is
round 2 of the three-round cap, preserving completed round 1 and the sandbox
approval by 1bb8ec86. Previous conductors: 8fbde1a3, 38c4612d. Prior children:
7dbfad2b, 1bb8ec86, b9109d9f, 12b8dd75. This continuation is the fifth known implementation/arbitration child (builder
agentrig; external-review child counts are unavailable here); it spawns zero children. Current child token/session telemetry is not
available in this tool surface; prior partial snapshots remain below, not totals.
One prior halt (#248); historical friction and accounting are preserved.
Round-2 repairs and reproducible evidence: [R17b-round2](plans/R17b-round2.md).
Local build/test/typecheck exit 0 (213 files, 3379 passed / 4 skipped).
No child spawned. Feel #251 records orphan worktree index.lock friction before
recovery (cause unverified); exact pushed-head CI is reported in PR #234.


## R17 builder gate

Every R17 PR body and STATUS entry names **builder agentrig, conductor 8fbde1a3**,
or names the blocking `feel` issue if AgentRig could not build it. Record child
count, observable token usage (never an invented estimate), and halts for each row.
File AgentRig friction with the `feel` label before the next child starts.

- **R17b repair round 1/3 — builder agentrig, conductor 8fbde1a3.** Child 4
  `12b8dd75` repairs all 13 Claude findings and the shared Codex TUI finding on
  existing PR #234; no nested builder, arbitration or PR merge. Baseline-first
  history retained; the sole sandbox deviation remains unchanged. Full resolution,
  real mutation probes and reproducible measurements: [repair ledger](plans/R17b-repair.md).
  Pending fresh independent delta pair on the pushed head; no clean-review claim.
  This repair has no human permission pause. Known feel issues #235/#236/#237/#239
  remain referenced, not used to waive any open review finding. Available repair
  usage snapshot through canonical session `12b8dd75` seq 1067: 89 model responses,
  input 667,812 / output 35,068 / cache-read 3,748,992 / cache-write 0 (not final totals).
  Per-response accounting is committed in `plans/R17b-repair-accounting.json`.
  Merged moved main `7841b88` without rebasing. Green local trio: 212 files,
  3,366 passed / 4 skipped; CLI-workspace runtime probe 1 passed. Hosted exact-head
  CI is recorded in the PR after push. New workflow feel #245 records the
  workspace-relative Vitest include friction (session 12b8dd75, call seq 1055,
  result seq 1080); successful explicit-root invocation is recorded, not waived.

- **R17b implemented, awaiting independent review — builder agentrig, conductor
  8fbde1a3.** Existing single worktree/PR [#234](https://github.com/agentkitai/agentrig/pull/234);
  baseline-first history preserved. Three children: builder `7dbfad2b`, arbiter
  `1bb8ec86`, continuation builder `b9109d9f`; human pauses **2** (prior **1** plus one
  scoped permission wait in this continuation, feel #236). [Defaults/migration](DEFAULTS.md), [plan/evidence](plans/R17b.md).
  Every changed flag: `--supervise`, `--no-supervise`, `--checkpoints`,
  `--ingest-on-end`, `--no-ingest-on-end`, `--notifications <mode>`, `--verbose`.
  Security defaults (`ask`, sandbox, grants, fail-closed manifests) unchanged.
  The **only approved deviation** is arbiter `1bb8ec86`'s host-hook exception:
  implicit checkpoint/ingest only with absent/none sandbox, visible omission under
  enforcing sandboxes, explicit opt-ins retain the core fail-closed startup error.
  ROADMAP has exactly its authorized phrase replacement; acceptance/renunciation unchanged.
  Fail-first config tests and defaults-disabled real-CLI mutation fail as expected;
  real CLI and PTY smoke cover diagnostics, rendered Markdown, checkpoint event and
  completed ingest without config. Root help remains **2 options (<40)**.
  Observable tokens from canonical `model.response.usage` events, separate fields
  (not billing estimates): builder `7dbfad2b`: **550715 input / 24997 output /
  2032256 cache-read** (72 responses); arbiter `1bb8ec86`: **107642 / 2239 / 113536**
  (10 responses); continuation `b9109d9f` partial snapshot: **708390 / 26320 /
  1939712** (72 responses, through event sequence 865). Conductor separately:
  **184729 / 4892 / 340864** (18 responses); continuation/future review totals are
  not complete and no unseen usage is estimated.
  Feel [#232](https://github.com/agentkitai/agentrig/issues/232) remains documented;
  [#233](https://github.com/agentkitai/agentrig/issues/233) is handled by the approved
  exception; new [#235](https://github.com/agentkitai/agentrig/issues/235) records
  ingest writes invalidating the terminal checkpoint ownership seal (checkpoint
  creation succeeds; undo can remain unavailable, and its safety guard is unchanged).
  Feel #236 (filed by the operator) records the 77-minute `attempt_log` approval
  wait: canonical continuation events **790 ask → 791 allow**, with no bypass.
  Feel #237 records a shared `/tmp/.agentrig` marker changing fixture trust roots;
  validation uses clean `TMPDIR=/var/tmp` without deleting the marker or changing
  product trust. `pnpm build`, `pnpm test`, `pnpm typecheck` exit **0** (211 files, **3337 passed /
  4 skipped**). Exact-head CI is verified in the PR handoff record after push.
  Independent external reviews follow in the conductor; no reviews or merge by this child.
R17 checkpoint/ingest visibility repair (outside train, 2026-09-07): conductor
`8fbde1a3`, continuation builder `b9109d9f`, reported
[feel #235](https://github.com/agentkitai/agentrig/issues/235) from nested fixture
`2eda835f`. Codex's outside-train diagnostic repair distinguishes retained checkpoint
snapshots from unavailable verified undo, and names session-end memory maintenance
as a possible cause without asserting ownership of those writes. Real-Git/fake-provider
tests cover completed ingest with tracked/untracked wiki files, an unrelated human
edit during ingest, unchanged refusal/no restoration, and successful undo without ingest
or with an ignored untracked wiki whose ingested bytes remain intact.
No ingestion is skipped, exclusions widened, or ownership checks changed. This does
**not** repair the integration limitation: R4b deliberately refuses to seal covered
session-end changes. Issue #235 remains open for that capability decision, recorded
at the end of the roadmap, not as a new blocking R17 subrow. No R17 row is completed
by this diagnostic repair.

Review follow-through distinguishes the new seal-time message from the unchanged
explicit-undo refusal, asserts the latter exactly, and clarifies tracked/unignored
wiki coverage. The ignored-untracked control also runs real ingest. An actual
TypeScript 5.9.3 compiler check inferred `checkpoint.created` at the questioned
`events.find` declaration and reported no test-file diagnostics; no speculative
cast was added. Replaying the stored reason at the undo entry point remains an
explicit follow-up, not a change to ownership or an implemented capability.

The subscription-capacity halt ([feel #246](https://github.com/agentkitai/agentrig/issues/246))
interrupted the train and outside repair before landing. The diagnostic branch was
preserved unpushed at `5267c04b482242fa24ac1042570a4bff44edf568`. After the user
reported a quota reset and authorized resumption, Codex resumed this outside-train
repair; that authorization is not itself proof of provider recovery or train progress.
The completed Claude delta review reported convergence; Codex identified that
`toThrow(string)` only checks a substring, so the refusal assertion now compares
the error's message property exactly. Prior review evidence and limitations remain
applicable; neither an interrupted review nor green CI replaces the remaining gates.

R17 PTY/monitoring recovery (outside train, 2026-09-07): Codex documented the
task/paste-versus-Enter protocol for [feel #232](https://github.com/agentkitai/agentrig/issues/232)
and added a trailing-Enter regression test without changing input or permission
semantics. Continuation child `b9109d9f` waited roughly 77 minutes for an
`attempt_log` approval while its parent conductor `8fbde1a3` stayed pending on
`subagent`, after the operator ended its monitoring turn
([feel #236](https://github.com/agentkitai/agentrig/issues/236)).
The operator pressed `y` (allow once) for the write-outside-cwd expansion, not
`s` plus scope confirmation; no standing grant was created. It resumed recursive child
monitoring; this was an outside-train operator failure, not a model halt or a
reason to weaken security. A saved status script alone is not unattended monitoring.
See [train operations](TRAIN-OPERATIONS.md) and the [PTY protocol](TUI-SETTINGS.md#driving-the-tui-from-a-pty).
R17b remains in progress in PR #234; no roadmap row is completed by this repair.

The same outside-train repair encountered Windows CI failures: aggregate package
scan timeout [#240](https://github.com/agentkitai/agentrig/issues/240), then a
different maintenance-fixture deadline [#242](https://github.com/agentkitai/agentrig/issues/242)
on the single unchanged rerun. Maintenance cases now use independent fixtures
and at most two CLI launches per case, preserving each five-second command bound
and fifteen-second case bound. Controlled 3.2-second startup delay fails the old
combined case but passes all ten split scenarios; a six-second delay still fails
at the command bound with SIGKILL and joined cleanup. Production behavior and
assertions are not relaxed. The original Windows failures remain recorded.

R17 skill-selection recovery (outside train, 2026-09-07): the user resolved
[feel #229](https://github.com/agentkitai/agentrig/issues/229) by authorizing R17g
as sequential package PRs; R17b–R17f remain one PR per row. Conductor `c1a25934`
timed out its clarification before any child; `3a98263d` restarted with the explicit
exception and successfully spawned builder `ddadeef7`. That child loaded arbiter
and refused implementation; no worktree or PR was produced. Conductor filed
[feel #230](https://github.com/agentkitai/agentrig/issues/230) and stopped.
The catalogue's concrete first-entry "First call" example named arbiter. Codex's
outside-train repair removes that accidental role-selection cue, instructing callers
to select by the task rather than catalogue order. Descriptions/triggers, byte caps,
on-demand loading, remote advisory status and skill authorization remain unchanged.
Tests cover both arbiter/dogfood orders and actual CLI generated/manual catalogues.
This fixes the misleading cue, not a guarantee of model obedience. After review,
tests and green exact/post-merge CI, restart the clarified authorization with the
same R17f 12,000,000-token allowance and canonical-event/permission monitoring.

R17 monitored restart recovery (2026-09-07, outside train): conductor `c10db599`
repeated invalid `agent: "builder"` calls despite #226's explicit guidance. The
operator detected the recurrence from canonical events and aborted after 24 turns,
before any child/PR/branch; [feel #227](https://github.com/agentkitai/agentrig/issues/227)
records the failure. Codex's outside-train repair now narrows the model-facing tool
schema to configured role names, omitting `agent` when none exist. Runtime validation
still refuses stale/forged unknown names rather than silently creating a generic child.
Fake-provider request tests fail before this change and cover both empty/configured
catalogues and actual generic recovery. This is structural discovery guidance, not
a guarantee that a model obeys its schema. Routing and security remain unchanged.
After reviewed, tested, green-CI merge, restart the same authorized topic prompt and
continue canonical-event monitoring. No R17 row is claimed complete by this repair.

R17 outside-train recovery (2026-09-07): conductor `37b744e0` halted before
R17b after six invalid named-role calls; zero children, PRs, or merges. Blocking
[feel #225](https://github.com/agentkitai/agentrig/issues/225) is repaired outside
the train by Codex: the subagent description and refusal now name available roles
(including an explicit empty catalogue), distinguish roles from skills/job titles,
and show a generic invocation omitting `agent` and `provider`. Unknown roles still
fail closed. Fake-provider tests cover refusal followed by one successful generic
child with a one-child pool, with and without configured roles.

[Feel #224](https://github.com/agentkitai/agentrig/issues/224) was fixed locally
outside the train: `/home/amit/.local/bin/agentrig` now invokes the existing built
CLI with arguments preserved; a fresh login shell resolves it and `agentrig --help`
succeeds. No profile, routing, permission, or sandbox settings changed.
After review, green CI and merge, rebuild the CLI and restart with `/new` and the
same authorized R17b–R17g prompt (R17a gate, R17f 12,000,000 reported tokens).
Monitor canonical session events for child progress and terminal state; an idle
TUI process is not evidence of a running train. The older stop entries below are
historical. The recovery PR is built by Codex outside the train, not by agentrig.

Current user authorization: finish and merge PR #222, then stop again. No further
roadmap implementation is authorized in this pass. Integrating green main
e793fd0ffcfdb89b139d7cdab0d18132ead750e4; #219 and #220 are fully delivered.
[Final #220 receipt](https://github.com/agentkitai/agentrig/pull/220#issuecomment-5569761339),
all-four post-main CI34114715742 / structure34114715682 green.
#222's original Claude review and addressed findings remain valid: no source conflict
or production change during integration. Updated build/typecheck, full pinned-Docker,
Chromium and exact-head CI precede merge; final post-main receipt will be on PR #222.
All paragraphs below are historical checkpoints, not current continuation instructions.

Current user instruction: finish PR #219 and PR #220, then STOP and wait for further
instructions. Do not start more work. PR #222 (usage display, already opened) remains
unmerged. External roadmap PR #221 merged separately as fd350d1d6dc71dab5846f355ddf4b8e6ed2b873a;
its R17 additions are preserved, not started. #220 now integrates that updated main.
#219 merged as 2d13a2c0eae38bd358f6ab374725eb46beeeb10a after all-four exact-head
checks. Post-main CI34111975404 / structure34111975426 are all green;
[final receipt](https://github.com/agentkitai/agentrig/pull/219#issuecomment-5569398357).
#220 integrates that main and must pass combined local and exact-head checks before
merge, followed by all-four post-main checks. Integrated build/typecheck, full pinned
Docker 3,319 passed plus two skips /209 files (81.42s) and Chromium1/2.45s pass.
Final receipts are on the two PRs; this last implementation checkpoint predates #220's
merge, so its final delivered status must be read from the linked PR receipt.

Historical serializer implementation checkpoint:
The visible ROADMAP Delivery progress checklist marks #217/#218 done. Main ebfd10f8dac970a6560e451c7ebe42d9878cacdf
has all-four post-merge checks green (CI34109938845 / structure34109938825).
[Final receipt](https://github.com/agentkitai/agentrig/pull/217#issuecomment-5569123445).
The serializer129-reference control fails before the guard;128 with duplicates passes
the actual core parser. Ordinary evidence already has a128-session bound, so this is
defensive format coverage, not a claimed production exploit. [Contract](plans/skill-session-count-cap.md).
One Claude APPROVE (23 reported /24 requested), 76 focused tests, build/typecheck,
full pinned Docker3,318+2 skips and Chromium pass. Integration gates follow.
All earlier status paragraphs are historical checkpoints, not continuation instructions.

Historical fifth-pass checkpoint, preserved from PR #221:
Fifth pass, 2026-09-07: with every committed row done, ROADMAP gains R17 "feel and defaults"
(dogfood mandate, defaults pass, feel budgets in CI, permission friction, visible and tuned
supervisor/memory, then the follow-ups sweep). It sits at section 5 row 17, after R16 and
before the follow-ups. The follow-ups currently being worked continue. R17a is a gate, not a
PR: its artifacts are R17b's first commit, so the defaults pass is the band's first PR. PLAN §9's F3 Windows CI job is struck as built.

Historical implementation: bounded abort-grace fixture readiness repair, from green
main ebfd10f. No production changes. Original/delayed-start pair reproduces one
missing-warning failure before correction; both pass after observing the blocked
child terminal-store gate. Exact100ms grace, nonfatal warning and ordering remain;
finally releases the gate and joins the actual child. [Contract](plans/abort-grace-readiness.md).
Single Claude APPROVE15reported/24requested, no material findings; original
[receipt](plans/abort-grace-readiness-review.md) preserved. Build/typecheck,45focused,
full pinnedDocker3318+2 skips/209files and realChromium pass. Hosted delivery pending.
Entire END queue remains active;
independent serializer and status-accounting follow-ups proceed in other worktrees.
#217 and #218 are delivered with all-four post-main checks green:
[217 receipt](https://github.com/agentkitai/agentrig/pull/217#issuecomment-5569123445),
[218 receipt](https://github.com/agentkitai/agentrig/pull/218#issuecomment-5568955192).

Historical preceding checkpoint:

Current: continue through the entire END follow-up queue, with bounded independent
worktrees and serialized merges; batch completion is not a stop condition.
R16f no-usage status is active from green main ebfd10f. Three actual held-provider/
settled-missing ledger/controller controls reproduced zero-looking absent usage.
Additive report presence and footer wording only; accounting/permissions unchanged.
[Contract](plans/pending-usage-status.md).65 focused, build/typecheck, required
pinned Docker full3,325+2 existing skips/209files81.48s and Chromium1 pass.
One Claude APPROVE with two low notes,24 requested/16 reported; zero-call/legacy
compatibility closures tested and [original review](plans/pending-usage-status-review.md)
preserved. Hosted gates pending; no merge claimed.
#217 done: all-four post-main CI34109938845 / structure34109938825 green,
[receipt](https://github.com/agentkitai/agentrig/pull/217#issuecomment-5569123445).
#218 done: all-four post-main CI34108756786 / structure34108756915 green,
[receipt](https://github.com/agentkitai/agentrig/pull/218#issuecomment-5568955192).
The prior pending integration text below is historical.

Network override #218 merged first as main8f741a800cfef739993a04b9c1a33d37548cfc48
after all-four exact-head checks. Post-main CI34108756786 / structure34108756915
are pending; final hosted receipt is on PR#218. Capability summary #217 integrates it.
[Capability contract](plans/capability-evidence-summary.md). Four controls reproduced
the overclaimed source label before correction. One Claude APPROVE26 reported/24
requested; original [review](plans/capability-evidence-summary-review.md) retained.
20 focused, build/typecheck, full pinned Docker3,309+2 skips and Chromium pass before
integration. Original macOS CI failed an unrelated abort fixture's80ms startup race;
read-only controlled delayed startup reproduces the missing precondition. Failure,
diagnostic rerun and final integrated hosted results remain visible on PR#217.
Repair that fixture next, preserving assertions and joining child cleanup.
Prior #214–#216 are delivered on main5d91ce09686b634a35000afd2d3e20a57759cdc2,
all-four post-main CI34104220683 / structure34104220637 green.
[Final batch receipt](https://github.com/agentkitai/agentrig/pull/216#issuecomment-5568316748).
Earlier checkpoints below are historical, not current pending work.

Historical implementation checkpoint: one-invocation `--no-sandbox-network` config override, on a fresh
branch from green main5d91ce09686b634a35000afd2d3e20a57759cdc2. All END follow-ups
remain authorized work, with independent PRs and serialized green-main merges.
No runtime permission or sandbox-policy changes. [Contract](plans/no-sandbox-network.md).
Six named controls failed before registration (four config surfaces, actual inert
net dispatch, actual MCP login argv); omitted/positive runtime controls already passed.
All106 focused tests pass after the two-option change. Build/typecheck, required
pinned Docker full3,314 passed+2 existing skips/209files87.30s and Chromium1 pass.
One Claude APPROVE/no blocking findings,24 requested/21 reported; original
[review](plans/no-sandbox-network-review.md) retained. Hosted gates pending.

#215 is done as main f196709697b1832063ddee6288fdac004a2ee7d0, all-four post-main
CI34103360944 / structure34103361105 green. [Receipt](https://github.com/agentkitai/agentrig/pull/215).
#214 is done, all-four post-main CI34102581250 / structure34102581248 green;
[final receipt](https://github.com/agentkitai/agentrig/pull/214#issuecomment-5568048722).
#216 is done as main5d91ce09686b634a35000afd2d3e20a57759cdc2, all-four post-main
CI34104220683 / structure34104220637 green;
[final receipt](https://github.com/agentkitai/agentrig/pull/216#issuecomment-5568316748).
The earlier implementation checkpoints below retain their historical test evidence.

Historical implementation checkpoint: reject fractional subagent turn limits before provider
construction. [Contract](plans/subagent-integer-turn-limits.md). Eight new controls
fail before the correction; all61 focused CLI/config tests pass afterward, including
actual role spawning with omitted/default,2 and2.0 limits. Other numeric settings and
role-directory diagnostics are unchanged. Build/typecheck,95 focused tests,
required pinned Docker full3,280 passed+2 existing skips/209 files (93.36s), and
Chromium1 pass. One independent review APPROVE/no material findings, requested24/
reported26 turns; original result and limitations in the [receipt](plans/subagent-integer-turn-limits-review.md).
Hosted exact-head and post-main gates remain pending.
Base300c5e2 is the parent-confirmed green slash-suggestions delivery; earlier checkpoint
text below is historical, not a prohibition on this authorized follow-up.

Previous PR#212/#213 are delivered, all-four green main300c5e2
(CI34098667334 / structure34098667328); [receipt](https://github.com/agentkitai/agentrig/pull/213#issuecomment-5567492528).
Grapheme deletion shares one helper between composer and unconfirmed scope input.
Four actual prompt/scope tests failed before the fix; no normalization, policy or
paste-decoder changes. [Contract](plans/grapheme-editing.md). Hosted gates follow.
Prior checkpoints below retain the original sequence; independent ready items
are no longer held behind an artificial merge order.

Historical casing implementation checkpoint: shared package validation
now refuses noncanonical nested `SKILL.md` spellings before publication/loading,
while flat `.md` matching, core discovery and trust/path/byte limits remain unchanged.
[Plan](plans/skill-filename-casing.md). Six fail-before controls reproduced accepted
case variants; canonical install→trusted builder→core loading already passed.
All 70 focused package/install/runtime/core-skill tests now pass. One Claude
APPROVE (24 requested/8 reported) independently ran70 tests/typecheck. Build and
typecheck pass; full required-Docker3,278 plus two existing skips /209files (92.80s)
and real Chromium1 (2.52s) pass. Exact-head four-check hosted gates remain pending.
Unrelated hardlink-source follow-up stays at roadmap END. Earlier status is historical.

Active: follow-up pass authorized2026-09-07. Compaction PR#212 merged first as
main1cdfe53 after all four exact-head checks passed; post-main CI34097862173 /
structure34097862218 is pending. Slash suggestions PR#213 integrates that main.
This is the pre-delivery checkpoint; final hosted outcomes are recorded on
[PR#212](https://github.com/agentkitai/agentrig/pull/212) and
[PR#213](https://github.com/agentkitai/agentrig/pull/213), not inferred from labels.
No new PRs until both are delivered. Independent green fixes need not wait behind
an unrelated slower review; merges still require current-main and exact-head gates.
Existing roadmap implementations are delivered; END follow-ups are now the work
queue. The prior final delivery receipt is PR#211 comment5566809522, all-four
post-main CI34094733668 / structure34094733642 green on main db2271b.
Keep the previous checkpoints below as history, not the active queue.

Compaction implementation checkpoint:
[Contract](plans/compaction-zero-retention.md). Zero now retains the task plus
conservative advisory summary; positive-count tool-pair widening is unchanged.
Nine fail-before controls are restored; all 152 focused compaction/runtime/
provenance/thinking/manual tests pass. Build/typecheck, required-Docker full
3,252 plus two existing skips /209 files (84.19s), and Chromium (2.86s) pass.
One Claude APPROVE (24 requested /21 reported turns; typecheck executed, four test
attempts denied); original review and limits retained. Hosted four-check gates
were pending at the original checkpoint; PR#212 has now merged first as above.
Earlier implementation checkpoints below remain historical.

Final implementation: **R16h themes/keybindings**, integrated with delivered R16g.
[PR#211](https://github.com/agentkitai/agentrig/pull/211) holds the final hosted
delivery receipt. This is its pre-merge checkpoint; completed implementation does
not imply then-pending checks passed.
R16g PR#210 is done on main98eb403, all-four post-main CI34093472579 /
structure34093472588 green.
[Receipt](https://github.com/agentkitai/agentrig/pull/210#issuecomment-5566491322).
R16h build/typecheck,3,242 full tests plus two existing skips, real Chromium and
one static-only Claude approval are complete. Exact-head/post-main hosted gates
follow on its implementation PR; that PR holds the final delivery receipt.
No committed implementation remains afterward; optional polish stays at roadmap END.
Backlog drained; R15l #194 is done on main8fe6f29, all-four
CI34091238822 / structure34091238830 green.
[Receipt](https://github.com/agentkitai/agentrig/pull/194#issuecomment-5566147772).
[R16h contract and evidence](plans/R16h.md).
Earlier backlog checkpoints below are historical. #207 is done on `82b2f27`,
all-four CI34089126856 / structure34089126808 green.
[Receipt](https://github.com/agentkitai/agentrig/pull/207#issuecomment-5565941414).
#194 integrates separately merged CI optimization #209, green main716f810
(CI34089870734 / structure34089870726), unchanged. #205 is done on main
`08c64d0`, all-four CI34087753211 / structure34087753175 green.
[Receipt](https://github.com/agentkitai/agentrig/pull/205#issuecomment-5565748630).
#201 is done on main
`8da21be`, all-four CI34086055156 / structure34086055211 green.
[Receipt](https://github.com/agentkitai/agentrig/pull/201#issuecomment-5565536470).
Only merges are serialized; independent existing PR preparation may run in
parallel. The prior R16g/R16h backlog freeze is lifted.
Earlier integration checkpoints below retain their historical pending gates.

Historical attachment integration checkpoint:
R15k #207 integrated main `08c64d0`, preserving provider selection, status,
notifications, diffs and all fixture repairs. Build/typecheck and 92 focused shared
runtime/Ink controls pass; required-Docker full 3,168 passed plus two existing
skips /203 files (78.00s); actual Chromium one passed (2.67s). Original review and
material fix remain unchanged. Fresh exact-head four-check CI is pending; root
alone merges after both PR and #205 post-main gates are green.

Historical backlog checkpoint: **#205 → #207 → #194**. R15j #205 integrates merged #201
main `8da21be`; #201 post-main is pending. R16g/R16h remain frozen; no new roadmap work.

R15j integrated local gates pass: build/typecheck;133 focused selection/status/
notification/diff/approval/Ink tests; required-Docker full3,142 passed + two existing
skips /200 files (78.00s); actual Chromium1. New-head four-check CI remains pending.
Original failed205 runs34075001809 and34075890518 remain historical failures.

R16b #203 and readiness repair #208 are done on repaired main `18df259`, all-four
CI34084903634 / structure34084903714 green.
[R16b receipt](https://github.com/agentkitai/agentrig/pull/203#issuecomment-5565321833),
[repair receipt](https://github.com/agentkitai/agentrig/pull/208#issuecomment-5565321674).
Original #203 post-main CI34082267021 remains failed. Historical checkpoints below
retain then-pending gates; these completed receipts supersede them.

R16a #199 and bounded fixture repair #206 are done: repaired main
`0b65aa18c0f8629ee86186ccb0d7a1570fe51f3c` passed CI34078485717 and
structure34078485698, all four checks.
[Repair receipt](https://github.com/agentkitai/agentrig/pull/206#issuecomment-5564569066),
[R16a restored receipt](https://github.com/agentkitai/agentrig/pull/199#issuecomment-5564569218).
Historical checkpoints below retain their original failures and then-pending gates.

R15i is done (PR #202): main `9aca3915e98ca8331e1c25c8a7a0eeabe27a2066`,
CI34072279360 and structure34072279370 all four green.
[Final receipt](https://github.com/agentkitai/agentrig/pull/202#issuecomment-5563729106).
R15j implements next-run configured selection, preserving accounting and authority;
no live model/catalogue discovery. [Contract](plans/R15j.md). Delivered R16f status
is integrated; R16g/R16h remain frozen while the existing PR backlog drains.
R15j's one independent review approved the frozen implementation (actual 30 turns,
requested 24); its bounded-name observation and author replay-label correction are
fixed. Build/typecheck, full required-Docker (3,037 passed + two skips /190 files)
and real Chromium pass. Exact integrated-head CI and delivery remain pending.
After R16d integration: build/typecheck, 32 focused controls including actual Ink
completion, full required-Docker (3,069 passed + two skips /193 files, 70.75s) and
real Chromium pass. Original review remains the single frozen review; no repeat.
Initial R15j PR CI34075001809 passed Linux/structure but failed macOS/Windows on
two new ledger fixtures using non-canonical temporary roots. Explicit alias controls
reproduced both exact failures; fixture-only realpath normalization restores them
without weakening production trust checks or assertions. New-head gates pending.
Repaired full required-Docker: 3,071 passed + two skips /193 files (66.98s),
build/typecheck and Chromium pass; the original failed run is not rerun or hidden.
Second PR CI34075890518 passed Linux/macOS/structure but Windows hit the existing
four-child evidence-grading fixture's five-second outer timeout and EBUSY cleanup.
Repair #206's delayed-child control, bounded outer allowance and joined cleanup
are integrated unchanged alongside its generated-skills repair. Neither original
failed PR run is rerun; a new exact-head gate follows combined validation.
Repaired-main integration validation: focused35, build/typecheck, full required-Docker
3,088 passed + two skips /194 files (87.29s), actual Chromium1. Fresh PR gates pending.

### R16e done — PR #201; historical checkpoints — opt-in idle TUI notifications

Integrated #208 main `18df259`: documentation-only conflicts, original #203 failed
post-main and repair review retained. Build/typecheck, 165 focused controls,
required-Docker 3,123 plus two skips /198 files (76.57s), and real Chromium pass.
Fresh #201 exact-head and repaired-main all-four gates remain required; no second
review or new feature work.

Backlog-drain integration includes merged #203 main `2181859` and delivered #204
status. Build/typecheck, 123 focused plus 13 actual diff/approval controls, required
Docker full 3,120 plus two skips /198 files (73.53s), and real Chromium pass.
Both #203 post-main and #201 fresh exact-head all-four gates remain mandatory.
Only documentation conflicted; no new source fixes or review rounds.

Current integration includes repaired-green main `0b65aa1` (#206) and delivered
Markdown/history. Frozen install/build/typecheck, 89 focused controls, full
required-Docker 3,087 plus two skips /193 files (72.70s), and real Chromium pass.
Fresh exact-head CI is pending; earlier checkpoints below retain their dates/bases.

Independent row following delivered R15a, approved from green main `31193d6`;
R15g and other TUI rows retain their own PRs and serialized merge gates.
Default-off mounted-TTY observer uses actual prompt identities and input idle,
not OS focus, model prose or event permissions. Fixed desktop arguments and a
small shared owned-process helper preserve the review wrapper's prior behavior.
[Contract](plans/R16e.md), [operator guide](NOTIFICATIONS.md). Author build/typecheck
and full required-Docker suite pass 2,953 plus two skips /183 files. The single
independent review approved with no material findings and independently passed
the same full suite; it did not rerun build/typecheck. Integrated green R15g main
`74699da` retains both CLI surfaces: build/typecheck, 55 combined focused tests,
and full Docker 2,975 plus two skips /185 files pass. Exact-head/post-main gates
remain pending.

Historical: **grant-transition readiness repair**, not a roadmap item. R16b #203
merged2181859 after all four exact-head checks; post-main CI34082267021 failed
Windows `tui.test.ts:236`, first prompt in the existing real new-transition test.
Other160 tests in that group and Linux/macOS/structure passed. R16b delivery is
blocked, not done. [Failure and repair controls](plans/grant-transition-readiness.md).
Hold #201's merge until repaired main is green; then drain201→205→207→194.
No further unsubmitted roadmap work or parallel PR-refresh churn.

Repair review closure: one Claude REQUEST_CHANGES,24 requested/28 reported turns;
outer-timeout finding reproduced and fixed, both owned controllers joined before
cleanup. Final170 focused tests, build/typecheck, required-Docker3,106 passed
+2 existing skips /197files (75.64s), and actual Chromium1passed (2.36s).
[Original review and disposition](plans/grant-transition-readiness-review.md).
Repair #208 merged as `18df259` after all four exact-head checks. Repaired-main
CI remains pending; #203/#208 are not yet delivered. Immediate-next #201 now
integrates the repair without another review; its fresh checks are also required.

R16f runtime-backed status line is **done**, PR #204: exact main7fe3440 passed
all four checks CI34080476921/structure34080476920.
[Final receipt](https://github.com/agentkitai/agentrig/pull/204#issuecomment-5564785990).
Original review, runtime identity and display bounds remain in the
[contract](plans/R16f.md) and [operator guide](STATUS-LINE.md).

R16b captured transcript diffs #203 is merged at `2181859`; post-main CI `34082267021` and structure `34082267035` are pending. R8d is done (PR #197, all four post-main checks green). R8c is done (PR #192); R15a is done (PR #188 + repair #191); R15d is done (PR #189); R15f is done (PR #190); R15e is done (PR #186).
Active: **R16g manual TUI commands** in an independent worktree. Explicit compacted
forks, `/clear`, model-free `/doctor` and protected `/diff`; shared idle ownership
and joined cancellation. [Contract](plans/R16g.md). Focused actual-core/Ink/startup/
Git controls and three restored mutants pass. One Claude review: APPROVE, static
only (25 reported turns plus sole one-turn tools-disabled summary); no independent
test execution claimed. Its open seal-binding question produced an author-confirmed
cross-resume defect, fixed with a failing-before/passing-after actual-checkpointer
test. [Original review](plans/R16g-review.md). Aliased-temp ledger fixture correction
also reproduces/passes. Final post-fix build/typecheck and required-Docker full:
**3,090 passed plus two skips /194 files, 68.28s**, real Chromium one (2.37s).
Final queue integration and exact-head/post-main CI remain.

Integrated delivered status main `7fe3440`: actual owned-maintenance segment wins
over the selected parent's previous run; supervision is unavailable during
maintenance. Success/abort controls failed before the seam and pass afterward.
Build/typecheck, 91 focused tests, full required-Docker 3,124 plus two skips /197
files (73.14s), and real Chromium one (2.37s) pass. Provider-selection integration
remains pending its own delivery; no second review or hosted-gate claim.

Completed: **R16f truthful status line (PR #204)**, after completed R15i #202; independent from R15j provider switching and R16g maintenance. [Contract](plans/R16f.md).
Main `7fe3440b74aff06a91ec33682f02d9849b04f914` passed all four post-main
checks: CI `34080476921`, structure `34080476920`.
[Final receipt](https://github.com/agentkitai/agentrig/pull/204#issuecomment-5564785990).

R15i #202 is done: main `9aca3915e98ca8331e1c25c8a7a0eeabe27a2066`, CI `34072279360` and structure `34072279370` passed all four post-main gates. [Final receipt](https://github.com/agentkitai/agentrig/pull/202#issuecomment-5563729106). Earlier R15i validation checkpoints below are historical.

Completed: **runtime-fixture CI repair #206 and R16a #199**. Repaired main
`0b65aa18c0f8629ee86186ccb0d7a1570fe51f3c` passed all four post-main checks:
CI `34078485717`, structure `34078485698`.
[Repair receipt](https://github.com/agentkitai/agentrig/pull/206#issuecomment-5564569066),
[R16a receipt](https://github.com/agentkitai/agentrig/pull/199#issuecomment-5564569218).

Historical repair checkpoint: R16a #199 merged as339f795 after
all four exact-head checks passed; post-main CI34075972025 failed Windows in the
existing generated-skills runtime fixture at5,009ms. Linux/macOS/structure passed.
R16a delivery was blocked at that point. The repair also covers the existing
evidence-grading outer timeout observed on #205; no product deadline changes.
[Original failures and frozen repair contract](plans/runtime-fixture-ci-bound.md).
Feature merges were paused until the repaired-main all-four gate above passed.

### R15k prior implementation receipts (final integration underway)

Provider switching R15j has a separate owner; attachment authorization/provenance
uses the existing provider-neutral input path and does not depend on switching.

R16a #199 and runtime-fixture repair #206 are done on repaired main
`0b65aa18c0f8629ee86186ccb0d7a1570fe51f3c`: CI `34078485717` and structure
`34078485698`, all four checks green. The original failed main is not relabeled.
[Repair receipt](https://github.com/agentkitai/agentrig/pull/206#issuecomment-5564569066),
[R16a receipt](https://github.com/agentkitai/agentrig/pull/199#issuecomment-5564569218).

### R16d done — PR #200

Main `93452df95a731a38bd46badb78953d13a7c8f272` passed all four post-main checks:
CI `34073899219`, structure `34073899121`.
[Final receipt](https://github.com/agentkitai/agentrig/pull/200#issuecomment-5563937474).
Earlier R16d checkpoints below are historical.

### R15k implementation and verification in progress

[Contract](plans/R15k.md), [operator behavior and privacy](ATTACHMENTS.md).
Real TUI startup/core/provider fixtures cover file and clipboard input without
accessing any real clipboard, provider, authentication or network. Pre-session
completion has one-time configured-policy authorization and no standing grants;
actual payload reads use the canonical core pipeline. Single Claude review approved
with one material fix (24 requested /35 reported turns; 23 tests/typecheck executed).
The empty initial Anthropic text placeholder is fixed with matching runtime/replay
semantics; actual projection failed before and passes after. All 25 attachment
controls pass. Post-fix build/typecheck, Docker full 3,078 plus two existing skips
/194 files (70.32s), and Chromium (2.58s) pass. Original review retained;
updated-main integration and exact-head four-check CI remain pending.
Integrated repaired green main `0b65aa1`: frozen install/build/typecheck, 40 focused
attachment/Markdown controls, required-Docker full 3,095 plus two existing skips
/195 files (85.37s), and Chromium (2.65s) pass. Exact-head four-check CI remains
pending; later queued main changes will be integrated before root merge.

Historical repair checkpoint (now done via #206): **bounded runtime-fixture CI repair**. R16a #199 merged as339f795 after
all four exact-head checks passed; post-main CI34075972025 failed Windows in the
existing generated-skills runtime fixture at5,009ms. Linux/macOS/structure passed.
At this historical checkpoint R16a delivery remained blocked. The repair also covers the existing
evidence-grading outer timeout observed on #205; no product deadline changes.
[Original failures and frozen repair contract](plans/runtime-fixture-ci-bound.md).
Those gates are now closed by repaired green main `0b65aa1`.
Repair local verification: build/typecheck, required-Docker3,070passed +2 existing
skips /192files and actual Chromium pass. One static-only Claude APPROVE, no
material finding:24requested/25reported plus sole tools-disabled summary1/1.
[Original review and verification limits](plans/runtime-fixture-ci-bound-review.md).

Historical R16a implementation: **final-answer Markdown presentation**, PR #199. One Claude
REQUEST_CHANGES review (24 requested /20 reported turns); nested-block separation
fixed with three fail-before/pass-after controls. [Original review](plans/R16a-review.md),
[contract](plans/R16a.md). Current integration uses green main93452df (#200);
frozen install/build/typecheck and required-Docker full pass **3,068 tests plus
two existing skips /192 files, 69.23s**, plus real Chromium smoke (one, 2.47s).
Exact-head gates passed; post-main Windows failed as recorded above.


Historical R16d active checkpoint (superseded by the done receipt above): **R16d prompt history/completion** in its independent worktree; R16a has a separate owner/PR; R16c is done (PR #198); R8d is done (PR #197). R15h is done (PR #196), main `31193d6`, all
R16d is done: main93452df95a731a38bd46badb78953d13a7c8f272 passed all four
post-main checks CI34073899219 and structure34073899121.
[Final receipt](https://github.com/agentkitai/agentrig/pull/200#issuecomment-5563937474).
The R16d checkpoints below are historical; their then-pending gates are closed.
Historical R16d implementation: **prompt history/completion** in its independent worktree; R16a has a separate owner/PR; R16c is done (PR #198); R8d is done (PR #197). R15h is done (PR #196), main `31193d6`, all
four post-main checks green (CI34064151052 / structure34064151009).
[R15h receipt](https://github.com/agentkitai/agentrig/pull/196#issuecomment-5562704055).

### R16d done — PR #200; historical checkpoints

Current head integrates all-four-green main `9aca391` (#202), preserving delivered
#198/#197 and both independent test-readiness fixes. Frozen install/build/typecheck,
49 focused real history/question/approval controls, Docker full 3,053 plus two
existing skips /191 files (68.31s), and Chromium smoke pass. Final exact-head
all-four CI remains pending. Earlier checkpoints below retain their original gates.

[Contract and verification](plans/R16d.md), [original review](plans/R16d-review.md).
Independent start from green `31193d6` is explicitly allowed by ROADMAP §5;
no dependency or merge gate is bypassed. Both actual Ink paths support recall,
completion and multiline composition; trusted startup persists bounded history,
untrusted startup stays memory-only. Sensitive answers and history-only ingest
canaries remain excluded. Build/typecheck and 70 focused checks pass. Docker full:
2,960 passed plus two existing skips across 185 files (68.00 seconds).
One Claude review approved with fixes, 24 requested / 25 reported turns, with
32 independently run checks and typecheck green. Its required missing-STATUS
finding is closed by this section. Three named mutants fail and are restored.
The reviewer CSI-u hypothesis became an author-reproduced supported-key defect;
the bounded coalescing fix and five exact-text/no-premature-action controls pass.
Post-fix build/typecheck and Docker full pass 2,965 plus two skips (185 files).
Exact-head all-four CI and updated-main integration remain required before merge.

Integrated green R8d main `c59a446` without source conflicts. Frozen install,
build/typecheck pass; Docker full passes 3,005 plus two skips /188 files (68.18s),
and real Chromium ACP smoke passes. New exact-head all-four CI is pending; later
queued main changes must be integrated before root merge.

First integrated CI `34068326674` passed Linux/macOS/structure but Windows failed
two existing scoped-approval tests waiting one second for the next `onAsk` after
two real shell calls. Paired 1.1-second provider-delay controls reproduce the exact
failure. The fixture now uses existing four-second subscribed readiness for the
exact outside command, preserving all original grant/output/audit/count assertions.
No production changes; remote slow stage remains unproven. Build/typecheck,
56 focused tests, Docker full 3,007 plus two skips /188 files (64.15s), and Chromium
smoke pass. Original failed CI is retained; new exact-head checks remain pending.
R9c PR #183 is done: main `3b7564a`, CI `34047589688` and structure `34047589697` green.
R10b PR #177 post-main CI `34040691166` passed all three platforms.
R15b PR #185 is done: main `74c5073`, CI `34048869709` and structure `34048869702` green.
R15c is done (PR #193, all four post-main checks green).
The following R15c checkpoints are historical; the completed receipt below
supersedes their then-pending gates.

R16c is done (PR #198), after delivered R8d (PR #197). Main `130123eeb866906025aaeca9b1b2a7217e82a87b` passed CI34069082872 and structure34069082855, all four checks.
[Final receipt](https://github.com/agentkitai/agentrig/pull/198#issuecomment-5563369403).
Earlier local validation passed build/typecheck, 36 focused controls, real Chromium and full required-Docker (2,982 passed, two skips /186 files). [Contract](plans/R16c.md).
R15f is done: main `887fef8`, CI `34058784223` (three platforms) and scripted
structure `34058784219` all green. [Final receipt](https://github.com/agentkitai/agentrig/pull/190#issuecomment-5562115783).

### R16b in progress — captured transcript diffs

Integrated repaired green main0b65aa1: frozen install/build/typecheck,
74focused tests, required-Docker3,088passed +2 skips /195files,83.89s,
actual Chromium1passed,2.45s. No production conflicts or second review.
Those prior-head checks passed. #204 is now delivered; this branch integrates
its green main7fe3440 and requires fresh final exact-head/post-main gates.
Final local verification passes build/typecheck,70focused diff/Markdown/status
tests, required-Docker3,103passed +2skips /197files,74.05s, and actual Chromium
1passed,2.56s. Only docs conflicts; no second substantive review.

Bounded builtin before/after event observations and shared diff rendering for
completed edits and explicitly proposed permission excerpts. No preapproval read,
no renderer filesystem reads, no new tool authority. [Contract](plans/R16b.md).
Build/typecheck/full required-Docker pass: 2,976 tests plus two skips /187 files.
One independent review approved (13 reported turns, 219 independently passing
focused tests and typecheck); final integration/PR CI/post-main gates remain.
Integrated green R8d main `c59a446`: build/typecheck, full Docker 2,994 tests plus
two skips /188 files and actual Chromium smoke pass. Final exact-head CI pending.

### R15g done — bounded final-output schema validation

PR #195 merged as `74699dac9fd6a1914e741e5f102cdb36d4bcfb04`; all four post-main
checks passed (CI `34065775803`, structure `34065775875`).
[Completion receipt](https://github.com/agentkitai/agentrig/pull/195#issuecomment-5562920776).

Explicit local schema, strict offline subset, prompted default and operator-opted
OpenAI-compatible native mapping. Every final answer is locally validated; one
ordinary-budget repair has an actual tool-dispatch guard. Raw logs are preserved.
[Contract](plans/R15g.md), [operator limits and examples](STRUCTURED-OUTPUT.md).
One independent review and its material fix are complete. Final integration with
green reasoning/roles main `31193d6` passes build/typecheck and full Docker:
2,958 tests plus two skips /184 files. Final PR and post-main gates are closed:
main `74699dac9fd6a1914e741e5f102cdb36d4bcfb04`, CI `34065775803` and
scripted structure `34065775875` passed all four checks.
[Final receipt](https://github.com/agentkitai/agentrig/pull/195#issuecomment-5562920776).

Active row: **R16e opt-in idle TUI notifications**, reviewed; final integration/CI pending.
R9c PR #183 is done: main `3b7564a`, CI `34047589688` and structure `34047589697` green.
R10b PR #177 post-main CI `34040691166` passed all three platforms.
R15c implementation and the single review's compaction fix pass 56 focused tests
and full Docker validation (2,873 passed, two skips, 177 files) on `ff6758c`.
Original review: REQUEST_CHANGES, requested 24/reported 27 turns; three compaction
controls reproduce on reviewed code and pass after correction. Author pre-auth
refusal control also fails before/passes after. Exact PR/post-main gates were pending then.
Integrated green main `b3bb06a` with R15f/R8c: install/build/typecheck, 59 focused
controls and full Docker **2,913 passed, two skips, 180 files, 59.52s** pass.
Actual CI CLI signed-thinking replay excludes all reasoning from report/telemetry
while preserving canonical logs. Exact-head and post-main CI were pending then.
R15a #188 and child abort-hook fixture repair #191 are done: repaired main `3174475`
passed Linux/macOS/Windows CI `34056045886` and structure `34056045804` without reruns.
[Repair receipt](https://github.com/agentkitai/agentrig/pull/191#issuecomment-5561792580);
[R15a completion](https://github.com/agentkitai/agentrig/pull/188#issuecomment-5561792722).
The original macOS failure stays recorded; production cancellation was unchanged.
R15d #189 is done on main `8da49d4`: all four post-main checks passed in
CI34057526815 and structure34057526836.
[Final receipt](https://github.com/agentkitai/agentrig/pull/189#issuecomment-5561947394).
R15e #186 is done with all four post-main checks green. R15b PR185 is done; all four exact post-main checks are green. R8a PR184 is
done; all four exact post-main checks are green. R9c PR183 is done: all four post-main
checks passed, [final receipt](https://github.com/agentkitai/agentrig/pull/183#issuecomment-5560847346).
R7c #182 is done: exact CI34045100748 and post-main CI34045706663 all three green.
[Final receipt](https://github.com/agentkitai/agentrig/pull/182#issuecomment-5560657382).
R10b PR #177 post-main CI `34040691166` passed all three platforms; R9b proceeds independently.
[Reporting contract](plans/R7c.md). R7b PR #179 passed exact CI `34041871904`
and post-main CI `34042336391` on all three platforms.
[Final delivery receipt](https://github.com/agentkitai/agentrig/pull/179#issuecomment-5560275859).
R10c PR #181 merged as `7b6cb6a`; post-main CI `34044235154` passed all three platforms.
R9b PR #180 is done: main `5344291`, post-CI `34044946044` all three green.
[Final R9b receipt](https://github.com/agentkitai/agentrig/pull/180#issuecomment-5560574618).
R7c PR #182 is done: main `b2390ce`, post-CI `34045706663` all three green.

Completed repair #178: **A1/A2 real-copy fixture scheduling bound**. R7a PR #176 merged as
main `bf65aec` after exact-head CI `34038810158` passed all three platforms.
Post-main `34039249249` then failed the unchanged A1 outer five-second test timeout
on Windows (6,261 ms); Linux/macOS passed. The separate test-only repair preserves
all seeded-regression assertions and subprocess bounds. A controlled delayed
fixture failed before and passed after the explicit outer bound, then the delay
was removed. [Evidence and contract](plans/evalset-fixture-bound.md). No blind rerun;
Repaired main `90301f8` passed all three platforms in post-CI `34040182760`.
[Repair receipt](https://github.com/agentkitai/agentrig/pull/178#issuecomment-5560043282);
[R7a restored receipt](https://github.com/agentkitai/agentrig/pull/176#issuecomment-5560043445).
Repair build/typecheck/full passes 2,597 plus two skips across 149 files (four
workers, 39 seconds). The single bounded review approved and independently passed
all 15 evaluation tests plus typecheck; original findings are retained in the plan.
Repair exact-head CI `34039760450` and repaired-main post-CI are green; the original failed run remains failed.

Active implementation queue: **R5c is done (PR #170, post-merge CI green); R14d and R10a are done (PRs #172/#174, post-merge CI green); R10b is done (PR #177, post-main CI green); R7a is done (PR #176, restored by repair #178 with repaired-main CI green); R7b is done (PR #179, exact-head and post-main CI green); R7c is done (PR #182, post-main CI 34045706663 green); R9b is done (PR #180, post-main CI 34044946044 green); R8a is done (PR #184, all four post-main checks green); R15b is done (PR #185, all four post-main checks green); R8b is done (PR #187, all four post-main checks green); R8c is done (PR #192, all four post-main checks green); R15c is done (PR #193, all four post-main checks green); R15h is done (PR #196, all four post-main checks green); R15i is done (PR #202, all four post-main checks green); R15j is done (PR #205, all-four post-main green); R15k is done (PR #207, all-four post-main green); R15l is done (PR #194); R16g is done (PR #210); R16h implementation is done (PR #211; delivery checkpoint above); R16b is done (PR #203 + repair #208); R16e is done (PR #201, all four post-main green); R16f is done (PR #204, all four post-main checks green); R16a is done (PR #199, restored by repair #206 with all four repaired-main checks green); R16d is done (PR #200, all four post-main checks green); R8d is done (PR #197, all four post-main checks green); R16c is done (PR #198, all four post-main checks green); R15g is done (PR #195, all four post-main checks green); R15f is done (PR #190, all four post-main checks green); R15d is done (PR #189, all four post-main checks green); R15a is done (PR #188 + repair #191, all four repaired-main checks green); R15e is done (PR #186, all four post-main checks green); R9c is done (PR #183, CI and scripted-structure post-main green); R10c is done (PR #181, post-main CI 34044235154 green); R9a is done (PR #175, post-merge CI green); R10d and readiness repair are done (PRs #171/#173, repaired-main post-merge CI green); R14c and R11b are done with green post-merge CI (PRs #169/#168); R5b is done with green post-merge CI (PR #167); R14b is done with green post-merge CI (PR #165); R11a is done with green post-merge CI (PR #166); H7b is done with green post-merge CI (PR #164); R14a is done with green post-merge CI (PR #162); H7a is done with green post-merge CI (PR #161); R12d is done with green post-merge CI (PR #163); R12c is done with green post-merge CI (PR #158); R12b is done with green post-merge CI (PR #155); R6g is done with green post-merge CI (PR #153); R13d is done with green post-merge CI (PR #154); R13c and R5a are done with green post-merge CI (PRs #159/#157); R12a is done with green post-merge CI (PR #152). R6c is done with green post-merge CI (PR #151); R13b is done with green post-merge CI (PR #150). R6b, R12e, R5d, R5e, R6a, R13a and R13f are done with green post-merge CI.** The remaining roadmap is committed scope, ordered by impact and dependencies in ROADMAP §5. R6d–R6f, R4a–R4c, H1–H6 and E1–E3 are complete; supporting PRs and limits are recorded below. R3.5 is complete (R3.5a, R3.5b). R3 is complete (R3a–R3d); R2 is complete (R2a–R2d); R1 is complete (R1a–R1e); R1.5a–R1.5f are complete. These are implementation records; the H band tracks newly identified gaps.
The original milestones M0 through M7 remain complete, including M2.5's live provider validation.

## Current priorities — revised 2026-09-06

### R15l done — PR #194; historical decision and verification checkpoints

Refreshed on repaired green main0b65aa1; only documentation conflicts, original
review unchanged.212local links resolve; build/typecheck and7structure tests pass
(one existing skip). Fresh exact-head and post-main gates still required.

Started from green main `887fef8` while R8c/R15c await their integration gates.
R10c is the completed prerequisite; this does not pull dependent runtime work forward.
Ordinary trusted user-authored SDK composition is supported, with bounded fan-out,
independently specified verification and serial separately authorized application.
No workflow engine/DSL/loader, automatic merge, runnable recipe or new build row.
[Decision and evidence](plans/R15l.md). Documentation links/source consistency and
one substantive Claude review are complete: APPROVE, no material findings,
28 reported turns against requested 16. Original findings preserved; exact-head
and post-main gates remain pending. No new runtime-test execution claimed.


### R15i done — PR #202, configured-estimate project ledger

Main `9aca3915e98ca8331e1c25c8a7a0eeabe27a2066` passed all four post-main
checks: CI `34072279360`, structure `34072279370`.
[Final receipt](https://github.com/agentkitai/agentrig/pull/202#issuecomment-5563729106).
The following implementation and fixture-repair checkpoints are historical.

Approved [bounded contract](plans/R15i.md): immutable per-call pricing, conservative
reservation before dispatch, explicit unknown coverage and no midnight recovery
shortcut. One cached provider wrapper covers session call lanes; historical
snapshots/auxiliary reports are not charged again. Ledger receipts are operational
metadata permitted for heartbeat; task/wiki/report prohibitions remain.
No invoice guarantee or default unattended enablement. Integrated `74699dac` passes
build/typecheck, 55 combined focused controls and full digest-pinned Docker:
2,992 passed, two existing skips /186 files. One independent REQUEST_CHANGES review
(28 reported turns /24 requested) had its material lock-contention finding fixed;
author UTC/async-context/cancellation and native-output integration controls also
failed before and pass after correction. [Original review](plans/R15i-review.md).
Exact-head four-check CI and root merge/post-main gates remain pending.

Final queue integration with green R8d/R16c main `130123ee` passes build/typecheck,
61 focused controls, required digest-pinned Docker (3,019 passed, two skips /188
files, 65.34s), and real Chromium (one smoke). Actual web capped requests and
summary-independent `/cost` are covered. ACP auxiliary attribution/missing cap-event
controls fail before the narrow session-context attachment fix and pass afterward.
Initial PR #202 head `9c07f45` passed all four checks; final integrated-head CI and
root merge/post-main remain pending. No second independent review.

Integrated `dea862e` then failed Windows [CI34070567044](https://github.com/agentkitai/agentrig/actions/runs/34070567044)
at three existing question-startup readiness assertions; Linux/macOS/structure passed.
Injected 1.1–1.2s startup delays reproduce all three failures. Test-only callback/frame
readiness repairs retain original answer/permission/deadline/reservation assertions,
with bounded waits and unchanged production timing. Build/typecheck and full required
Docker now pass 3,022 plus two skips /188 files (66.15s); real Chromium passes one smoke.
Fresh exact-head checks were required at that checkpoint and subsequently passed;
no blind rerun or second broad review. The final receipt above closes this row.

### R15h done — local agent roles, PR #196

Final main `31193d649880ade62d6b8ca1ec0525318727ea76` passed all four post-main
checks: CI34064151052 and structure34064151009.
[Final receipt](https://github.com/agentkitai/agentrig/pull/196#issuecomment-5562704055).
The following checkpoints preserve the failed original CI and bounded fixture
repairs; their final exact-head and post-main gates are now closed.

Independent role enforcement proceeds after delivered R5e/R12d/R13c; it does not wait
on unrelated reasoning/output-schema rows. Trusted project manifests select existing
provider roles and monotonically narrow tools, child turns and delegation. Runtime
dispatch includes hidden diagnostic checks; role bodies are project/advisory, never
grants. Same role-built SDK resume retains restrictions; explicit operator CLI resume
builds a new root, not an actor reconstructed from historical receipts.
[Bounded contract and validation](plans/R15h.md). One independent review approved:
21 reported /24 requested turns, 84 reviewer-run focused tests. Frozen build/typecheck
and Docker full pass 2,872 plus two existing skips /177 files. Integration with R8c
retains role discovery and child telemetry together; final delivery gates remain.
PR #196 first head `ecc4482` passed CI34061166635 and structure34061166651,
all four green. Final R15c integration retains reasoning/role dispatch and privacy:
build/typecheck, 63 focused tests and full Docker 2,934 plus two skips /182 files
pass. Final exact-head and post-main gates remain, not another review round.
Integrated head `55bd0c6` then failed macOS's pre-spawn 80ms fixture race and Windows
temporary-directory EBUSY cleanup. Both original failures remain recorded. Bounded
test-only phase/cleanup repairs retain assertions and production limits; build/typecheck
and full Docker now pass 2,936 plus two skips /182 files. Fresh all-four CI is required.

### R8d done — PR #197, authenticated loopback ACP reference client

Main `c59a446640eefda9b5e880080f49cff3bfb134e5` passed all four post-main gates:
CI `34067541791` and structure `34067541769`.
[Final receipt](https://github.com/agentkitai/agentrig/pull/197#issuecomment-5563160688).
The following implementation checks are historical.

[Contract](plans/R8d.md), [operator guide](WEB.md). Exact Host/Origin plus bearer
before ACP creation, fixed assets, one connection through joined close, bounded WS
queues and literal reference UI. Eighteen HTTP/WS/actual runtime controls and one
real Chromium task/permission/question/cancel/XSS smoke pass. One bounded Claude
review approved with fixes (24 requested / 37 reported turns); findings and
counterevidence are preserved in the plan. Post-fix build/typecheck and full
Docker checks pass 2,911 tests plus two skips. Integrated R15c build/typecheck and
Docker full checks pass 2,931 plus two skips across 181 files; Chromium additionally
checks actual received frames exclude thinking/signature canaries. Exact-head
Linux/macOS/Windows and scripted-structure gates remain pending.
Final integration from green roles/structured-output main `74699da` passes frozen
install/build/typecheck, Docker full 2,976 plus two skips (185 files, 62.81 seconds),
and the real Chromium smoke. Only documentation conflicts needed resolution;
all existing runtime privacy checks remain. Fresh exact-head four-check CI follows.

R15c is done (PR #193): main `749ff265b031f19040307b60b44097e825f1c2f9`
passed CI `34061897223` and structure `34061897204`, all four green.
[Final receipt](https://github.com/agentkitai/agentrig/pull/193#issuecomment-5562453419).

### R8c done — PR #192, optional bounded telemetry

Main `b3bb06ad8c3008c37b6dd107909e1ec002340077` passed CI `34060311037` and
structure `34060311027`, all four root-verified green.
[Final receipt](https://github.com/agentkitai/agentrig/pull/192#issuecomment-5562272806).
The following text records earlier pre-merge verification checkpoints.

[Contract](plans/R8c.md) and [operator guide](OTEL.md). Explicit CLI-only endpoint,
fixed content-free metadata, shared exporter/child capacity and sandbox-network
refusal. Twenty-three focused real runtime/entry-point/transport controls pass;
named privacy and capacity mutants detected and restored. One bounded Claude review
approved with fixes (24 requested / 26 reported turns); material availability and
partial-accounting controls failed before and passed after fixes. Existing MCP cleanup
counterevidence is recorded alongside the verbatim finding. Build/typecheck/full Docker
passes 2,817 tests plus two existing skips. Latest-main integration and all-four CI
remain pending after integrating repaired green main `3174475`. Combined build,
typecheck and full Docker pass 2,846 tests plus two skips across 173 files.
No live provider/collector spend.
PR #192 first head `24eaf57` passed all four checks. Integrated green R15d main
`8da49d4` retains remote MCP/telemetry policy and cleanup; build/typecheck/full Docker
now pass 2,877 tests plus two skips across 177 files. Updated exact-head checks pending.
Final R15f integration at green main `887fef8` passes build/typecheck/full Docker:
2,893 tests plus two skips, 178 files. Actual `run --ci` collector-refusal control
preserves successful task/report outcome and joined cleanup. Final four CI gates pending.

### R15f done — PR #190; bounded CI input, fail-closed execution and reporting

Main `887fef8b457418587f8dca46b510b65cfeb3db1c` passed all four post-main checks:
CI `34058784223`, structure `34058784219`, root verified.
[Final receipt](https://github.com/agentkitai/agentrig/pull/190#issuecomment-5562115783).
The following paragraph records its earlier implementation checkpoint.

Independent after R15e's green post-main gate; R12c/R13c/ACP provenance and report
seams are already delivered. R15a questions, R15d remote MCP and R8b MCP serving
can proceed separately; integrate their committed interfaces without duplicating rows.
Existing runCommand hosts explicit file/event input as advisory context with an
empty runtime task, configured headless policy and actual ask deny/abort. Fixed
20-turn/five-minute/50,000-main-token ceilings clamp larger settings; aggregate
auxiliary/child/remote billing is not claimed bounded by these ceilings.
Create-only Markdown and explicit authorized/pinned PR comments share R15e's helper.
[Contract](plans/R15f.md), [operator guide and uninstalled Actions example](CI-MODE.md).
Initial build/typecheck/full passes 2,790 plus two skips /166 files with actual
Linux containers. Three negative mutations were detected/restored. The single
independent review approved with no material findings; requested 24 turns, reported
35 (not within the requested cap), no restart. It independently passed 66 focused
tests and full 2,805 plus two skips /169 files with actual containers (52.20s).
Exact-head PR and post-main gates remain. No live model/comment spending.
Integrated green R8b main: frozen install/build/typecheck pass and unchanged-source
full suite passes 2,805 plus two skips /169 files (55.07s, actual Linux containers).
A mistyped local checker-image digest caused two prior infrastructure controls to
fail; the corrected run, not that invocation, supplies the container evidence.



### R15d done — PR #189; all four post-main checks green

Exact public SDK 2.0.0 transports modern/legacy HTTP with bounded owned streams, explicit
operator OAuth login, external advisory resources/prompts and full-catalogue pin consent.
Existing stdio and ACP refusal contracts remain. Real local HTTP/OAuth/CLI and
provider/storage/resume/summary controls are implemented. One frozen independent review
returned REQUEST_CHANGES; both findings reproduced and fixed, with the original preserved.
First PR189 head c5fca5a passed all four gates. After repaired R15a main3174475 integration,
build/typecheck and Docker full suite pass: 2,854 plus two existing skips /175 files (58.17s).
Actual nightly X1 PASS/FAIL and X4 human-pending BLOCKED controls pass; the new exact-head
four-check gate subsequently passed. Main `8da49d4` passed CI `34057526815`
and structure `34057526836`, all four green.
[Final receipt](https://github.com/agentkitai/agentrig/pull/189#issuecomment-5561947394).
[Contract and limits](plans/R15d.md).

### R15e done — PR #186, all four post-main checks green

Root verified main `eead687` with CI34051436203 and scripted structure34051436058.
[Final delivery receipt](https://github.com/agentkitai/agentrig/pull/186#issuecomment-5561285218).
### R15a done — PR #188 + repair #191; repaired-main all four checks green

[Contract](plans/R15a.md), [operator guide](QUESTIONS.md). Private runtime question
events, bounded separate TUI/ACP queues and explicit headless answer policies are
implemented. Actual CLI/ACP subprocesses and mounted keyboard input pass targeted
checks. Automated answers remain advisory; no answer mints execution authority.
Four negative mutations were detected and restored. Build/typecheck and actual-Docker
full suite pass 2,808 plus two skips /168 files. The single independent review approved
and passed 151 focused/adjacent tests; [verbatim review](plans/R15a-review.md).
Initial head `13abf48` and integrated `51765bb` passed all four checks. Main
`59c21c7` then failed macOS as recorded above; the separate repair restores the
gate without relabelling the failed run. Repaired main `3174475` passed CI
`34056045886` and structure `34056045804`, all four green.
[Repair receipt](https://github.com/agentkitai/agentrig/pull/191#issuecomment-5561792580),
[R15a restored receipt](https://github.com/agentkitai/agentrig/pull/188#issuecomment-5561792722).
No second R15a general review.

### R8b done — bounded MCP server, PR #187

[Contract](plans/R8b.md): four tools over exact official SDK 2.0.0 modern/legacy
stdio, fixed trusted configuration, actual controller and advisory client tasks.
Pre-SDK capacity reservations survive physical writes and cancellation cleanup.
Actual modern client, existing core 2024 client/built CLI, permission and read
controls are under verification. The single independent review ended INCOMPLETE;
its material finding was reproduced and fixed, with bounded author closure recorded
in [the plan](plans/R8b.md). No further broad review. Final integrated build/typecheck
and Docker-enabled full suite pass: 2,794 tests plus two existing skips /168 files,
four workers, 50.13 seconds. All four exact-head and post-main gates passed for main6322139:
CI34053014401 and structure34053014398;
[final receipt](https://github.com/agentkitai/agentrig/pull/187#issuecomment-5561447223).

R8a final receipt: main `0493b09`, CI `34049720509` and structure `34049720468`
all green. [Receipt](https://github.com/agentkitai/agentrig/pull/184#issuecomment-5561091432).
Earlier R8a failure/integration notes below remain historical, not current gate state.

### R15e done — PR #186; all four post-main checks green

CLI and idle TUI share the existing supervisor reviewer with an explicit diff mode,
bounded text capture and validated hunk locations. No tests, edits, automatic comments
or fabricated agent trajectory. PR reads/posts require exec and net authorization;
commenting is explicit, identity-checked and refused on incomplete usage. Configured
total-session token/USD caps refuse rather than being silently ignored. Git filters
refuse before diff; extdiff, textconv, fsmonitor and hooks are disabled.
[Contract and boundaries](plans/R15e.md). The single bounded review and material fixes are complete.
Final ACP-integrated build/typecheck pass; unchanged-snapshot full suite passes
2,780 plus two existing skips /165 files with actual Linux containers (48.81s).
The initial scoped-copy cancellation regression was fixed, not dismissed as timing;
its detected/restored negative control and full review findings are retained in the plan.
Exact-head and post-main checks passed on all three platforms and scripted structure.
Post-main CI `34051436203` and structure `34051436058` cover exact main `eead687`;
[final receipt](https://github.com/agentkitai/agentrig/pull/186#issuecomment-5561285218).

### R8a done — PR #184; all four post-main checks green

[Contract](plans/R8a.md) and [operator guide](ACP.md). Official SDK v1 sessions,
streamed updates and one-time approvals reuse the controller. Separate advisory
resource context survives initial/continued runs and snapshots without becoming
fresh user authorization. Per-session trust/cwd and exact trusted MCP configuration
matching preserve host/sandbox boundaries; existing unchanged pins only, no ACP
consent persistence. Bounded queues, cancellation, raw opt-in events and local
read-only memory/supervisor extensions are exercised with controlled fixtures.
Actual spawned CLI + local fake provider completes deny/allow over OS pipes.
Pre-review build/typecheck/full passed 2,718 plus two skips with local Docker
fixtures. Four negative mutations were caught/restored. The single independent
review found oversized raw-event disconnect and SDK-hidden queue accounting;
both have actual fail-before/pass-after controls and bounded fixes. Integrated
R9c `3b7564a`: build/typecheck/full pass **2,733 plus two skips /161 files** with
local Docker fixtures; actual scripted nightly PASS/FAIL/BLOCKED controls pass.
Integrated R15b `74c5073` and explicit ACP internal checker correlation: frozen
install/build/typecheck/full pass **2,758 plus two skips /163 files** with local
Docker fixtures. Pre-integration `708e3bc` passed all four checks; the combined
head and merged main `0493b09` passed all four checks (CI `34049720509`, structure `34049720468`). No second general review.
R10c is fully done via PR #181, post-main CI `34044235154`;
[final receipt](https://github.com/agentkitai/agentrig/pull/181#issuecomment-5560486475).

### R15b done — PR #185, all four post-main checks green

Configured literal checkers follow real builtin edits; private changed-byte receipts,
exclusive edit/checker pairs and internal audited dispatch preserve permission/sandbox
boundaries and model conversation shape. Unknown/other-file/truncated output is explicit,
never proof of correctness. [Contract](plans/R15b.md). Actual tsc/CLI and lifecycle controls
passed, including actual two-edit supervisor and checkpoint undo controls. One independent
review approved; its material error-burst finding and an author-found checkpoint issue
were fixed with failing-before/passing-after controls. All four post-main checks passed.

### R9c done — PR #183, all four post-main checks green

Explicit nightly/manual/PR/main workflow over existing E1/E2/R9b, with R13e controls.
Actual isolated X1 correct/broken and X4 human-pending fixtures produce PASS/FAIL/BLOCKED;
all eight E1 definitions also run through their existing structural tests. This is not
live model evidence or default all-eight isolated execution. Selected bounded artifacts
and partial failure/cancellation summaries are retained; ordinary eval stays live-labelled.
[Contract and limits](plans/R9c.md). No provider spend or E3 result changes.

Author build/typecheck and full actual-container suite pass: 2,710 tests plus two
existing skips /156 files. One independent review approved with no material findings;
independent typecheck, 33 runtime tests, 52 structural tests, actual wrapper and SIGTERM
checks passed (no independent build/full-suite claim). Requested24/report27 turns,
351.175s, no restart; [verbatim receipt](plans/R9c-review.md). Hosted exact-head CI,
including the new actual nightly-wrapper job, passed before merge. Main `3b7564a` passed
all three platforms in `34047589688` and scripted structure in `34047589697`.

### R7c done — PR #182; post-main CI green

Main `b2390ce` passed all platforms in CI `34045706663`. Following notes retain the implementation history.

Ordinary cron launches receive structured local receipts and the existing configured-memory
ingestion lifecycle, respecting explicit opt-out. Successful heartbeat stays quiet; failure-only
operational accounting reaches the next trusted TUI. Bounded retention, displayed-cutoff ack
and a persistent uncertainty marker preserve concurrent failures without retrying model work.
Main and auxiliary usage stay separate; unknown/child coverage is partial, not free.
Build/typecheck and pre-review full 2,652 plus two skips /153 files pass; 123 focused
and five detected/restored mutations pass. One review approved; its count-wording finding
was fixed with a failing-before/passing-after control. Latest-main/CI delivery gates remain.
Integrated R10c main `7b6cb6a`; combined build/typecheck/full pass 2,674 plus two skips
/154 files (four workers, 38.23 seconds), with 123 focused green. Exact-head CI follows.
Then integrated R9b main `5344291`: build/typecheck and full with actual Docker worker/checker
fixtures pass 2,700 plus two skips /155 files (four workers,42.91s). R9b post-main pending;
R7c new exact-head CI is required. No second review for mechanical integration.

### R9b done — PR #180; post-main CI green

Exact head `3fb431e` passed CI `34044418521`; merged main `5344291` passed
CI `34044946044` on Linux, macOS and Windows. [Final receipt](https://github.com/agentkitai/agentrig/pull/180#issuecomment-5560574618).
Earlier pending/failure notes below are retained history.

Explicit mapped E1 tasks, supported config profiles, pinned local worker/checker images,
default no-provider preview, opt-in execution and shared main/advisory accounting.
E2/R14d independent outcomes remain authoritative; M6 cannot close human gates.
The shipped worker supports X tasks; A tasks require a matching offline dependency image.
Historical sessions are identities/baselines, never replayed authorization. Separate
coordinator receipts preserve original logs. [Contract and limitations](plans/R9b.md).

R9a is fully done: [PR #175 final receipt](https://github.com/agentkitai/agentrig/pull/175#issuecomment-5559857591).
No live evaluation or benefit claim is part of this row. Final author build/typecheck
and full suite pass **2,652 tests plus two existing skips / 151 files, 40.28 seconds**
with actual Linux container fixtures enabled. One independent review (238 seconds,
22/max24 turns) passed typecheck and its full 2,649+2 suite; it did not run build.
Its sole material finding, missing direct event-render coverage, is fixed with
trace/chat null/true/false advisory controls. Named guard mutations were detected
and restored. [Original review](plans/R9b-review.md). Exact-head CI and root merge remain.
R7b main `f3a1ec8` is integrated; combined build/typecheck and full suite with actual
Linux fixture images pass **2,660 + two existing skips / 152 files, 40.71 seconds**.
R7b's post-main gate is now green; its done receipt is preserved below.
R10c main `7b6cb6a` is integrated. Two Windows package-fixture timeout receipts and
the narrow owned-npm timing repair are retained in [R9b's contract](plans/R9b.md).
The controlled delayed actual pack fails at the former bound and passes at the
new fixture-only bound; artificial delay removed. Combined build/typecheck/full
with actual Linux Docker passes **2,682 + two existing skips / 153 files, 41.64s**.
Fresh exact-head CI remains pending; no second broad review.

### R10c done — PR #181, post-main CI 34044235154 green

Opt-in actual factory-object isolated cohorts on the existing parallel strategy, checked
dirty/untracked raw baselines, retained bounded binary diff candidates and no automatic apply.
Parent permission denial prevents preparation/application; exact file/cwd grants are not
remapped. Enforcing parent sandbox refuses host Git preparation. Cooperative checkout
separation is not host-code containment. Supervisor loop/stall order controls are pinned.
Build/typecheck and initial full suite pass 2,644 plus two existing skips / 151 files
(four workers, 39 seconds). The single review's material aliased-store finding was reproduced
and fixed; mixed barrier coverage and all negative controls pass. Integrated R7b main
`f3a1ec8`; combined build/typecheck/full pass 2,656 plus two existing skips / 152 files
(four workers, 38 seconds). Eighteen isolated runtime tests and four supervisor order
controls are retained. Exact-head PR CI is next; no second broad review for integration.
Initial PR #181 CI 34043109668 passed Linux/macOS but failed Windows parent-application
line endings (CRLF versus LF), after raw child baseline checks passed. The same mismatch
reproduced locally with explicit `core.autocrlf=true`; the authorized fixture apply now
explicitly selects `core.autocrlf=false`. Byte-exact assertions and runtime are unchanged.
New exact-head checks follow; the initial failure is not rewritten as success.
Corrected fixture build/typecheck/full pass again: 2,656 plus two skips / 152 files,
four workers, 38 seconds. New exact-head three-platform CI gates the merge.
[Contract](plans/R10c.md). Exact-head checks subsequently passed all three platforms;
root merged `7b6cb6a`. Its post-main gate is pending.

### R7b done — PR #179, post-main CI green

Existing lock, claims and trusted execute opt-in are reused. Empty checklists have an empty
actual tool registry; builder suppression covers explicit host extensions and maintenance.
Actual local-adapter/storage and four named fail/restored controls pass. Build/typecheck/full:
2,634 passed plus two skips / 151 files; one bounded review approved and independently passed
28 focused tests plus typecheck. PR #179 merged as `f3a1ec852f40c70f21c51507e76797f4dc388d53`;
post-main CI 34042336391 passed Linux, macOS and Windows. Earlier pending notes are history.

### R10b done — PR #177

Final head `3d25e882`, CI 34040321452 all three green; merged main `92946819`,
post-main CI 34040691166 all three green. Following notes preserve intermediate history.

Opt-in bounded declared read/write concurrency with final-input admission, FIFO barriers,
serialized approval/audit and joined pipeline settlement. Sequential remains default;
unknown effects, hooks/checkpoints and background writers are conservative exclusive cases.
One bounded review approved; author-found directory/name/queued-prompt fixes each have
fail-before/pass-after runtime controls. Original verdict and accurate attribution are retained.
R7a main `bf65aec` is integrated; scheduled outside writes remain fresh-consent gated even
with blanket permission allow and parallel scheduling. Final build/typecheck/full pass
2,625 plus two skips / 150 files (four workers, 37 seconds) at that checkpoint.
Main's separate evaluation-fixture repair subsequently passed post-merge CI before feature delivery.
Repair #178/main `90301f8` is now integrated. The final conservative missing-name allowlist
and real `new~1` fail-before/pass-after control are included; no second broad review.
Combined build/typecheck, 56 focused and full 2,626 plus two skips / 150 files pass
(four workers, 38s). Repair post-main CI 34040182760 and the new exact-head CI gated delivery.
Subsequently, exact head `3d25e88` passed CI34040321452 and merged main `9294681`
passed all three platforms in CI34040691166. [Final R10b receipt](https://github.com/agentkitai/agentrig/pull/177#issuecomment-5560095038).
[Contract](plans/R10b.md).

### R7a done — PR #176, main gate restored by repair #178

Repair main `90301f8` post-CI 34040182760 passed all three platforms. The initial
R7a post-main failure below remains part of the delivery record.

Main `bf65aec` is integrated; CI 34039249249 failed the unchanged A1 real-copy fixture's
five-second outer bound. A separate test-only repair gates continuation; no initial-green
claim. Following implementation notes are history.

Plain bounded JSON and five-field UTC cron; preview is model-free, execution is explicit
and requires canonical project trust. Cooperative claim-before-dispatch serializes ticks;
scheduled tasks stay advisory and never establish fresh permission consent. No daemon,
heartbeat, report banner or monetary-cap claim. [Contract](plans/R7a.md).
Initial build/typecheck/full passes 2,559 plus two skips across 148 files, four workers,
38 seconds. Three guard-removal mutants failed and were restored. The single bounded
[review](plans/R7a-review.md) returned REQUEST_CHANGES; its commands were denied, so no
independent test run is claimed. Missing executable defaults and loss of later due entries
after an earlier budget end reproduced through real CLI/runCommand/local adapter fixtures.
Shared defaults with proper config precedence and per-entry outcome aggregation fix both;
20 focused controls now pass. Integrated R9a main `a99f3ec`, retaining both CLI surfaces,
tests and done markers. Combined build/typecheck/full passes 2,597 plus two skips across
149 files (four workers, 36 seconds). Exact-head PR CI and post-merge gates remain pending;
R9a's own post-main gate is not yet claimed green. No second broad review for integration.

### R9a done — PR #175; post-merge CI green

Main `a99f3ec` passed all three platforms in CI 34038597415. Following notes are history.

Local `sessions export` reuses the real fork/compaction message fold through bounded, stable,
finished physical logs. JSONL, ShareGPT and Markdown retain versioned canonical supported-content
fields; all copies are redacted first. Explicit literal lists supplement heuristic credential
redaction. Opaque images refuse unless explicitly omitted; unknown future content refuses.
No config, credentials, providers, imports, log writes or live evaluation spend. Provenance is
inert data, never authorization. [Contract](plans/R9a.md).
R9a follows delivered R5c #170 and is independent of the concurrently delivered R10/R14 lanes;
existing E machinery is reused, not replaced. Full tests, named mutations and one bounded
independent review precede exact-head CI and the root-coordinated merge.

Integrated build/typecheck/full passes 2,575 + two skips / 148 files (four workers, 37 seconds).
The single independent [review](plans/R9a-review.md) approved and independently passed the same
full suite plus 33 focused cases and real CLI probes (235 seconds, 17/max24 turns). Four guard
mutants were detected/restored. Separately, an author-run adversarial long-word subprocess hit
its five-second bound; a new regression reproduced it before bounded forward scanning replaced
the quadratic patterns. This is a material post-review fix, not a finding the reviewer detected.
No second review. Final fixed-head validation and exact-head CI follow.
Final fixed-head build/typecheck/full now passes **2,577 + two skips / 148 files** (four workers,
36 seconds), including 35 export controls and the unchanged five-second subprocess regression.
PR and post-main CI remain delivery gates; R9a is not marked done early.

### R10a done — PR #174; post-merge CI green

Main `391514b` passed all three jobs in CI `34037504297`.
[Final receipt](https://github.com/agentkitai/agentrig/pull/174#issuecomment-5559723561).
Following implementation checks are historical.

Trusted SDK turnStrategy injection schedules the unchanged tool pipeline; sequential stays
default. Pinned pre-extraction full bytes cover normal/between-call-abort/final-call-abort/
truncation, with existing H6/resume golden files unchanged. Explicit sequential matches default;
actual gated callbacks prove serial ordering. Both altered-order and partial-abort-batch mutants
fail their baselines and are restored. No concurrency, arbitrary loading or permission changes.
Integrated R5c main `1ae6b77`; build/typecheck/full passes 2,535 plus two skips across 146 files
(four workers, 37 seconds). One bounded independent review and exact-head CI follow.
Single review approved without material findings: 85 seconds, 17/max24 turns, independently
105 focused tests and typecheck. Original findings retained in the contract; optional polish END.
First head passed all-three CI 34036629566; integrated R14d main `326aa4a` afterward.
Combined build/typecheck, 105 focused and full 2,542 plus two skips across 147 files pass
(four workers, 37 seconds); pre-extraction snapshots unchanged. Fresh exact-head CI follows.

### R14d done — PR #172; post-merge CI green

Root verified all three post-main jobs green. [Final receipt](https://github.com/agentkitai/agentrig/pull/172#issuecomment-5559667531). Following implementation checks are historical.

Shared bounded regression/behavior verdicts reuse actual E1 workers and stored E2 reports;
the same host-attested observations reach M6 through a lazy trusted loader. Same-assumption,
partial, missing-probe and unknown evidence cannot pass; neither matching checks nor model
narration establish semantic proof. No new runner, automatic checks or live evaluation spend.
[Contract](plans/R14d.md). R14c is its prerequisite; extension/provider work is independent.
Actual correct/broken X2 surfaces keep regression/submitted tests green and discriminate in
E2 plus attached M6. Removed assumption discount and removed M6 deficit override each failed
their named negative controls and were restored. The one bounded Claude review returned
REQUEST_CHANGES for the A4/X4 human-gate integration; the material finding is fixed with actual
pending/FAIL/PASS and non-waiver regressions, including a detected/restored old-behavior control.
[Original verdict](plans/R14d-review.md). No second review. Integrated R10d main `3d45d9f`;
combined build/typecheck/full suite passes 2,497 tests plus two skips across 143 files (four
workers, 34 seconds). Exact-head PR and post-merge gates remain pending.
### R5c done — PR #170; exact-head and post-merge CI green

Final head `beec123` passed CI `34035857727` on all three platforms. Merged main `1ae6b77`
passed post-merge CI `34036244589` on all three platforms, first attempt. The earlier failures
and single diagnostic retry remain recorded below; they are not reclassified as passes.
[Final receipt](https://github.com/agentkitai/agentrig/pull/170#issuecomment-5559584399).

Local directory/npm-tarball packages validate strict R5e manifests before create-only staged
publication. Maintained bounded archive parsing rejects unsafe final paths/types/collisions;
no scripts, imports, registry access or dependency installation occur. Trusted runtime discovery
rechecks complete-unit content records before existing extension/skill loaders; prompt files
stay inert. Integrity is change detection, never authenticity or a sandbox. Existing trust,
explicit roots and negative discovery overrides remain authoritative. [Contract](plans/R5c.md).
This resumes the extension lane after R5b PR #167/main `fef3f46` post-CI 34031416228 passed
all three platforms; independent R11b/R14c changes are retained on integration.
Full gates and exactly one bounded independent review precede delivery.

Own integrated build/typecheck/full suite passed 2,500 tests plus two skips across 142 files
(37 seconds). Three archive-type/integrity/script guard mutations failed and were restored.
The one independent [review](plans/R5c-review.md) also passed build/typecheck/full 2,500 + two
skips (34 seconds), APPROVE, 244 seconds and 24/max24 turns. Its optional alias-priority note
was treated as a contract defect: a real builder regression failed before explicit resolved
priority mapping and now passes for relative/absolute aliases while preserving project wins.
No second review; final updated-head checks and all-platform CI remain pending.

Final updated-main build/typecheck/full suite after the fix passes 2,502 tests plus two skips
across 142 files (four workers, 34 seconds). The PR proceeds to exact-head all-platform CI;
the root coordinates merge only after those checks and the preceding main gate are green.

Initial PR #170/head `29dcabf` CI 34033531560 found a new doctor fixture assertion failure on
macOS and Windows (not timeouts). Canonical temporary-root trust keys plus a real filesystem-alias
control fix the fixture; assertions remain strong. R10d main `3d45d9f` is integrated. Combined
build/typecheck, 91 focused package/doctor/provider cases and full 2,520 + two skips/144 files
pass (34 seconds). Fresh exact-head CI is required; initial failures remain in the contract receipt.

Head `5c105f5` passed all three PR CI jobs in 34034014045 (Windows on the single authorized
diagnostic rerun after an unchanged X1 timeout). All 29 Windows package controls passed.
Separate main readiness repair #173 is now integrated as `063cac6`, retaining its shared helper
and CI group. Combined build/typecheck, 93 focused cases and full 2,526 + two skips/145 files
pass (four workers, 37 seconds). Fresh PR CI and repaired-main post-merge CI still gate delivery;
no additional broad review was run for this mechanical integration.


### Child-grants readiness repair done — PR #173; post-merge CI green

Main `063cac6` passed post-merge CI 34035704275 on all three platforms. Final receipt:
PR #173 comment 5559519471. Following implementation/initial-failure notes remain history.

Replace one-second polling and absent-prompt inequality with exact subscribed state readiness,
bounded waits and premature run-settlement diagnostics. Production code and authorization
assertions are unchanged. The actual startup path retains a controlled delay that failed the
old wait; the weakened sibling-readiness mutant fails both real Ink paths and is restored.
Six helper controls cover readiness, cleanup and failure. Build/typecheck/full suite, one
independent review and exact-head three-platform CI precede delivery; no repeated blind reruns.
Local build/typecheck/full passes 2,497 plus two skips across 143 files (four workers, 35 seconds).
One bounded Claude review approved without material findings (88 seconds, 8/max24 turns),
independently passing 40 focused tests and typecheck. Original findings are in the repair plan;
optional test refinements are at the roadmap END. Exact-head three-platform CI is next.
First PR #173 CI 34035057038 exposed a macOS rendered-output race after controller readiness.
Actual Ink frame readiness now gates confirmation, with a buffered-frame control and both-mode
fail-first mutation; visible-text and authorization assertions remain unchanged. No second review.

### R10d done — PR #171; gate restored by PR #173

Initial main CI 34033869154 failed; repaired main `063cac6` passed CI 34035704275 on all
three platforms. Final receipt: PR #171 comment 5559519594. Following notes are history.

Explicit doctor --probe runs bounded potentially billable empirical samples; normal doctor
remains offline/read-only. Exact local observations feed actual advertised capability flags;
unknowns retain labelled unverified defaults. No native strict-format guarantee, permission
change or live validation spend. [Contract](plans/R10d.md). Actual local HTTP SSE/doctor/cache/
builder tests plus fake core samples exercise bounds, usage, matching and offline behavior.
Capability-application removal and unconditional-probe mutants each failed their real-path
control and were restored. Integrated R14c main `4d3eb91`; config-free evidence display preserved.
Final build/typecheck/full 2,491 plus two skips across 142 files passed (four workers, 33 seconds).
One bounded Claude review approved without material findings (178 seconds, 23/max24 turns),
independently running 17 focused tests and typecheck. Verbatim result is in the contract;
optional source-summary wording is at the roadmap END. Exact-head CI remains the final gate.

### R14c done — PR #169; post-merge CI green

Final head `5ff9f59` passed CI `34032258018`; main `4d3eb91` passed all three post-merge jobs
in `34032607190`. [Final receipt](https://github.com/agentkitai/agentrig/pull/169#issuecomment-5559190491).
Following notes are implementation history.

M6 and read-only `sessions show --evidence` share a bounded claim/latest-candidate report.
Declared unfinished/unsupported/missing/failing checks and omitted history can force false only;
matching exits never prove semantics or force a pass. Dropped and legacy items stay explicit.
The actual supervisor passes a frozen full-stream report beyond its 400-event recent window.
[Contract](plans/R14c.md). This follows delivered R14b independently of R5b tool quarantine and
R11 network work; no new grammar, automatic check execution or R14d lanes are added.

Integrated main `cee1ad9`; build/typecheck/full tests pass 2,423 plus two skips across 137
files (32 seconds). The 39 focused cases include actual >400-event attach retention. Deficit-guard
removal and tail-only grading mutations each failed the discriminating runtime controls and were
restored. One bounded review and exact-head CI remain pending.

The single review `24f6be90-8c4a-480d-8032-b0df40f0d362` requested a HIGH resume correction;
[original findings](plans/R14c-review.md) are retained verbatim (191 seconds, 32 reported turns
despite the requested 16-turn ceiling). Trusted attach now anchors the current run's first
session boundary and explicitly excludes unassessed prior history; direct partial inputs still
refuse. Actual resumed legacy/mismatch controls pass and both fail without the fix. No second
broad review. R5b main `fef3f46` is integrated; its post-merge CI `34031416228` passed all three jobs.

Final combined build/typecheck/full suite passes 2,442 tests plus two skips across 138 files
(four workers, 42 seconds). The PR proceeds to fresh exact-head all-platform CI.

### R11b done — PR #168; post-merge CI green

Main `4f61b65` passed all three jobs in post-merge CI `34032134303`.
Following notes are implementation history.

Built-in GET-only web_fetch declares net and external provenance. Strict credential-free HTTP(S),
no redirects/custom headers/body, 1 MiB decoded cap, 20k text and 10-second total deadline.
Text/plain or lexical HTML extraction only. Actual local HTTP/runtime and CLI controls cover
permission/sandbox composition, cancellation, compression, target refusal and source restrictions.
No live network/model tests or SSRF/OS-host-JavaScript containment claim. [Contract](plans/R11b.md).
Redirect-follow and removed decoded-cap mutants failed five and two named controls respectively;
both restored. Full checks, one independent review and exact-head CI precede delivery.
Single review found one material script/style raw-text defect; actual local HTTP cases failed
before and passed after a bounded closing-tag fix. Verbatim original verdict and disposition:
[review receipt](plans/R11b-review.md). Reviewer ran 87 tests, 11/max24 turns, 168 seconds;
ad-hoc reproduction attempts were denied, not claimed as executed. No second review.
Final build/typecheck and full 2,460 tests plus two skips across 138 files pass (four workers,
35 seconds). R5b main `fef3f46` post-CI 34031416228 passed all three platforms.

### R5b done — PR #167; post-merge CI green

Main `fef3f46` passed exact post-merge CI 34031416228 on all three platforms.
Following notes are implementation history.

The extension lane resumes after delivered H7b PR #164. A private per-build disabled latch
spans registered hooks, tools, synchronous descriptors/probes and slash commands. Actual throws
and existing hook timeouts disable future handlers; expected errors, invalid model input and
user cancellation do not. Runtime-bound receipts stay with the failing run; idle command errors
print immediately and queue one next-start receipt without appending after a terminal event.
Disabled startup receipts do not imply reactivation. Background-probe failure stays conservative;
checkpointed workspace mutations then remain blocked until a new agent build.
The API still exposes no provider, credentials or audit emitter; ambient Node effects, blocking,
termination and already-running work are not isolated. No child inheritance or new deadlines.
[Contract and limits](plans/R5b.md).

Integrated R14b main `6f25a17`, retaining object-bound command-outcome evidence. Build/typecheck
and the full four-worker suite pass 2,407 tests plus two skips across 134 files (34 seconds).
Actual imported core/CLI/TUI controls cover cross-surface disable, healthy neighbors, reuse,
concurrent attribution, idle/terminal ordering, timeout/abort and counterfeit event refusal.
Removing the disabled transition caused a second handler dispatch; moving active receipts into
the idle queue lost the failing run's audit. Both named mutations failed and were restored.
One bounded independent review and final exact-head three-platform CI remain delivery gates.
No live evaluation spend or benefit claims.

One independent Claude review approved `49cef16` against `6f25a17` with no material findings:
session `865bb096-2ab8-4342-9710-91f55433f68b`, 225 seconds, 20 turns/requested max24.
It independently passed build/typecheck and all 2,407 tests plus two skips across 134 files.
Three optional import/comment/documentation notes were reconciled without runtime expansion;
their wording is recorded verbatim in the contract. No second general review.

Integrated R11a main `cee1ad9`, retaining the additive net validator and no-network gate before
body/dispatch, plus R14b command-outcome ownership. Combined build/typecheck and full checks
pass 2,428 tests plus two skips across 136 files (four workers, 32 seconds). R11a exact
post-merge CI 34030682233 passed all three platforms. Final exact-head PR CI follows.

### R11a done — PR #166; post-merge CI green

Main `cee1ad9` passed exact post-merge CI 34030682233 on all three platforms.
Final receipt: PR #166 comment-5558978375. Following notes are implementation history.

Additive `net` defaults ask without repurposing legacy `network`. Runtime denies compatible
net tools under enforcing no-network policy before body/dispatch bookkeeping. Explicit
`--sandbox-network` / config `sandboxNetwork` is independent from permission allow/YOLO;
fresh one-time outside escape remains separate and none mode offers no OS sandbox.
Real inert tool runs cover child views/narrowing, external-expansion consent and actual CLI
builder wiring; no web fetch or live network effects. [Contract](plans/R11a.md).
Integrated H7b #164/main `c88a72f`; post-merge gate pending at integration. R12d #163 and
R14a #162 have green post-merge receipts. Build/typecheck and full 2,393 tests plus two skips
across 133 files pass (four workers, 36 seconds). Mutations/review and exact-head CI follow.
Both named mutants failed their controls and were restored. One independent Claude review
approved with no material findings (154 seconds, 17/max24 turns), independently exercising
seven related files and typecheck. Verbatim findings are in the contract; optional polish is
at the roadmap END. H7b post-CI 34029756772 is now green on all three platforms.
Integrated R14b #165/main `6f25a17`; commandOutcome/evidence and both CI additions preserved.
Combined build/typecheck/full 2,411 tests plus two skips across 135 files pass (four workers,
32 seconds). Mechanical docs reconciliation only; no second review. R14b post-CI 34030230354
and R11a exact-head CI remain pending at this checkpoint.

### R14b done — PR #165

Final head `4c00278` passed CI `34029893408`; merged main `6f25a17` passed all three jobs in
post-merge CI `34030230354`. [Final receipt](https://github.com/agentkitai/agentrig/pull/165#issuecomment-5558936168).

Exact command-exit declarations associate with immutable internal foreground execution receipts
in a bounded supervisor attempt ledger. Later failure/unknown never borrows earlier success;
unsupported declarations and semantic acceptance remain unverified. Actual attach/store/replay,
resume, hook replacement, background/timeout and spoof/copy discrimination are covered.
[Contract](plans/R14b.md). This follows delivered R14a, independent of H7b's sandbox classifier
repair and completed R12d child grant views; it does not add grading or automatic check execution.

Build/typecheck/full checks pass 2,377 tests plus two skips across 132 files (33 seconds).
The receipt-drop and earlier-pass-masks-final-failure mutations each failed the actual-runtime
control and were restored. One bounded Claude review `70f4a79a-df31-4cdd-90fe-9c9440a558b7`
approved with no material findings (138 seconds, 13 turns), independently passing 18 focused
tests. Optional notes stay at the roadmap end; current main `2df8c25` is integrated.

H7b main `c88a72f` is now integrated; all stderr-inference removals coexist with the foreground
receipt. Combined focused checks pass 31 cases, and build/typecheck/full checks pass 2,390 tests
plus two skips across 133 files (34 seconds). PR #165 now proceeds to exact-head CI; the preceding
main's post-merge gate remains pending at this checkpoint.

### H7b done — PR #164; post-merge CI green

Main `c88a72f` passed all three platforms in exact post-merge CI 34029756772.
The following gate notes are implementation history.

The correctness-repair lane continues after H7a PR #161/main `668f7f1`, whose exact
post-merge CI 34028225992 passed all three platforms. H7b removes unauthenticated process
output as denial authority in foreground bash, background polling and sandboxed file-write
helpers. Ordinary failed outcomes remain visible. Trusted broker/policy/launcher refusals
retain the existing explicit sandbox-escalation path; profiles and containment are unchanged.
Exported legacy diagnostics are marked deprecated; `throwIfSandboxDenied` is a compatibility
no-op, not an authentication mechanism. [Contract](plans/H7b.md).

Integrated R14a main `fc8327e` without production conflicts, preserving acceptance declarations
and first-request prompt guidance. Thirteen actual-runtime fixtures exercise controlled Node
subprocesses through both providers, including real agent foreground/background/helper paths,
printed stdout/stderr/network/outside-path claims, and genuine broker/launcher positive controls.
They are not live OS-isolation tests; existing profiles/wrapper tests remain separate. Twenty-seven
existing sandbox cases pass with diagnostic compatibility and updated ordinary-exit expectations.
Foreground and background inference-restoration mutants each produced forbidden denial events
and failed their named controls; both were restored. Full checks and one bounded independent
review precede final exact-head PR CI. No extra milestone or live model evaluation spend.

Updated-main build/typecheck and the full suite pass: 2,355 tests plus two skips across
128 files with four workers (33 seconds). One bounded independent Claude review approved
`0decbae` against `fc8327e`, with no material production findings: session
`d4eb4783-9639-4a7f-ba42-1468541d1876`, 143 seconds, 22 reported turns under requested max24,
no restart. It independently ran build/typecheck/full 2,355 + two skips across 128 files.
Four stale documentation/comment notes were reconciled without runtime changes; verbatim
findings are in the [contract receipt](plans/H7b.md). Integrated R12d main `2df8c25`, preserving
child views/context and all documentation/CI additions; no second general review.
Combined build/typecheck and all 2,372 tests plus two skips across 131 files pass
(four workers, 31 seconds). R12d exact post-merge CI 34029019887 is green on all platforms.

### R12d done — PR #163; post-merge CI green

Merged main `2df8c25` passed exact post-merge CI 34029019887 on all three platforms.
The following gate notes are implementation history.

Live child views share bounded records/audit/counters but match only own or delegable ancestor
grants. Root/sibling authorization never consumes child-owned records. Views and runtime context
bindings are sealed to the creating task; old children cannot consume a later task's grants.
Child standing/scoped approvals pass through the exact view in the actual TUI, including preview,
confirmation and ownership diagnostics. Root inspection/revocation can see child records, which
expire at root task end. Explicit shared base policy and separate consent boundaries remain
unchanged. [Contract and host-code limits](plans/R12d.md).

Actual Ink ordinary/protocol spawn→child→grandchild tests refuse nondelegable root authority,
confirm child-owned scope, count inherited uses and refuse sibling/root reuse. Runtime revocation,
same-session/new-session expiry, bounded retention and copied/stale context controls are included.
Initial full suite passed 2,330 tests plus two skips across 126 files; additional boundary tests
followed. Main `9eb28cd` is integrated, preserving committed R16 scope. One bounded review,
restored mutations, final combined checks and exact-head CI gate delivery.

Updated-main build/typecheck/full checks pass 2,334 tests plus two skips across 126 files
(four workers, 31 seconds). Removing delegable filtering and forcing the TUI asker to root
authority both failed actual spawn controls and were restored; 30 focused cases pass. Base
`9eb28cd` passed all three post-merge platforms in CI 34027657968. Review and PR CI follow.

One Claude review (`3f3727cc-edbb-4d19-8b1f-9d1d235abd77`, 223 seconds, max24 requested /
31 turns reported) found the production `startTui` wrapper dropping child context. Fixed with
direct forwarding; actual startup/builder/spawn controls fail before and pass after. The reviewer
independently passed 40 tests. [Verbatim finding and resolution](plans/R12d-review.md); no second
general review. Final integration/full checks/CI follow; optional notes remain at ROADMAP's end.

H7a main `668f7f1` is integrated; its post-merge CI 34028225992 is all green. Continuation/source
safeguards and committed R16 scope are retained. Combined build/typecheck and the full suite
pass 2,354 tests plus two skips across 128 files (four workers, 31 seconds), including actual
startup denial/standing controls, failed expiry-audit recovery and bounded descendant depth.
Final exact-head PR CI follows; R12c/H7a done markers include verified merge receipts.

R14a PR #162 main `fc8327e` is integrated, preserving acceptance declarations, unverified plan
rendering and both CI selections. Build/typecheck/full combined checks pass 2,359 tests plus
two skips across 130 files (four workers, 31 seconds). R14a post-merge and this updated exact-head
CI remain merge gates; no additional general review for mechanical integration.

### R14a done — PR #162

Final head `7f1efb6` passed CI `34028325527`; merged main `fc8327e` passed all three jobs
in post-merge CI `34028652558`. [Final receipt](https://github.com/agentkitai/agentrig/pull/162#issuecomment-5558767896).

Merge `fc8327e` follows green exact-head CI. The gate notes below are implementation history.

PlanItem and update_plan share an optional nonblank acceptance declaration capped at 1024
characters. The first request of each run with the tool asks for an observable check per item,
preserving custom and hook prompt text. It is a runtime platform instruction, never new user
consent, an extra provider call or a mandatory planning/completion gate. Validated tool events,
storage, resume, supervisor plan state and CLI/TUI displays retain checks and explicitly mark
declared or missing legacy checks unverified. [Contract](plans/R14a.md). R14b evidence matching
and R14c grading remain separate; no check text is executed or asserted to have passed.

Dependency order: R13 provenance/guard foundations are delivered. This declaration-only row is
independent of concurrent R12c grant inspection and H7a continuation repair; its small request
assembly insertion does not alter either authority or continuation control flow. Actual provider,
tool/schema, storage/resume, R13c no-fresh-consent and /plan tests pass. Full checks, restored
mutations, one bounded review and exact-head/post-merge CI remain delivery gates.

One bounded Claude review `db1b8fba-284f-4557-b725-d367bc4845a8` returned APPROVE with no material
findings and independently passed 408 tests (15 files). It completed in 147 seconds; the requested
ceiling was 16 turns and the receipt reports 18 including terminal handling. Field-drop and
first-directive removal mutations failed the actual-runtime controls and were restored. Optional
polish is at the roadmap end. Current main `06f5b4b` (R12c) is integrated with its source attribution,
grant counts and documentation preserved. Build/typecheck and the full four-worker suite pass
2,326 tests plus two skips across 126 files (31 seconds). Exact-head and post-merge CI remain gates.

Integrated H7a main `668f7f1` after prior PR head `7e5301f` passed all three jobs in
CI `34027941553`. First-request acceptance assembly and actual-provider-boundary continuation
remain intact. The combined 86 focused cases and build/typecheck/full 2,342 tests plus two skips
across 127 files pass. Fresh exact-head CI and H7a's post-merge gate remain pending.

### R13c done — PR #159; post-merge CI green

Final head `71b58c7` passed all three PR jobs in CI 34026155677; merged main `78e8e19` passed
all three post-merge jobs in CI 34026441186. Earlier gate wording below is implementation history.

The runtime tracks three coarse first-dispatch categories per run: exec, network, and declared
write paths outside or unverifiable relative to canonical cwd. External/unknown new input latches
a restriction through continuations, summaries and resume; only actual fresh user input clears it.
No roles, hook delegation, old receipts or prose manufacture that input. Fresh consent bypasses
allow grants, never applicable denials; grants/approval/preparation alone do not count as dispatch.
The separate consent origin retains child provenance and cannot become a standing/scoped grant.
The default supervisor emits a bounded, explicitly heuristic injection signal over external
canonical content. [Contract and honest limits](plans/R13c.md).

Dependency order: delivered R13a/R13b/R13d provide source/assembly/principal seams. R12b's current
request coverage and exact scope preview are retained; R12c attribution is an additive independent
row, not a reason to defer this guard. Actual runtime/storage/provider, built-in summary laundering,
canonical new-file/symlink, two-path Ink consent and supervisor attachment tests are included.
Recognized tool-output is neutral, never sufficient to clear restriction; clean-parent children
inherit live restriction through an internal object-identity seam, not generated brief text.
These restore ordinary headless edit→test and clean child workflows while external pairs deny.
One bounded Claude review (`0225d5ce-58ab-4bbf-be2a-3709deccfeab`, 16-turn cap) produced three
original findings, all addressed: tool-output usability, child inheritance and non-advisory
heuristic escalation. [Verbatim findings and resolutions](plans/R13c-review.md). No second review.
Fresh-bypass, summary-source-drop, overlapping-deny and child-laundering mutations failed their
named controls and were restored; full-capability injection escalation failed before its fix.
Current main `7f01c4c` is integrated, preserving R5a extensions and fourth-pass H7/R15/ACP scope.
Build/typecheck and all 2,292 tests plus two skips across 122 files pass (four workers, 30 seconds).
Exact-head three-platform CI and post-merge CI remain delivery gates; this is not marked done yet.

R13d PR #154 is done: final head `d327bdf` passed CI 34023974105; merged main `2ad720f` passed
all three post-merge jobs in CI 34024190216. R12b PR #155 is done: main `326acdb` passed all
three post-merge jobs in CI 34024734696. These receipts supersede their earlier pending notes below.

### Fourth pass: roadmap extended past the committed continuation

After R6 closed, a source-level audit compared AgentRig against the harnesses in daily use
(Claude Code, Codex CLI, Gemini CLI, OpenCode, Goose, Cline, Aider, Zed's ACP). ROADMAP gains
an H7 repair row for open issues #116 (maxTokens truncation ends the session) and #95 (forged
read-only line counts as a sandbox denial), an R15 band of twelve rows (ask_user tool, post-edit
diagnostics, thinking blocks, remote MCP, on-demand review, CI mode, output schema, agent roles,
spend ledger, mid-session model switch, TUI `@file`/image input, and an orchestration decision
row), and an amendment making R8a speak the Agent Client Protocol instead of a bespoke NDJSON
protocol. Section 5 orders these after the existing continuation; H7 may interrupt it.
A follow-up read of `packages/cli/src/tui` added R16, eight TUI polish rows (Markdown and diff
rendering, tool-call summaries, prompt history and completion, notifications, a richer status
line, in-TUI compact/clear/doctor/diff, themes and keybindings) inside the Static-scrollback
model; the alternate-screen renunciation stands. Section 5 also now marks R12b and R13d done.

Housekeeping the same day: PR #109 (superseded R4a draft) closed; PR #115 updated against main
for merge; fourteen worktrees and local branches for merged rows removed. Worktrees for R12b
(merged as #155, left for its owning session to remove), R12c, R13c, R13d and R5a remain.

### H7a done — PR #161; post-merge CI green

Final PR head `7353256` passed all three platforms in CI 34027933833; merged main `668f7f1`
passed exact post-merge CI 34028225992. Historical intermediate gate/diagnostic notes follow.

The committed correctness-repair lane interrupts R5b after R5a delivery: H7a then H7b,
without expanding into provider-cap configuration or reasoning UI. A fresh worktree starts
from R5a main `7f01c4c`, whose post-merge CI 34026041480 passed on all three platforms.
Integrated R13c main `78e8e19` for the real external-input restriction test pair. Two bounded
consecutive continuations preserve typed partial responses, never dispatch truncated calls,
and persist explicit paired non-execution results. Platform/advisory nudges confer no user
approval; actual retries use ordinary turns, accounting, compaction and cancellation gates.
Only an attempted provider request emits `turn.continued`; no event on budget/abort/hook veto.
See [H7a contract](plans/H7a.md). Local verification, one bounded independent review and
exact-head PR/post-merge CI gate delivery. No live evaluation spending.

Updated-main build/typecheck pass; the full suite passes 2,308 tests plus two skips across
123 files with four workers (33 seconds). Fifteen new core cases and one rendering case
cover actual adapters, persistence, budgets and the R13c pair. Removing truncated-call dispatch
suppression made the named non-execution control run the incomplete call; treating the nudge
as fresh user input made the external-input pair execute forbidden first exec. Both mutations
were detected and restored before the full pass. One independent Claude review approved
`2ffc821` against main `78e8e19`, with no material findings: session
`fb321df8-52c6-45dc-a950-6d1bd57c05fb`, 167 seconds, 19 reported turns under the requested
24-turn cap, no restart. It independently ran build/typecheck and the full 2,308 + two skips
across 123 files. Optional notes are at the roadmap end; no production changes followed review.
Final exact-head three-platform CI remains the PR gate.

After R12c PR #158 merged, integrated main `06f5b4b` with both permission/continuation
renderers, CI suites and delivery sections preserved. Combined build/typecheck and all
2,337 tests plus two skips across 125 files pass (four workers, 31 seconds). No second
review for mechanical integration. R12c post-merge CI 34027192976 remains pending.

PR #160 then advanced main to `9eb28cd`; its committed R16 band and Static-scrollback
renunciation are retained. Repeated build/typecheck/full 2,337 + two skips across 125 files
pass (four workers, 32 seconds). R12c's main gate subsequently passed and is marked done.
The preceding head's Windows run 34027283321 initially hit the unchanged R13c real edit→test
fixture's 5-second timeout; isolated local checks and the full three-file step passed.
Exactly one authorized failed-job rerun on identical head `bca3348` passed all platforms.
Runner timing/contention is suspected, not proven; the original failure is retained in PR #161.
That diagnostic success is not the final-head gate after this main integration.

### R12c done — PR #158; post-merge CI green

Merge `06f5b4b` passed all three post-merge jobs in CI 34027192976; head `1921f00` passed
all three in CI 34026828848. Following delivery notes are implementation history.

Live grant inspection shows exact scope/duration/subject, age and matched-decision counts;
`/permissions revoke <exact-id>` changes the next decision without cancelling running tools.
Optional same-call policy receipts preserve custom/subclass compatibility and identify actual
rules/fallbacks without re-evaluation. Runtime grant matching counts consumed allow/deny
decisions, never previews; denial-only consumption supports separately gated fresh consent.
Correlated optional event sources drive visible rule/grant/handler/unknown explanations.
Malformed/mismatched/multiple/late reports cannot manufacture attribution. [Contract](plans/R12c.md).

Actual Ink/CLI/inert-shell tests inspect a counted grant, revoke its exact ID and observe the
next request ask/deny. First prompted call is handler-decided, subsequent match counts once;
failed tool execution still counts its authorization, while previews/base rules do not.
H6 snapshots add only source/correlation fields, preserving existing trace order and content.
Build/typecheck/full tests, restored mutations, one bounded review and current-head CI gate delivery.

Initial build/typecheck/full four-worker suite passes 2,271 tests plus two skips across 119 files.
Double-evaluation and preview-counting mutants were detected/restored; 28 focused cases pass.
Committed main `fba5d50` is integrated, preserving PR #115 topic guidance/tests; only this assigned
worktree is edited. Integrated checks passed unchanged. One bounded Claude review
`ad1a5faa-2e7b-4745-9068-5bc43627f006` approved with no material findings (18 turns),
independently passing 239 tests across ten files and typecheck. Optional presentation polish
stays at ROADMAP's end. Main `c62009b` is now integrated, preserving committed H7/R15/ACP
additions and all prior done markers; combined checks and exact-head CI follow.
Combined build/typecheck/full checks pass: 2,271 tests plus two skips across 119 files, four
workers (30 seconds). Base `c62009b` passed all three post-merge jobs in CI 34025571103.

R5a PR #157 main `7f01c4c` is integrated, retaining extension startup/controller/command
wiring and both Windows test selections. Combined build/typecheck/full suite passes 2,288
tests plus two skips across 121 files (four workers, 30 seconds). No new general review for
mechanical integration; updated exact-head CI and R5a post-merge CI remain delivery gates.

R13c PR #159 main `78e8e19` is now integrated; its post-merge CI 34026441186 and R5a's
34026041480 are all green. Same-call attribution/counts preserve R13c's any-live-deny restriction:
only the selected deny counts; superseded allows do not. Runtime tests cover both base ask/allow,
fresh handler attribution, subsequent ordinary matches and overlapping-deny ID/count receipts.
Removing fresh denial selection failed its control and was restored. Combined build/typecheck
and full suite pass 2,321 tests plus two skips across 124 files (four workers, 31 seconds).
Updated exact-head CI remains the delivery gate; no second general review for integration.

### R5a done — PR #157; post-merge CI green

Final PR head `005a16c` passed CI 34025733117 on all three platforms. PR #157 merged as
`7f01c4c`; exact post-merge CI 34026041480 also passed on Linux, macOS and Windows.
The following implementation narrative retains its historical intermediate gate status.

Mandatory strict sidecars validate before any selected extension import. Explicit paths and
trusted-project discovery are bounded and fail closed on equal-precedence duplicates; no home
discovery. Host-code warnings precede imports, and non-none sandbox modes refuse even under
YOLO. Once-per-built-agent activation uses a frozen minimal API and sealed atomic drafts;
declared surfaces and reserved names are enforced. Actual hooks, tools and TUI slash commands
are wired with startup receipts. Children inherit no extension surfaces; R13d hook identities
remain advisory, and R5b runtime cross-surface disabling stays separate. [Contract](plans/R5a.md).

Dependency rationale: H6/R5e foundations are delivered and R6g main `714732d` passed post-merge
CI 34023837383 before this fresh worktree. Integrated R13d `2ad720f` and R12b `326acdb`, retaining
registered principal capture and the scope-editing UI. Seventeen actual module/runtime fixtures
pass; reserved-tool and late-registration-seal bypasses failed their named controls and were
restored. Full updated-main checks, one bounded review and exact-head PR/post-merge CI gate
delivery. No live evaluation spend or new submilestones.

Updated-main build/typecheck and the full suite pass: 2,260 tests plus two skips across 119
files, using four workers without changing cases or timeouts. One independent Claude review
`9b729cf9-e085-476b-90f4-1c230a177f26` approved head `8299b9e` with no material findings and
independently repeated build/typecheck/full 2,260 + two skips across 119 files. The single
process ran 247 seconds: max24 was requested; the CLI reported 29 turns. No restart or second
review. Optional notes are at the roadmap end; final exact-head CI remains pending.

After external PR #115 advanced main to `fba5d50`, mechanical integration retained its topic
skill guidance and regression assertion. Build/typecheck and the full 2,260 + two skips across
119 files pass again with four workers. No new review or production scope expansion; the
updated exact-head CI supersedes the earlier PR-head checks.

Committed roadmap PR #156 then advanced main to `c62009b`. Its H7/R15 additions, ACP amendment
and fourth-pass narrative are retained alongside the verified done markers. Build/typecheck and
the same 2,260 + two skips across 119 files pass again. H7a then H7b are next correctness repairs
after R5a delivery, before R5b; this mechanical integration does not add another review round.

### R12b done — PR #155; post-merge CI green

Merge `326acdb` passed all three post-merge platforms in CI 34024734696; prior PR head
`eaae698` passed all three in CI 34024445722. Following pending notes are implementation history.

The TUI explains declared paths/class/argv separately from unknown effects and network access.
Bounded `s` editing proposes lexical path or supported foreground argv scopes with exact cwd;
the shared pure matcher must cover the current request before any grant is installed. Exact
future scope is printed before separate confirmation. Both ordinary and protocol-adjacent input
paths retain y/a/n/d behavior; framed paste and separate sandbox/MCP-change consent cannot mint
scoped authority. R12a audit/lifecycle and explicit base decisions remain intact. [Contract](plans/R12b.md).

Real Ink/CLI/runtime tests exercise inert shell commands, file writes, compatible reuse,
outside-scope refusal, no dispatch for a mismatched initial scope, and persisted audit ordering.
R12c inspection/reasons and R12d inheritance remain separate. Integrated R6g main `714732d`,
preserving catalogue/routing/effort guidance and all previous done markers. Build/typecheck/full
suite, restored mutations, one bounded review and exact-head CI remain delivery gates.

Integrated build/typecheck and full four-worker suite pass: 2,224 tests plus two skips across
116 files; focused scope/core-grant tests pass 45 cases. Missing-path coverage and before-preview
confirmation mutations failed the named controls and were restored. One bounded Claude review
`3c9c00d0-9e6c-4765-86e3-752b2e5ba17d` independently passed 216 tests (12 turns). Its one
material stale-preview finding was reproduced in actual Ink: an old preview allowed a single
protocol chunk to edit/re-preview/confirm. Exact prior-preview identity now gates confirmation;
the regression failed before the fix and passes after, along with 30 scope/UI cases. Optional
polish stays at the roadmap end. R13d main `2ad720f` is integrated; combined-head checks and
exact-head CI follow, without another general review.
The combined source passes build/typecheck and 2,243 tests plus two skips across 117 files
(four workers, 30 seconds); exact-head three-platform CI remains mandatory.

R12a PR #152 is done: merge `35f37ba` passed all three post-merge jobs in CI 34023253550;
the prior PR head `4d4620b` passed all three in CI 34022988940. This closes its prior pending
delivery notes below; permission records and limits remain documented in [R12a](plans/R12a.md).

### R13d done — PR #154; post-merge CI green

Merge `2ad720f` passed all three post-merge platforms in CI 34024190216 after green PR #154.
Following validation notes are implementation history, not outstanding gates.

Runtime context principals distinguish source trust, instruction authority and tool permissions.
All accepted hook injection/modification surfaces use collision-safe registered identities;
user steers are user/instruction, supervisor/hook contributions and platform-assembled replan
reminders default advisory. Optional recursive metadata survives canonical events, storage,
resume, unified provider requests and conservative compaction. Vendor fields/prose cannot
mint authority; vendor wire formats remain unchanged. [Contract](plans/R13d.md).

Trusted SDK config/control can explicitly delegate instruction authority to unique named hooks.
Visible bounded `context.delegation` receipts do not grant tool permissions. Revocation downgrades
retained content on the next request; replay and regrant cannot revive an old receipt. Historical
events remain immutable. SDK JavaScript is not sandboxed, and metadata does not enforce model
obedience; R13c permission restrictions remain a separate committed row.

Dependency-order rationale: R13a/R13b are delivered, including R13b main `97e18bf` all-platform
post-merge CI 34021998986. R13d's instruction-source registry is independent of parallel R12a
tool-dispatch grants and R6c/R6g generated-skill work. Integrated R6c main `09157ae` preserves its
schema/config/render changes. Ten new actual-runtime/schema/provider tests pass; revocation
bypass, hook-as-user and custom-compactor authority-laundering mutations fail and are restored.
Full integrated validation, one bounded independent review and exact-head/post-merge CI remain
delivery gates. No new submilestones or live evaluation spend.

Integrated R12a main `35f37ba` retains tool-grant lifecycle/audit and its permission schema split.
One bounded Claude review `6d68f4c2-7567-4dc6-a8ad-d91cd0aa6b8b` independently passed build,
typecheck and 2,203 tests plus two skips across 114 files (16 turns, 200 seconds). It found one
material inject-only post-tool authority laundering issue: retained tool text borrowed a delegated
hook note's authority. Success/error-path tests reproduced both failures; joining retained display
as advisory fixes both, while full hook replacements retain explicit delegation. All 12 focused
tests pass; optional review notes are at the roadmap end. No second general review.

The analogous pre-tool shallow-merge path is conservative: actual changed inputs keep registered
mutator identity but remain advisory/no receipt; no-op and ignored patches add no attribution.
Partial/no-op/ignored regressions all failed before this bounded fix, then passed. Fifteen focused
tests now pass. H6's inject-only result principal/hash expectations reflect the reviewed mixed
display downgrade; actual tool text and lifecycle order remain unchanged.

One overlapping local full run timed out the untouched E1 exact-upstream fixture at its existing
5-second limit; its isolated diagnostic passes in 559 ms and the reviewer's full run passes.
Final validation uses four local workers to avoid shared-container contention, without changing
test cases, assertions or timeouts. Remote exact-head CI remains mandatory.

Final updated-main build/typecheck and full suite pass: 2,208 tests plus two existing skips across
114 files, with four local workers (29 seconds). Source head `a595fb9` includes both reviewed-path
fixes; PR exact-head three-platform CI and post-merge main CI are the remaining delivery gates.

PR #154 then integrated R6g main `714732d`, retaining catalogue/default-prompt guidance and both
feature test sets. Build/typecheck and all 2,213 tests plus two skips across 115 files pass
(four workers, 29 seconds). No second review for this mechanical integration; fresh exact-head
CI supersedes the earlier pre-integration run.

### R6g done — PR #153; post-merge CI green

Merge `714732d` passed all three post-merge platforms in CI 34023837383 after green PR #153.
The following validation notes are implementation history, not outstanding delivery gates.

Optional bounded trigger strings reach the compact catalogue through strict parsing and
sanitization. A worked first-call example names an actually listed skill; the entire catalogue
stays within 8 KiB. Default routing and effort guidance preserve required verification,
configured limits and approvals. Generated emission, edit protection and opt-in defaults are
unchanged. [Contract](plans/R6g.md).

Dependency-order rationale: R6g starts from R6c main `09157ae` after all-platform post-merge
CI 34022647578 passed. It is independent of concurrent R13d provenance transport work; existing
prompt source/authority seams remain intact. Named ambiguity-gate and catalogue-byte-cap
mutations failed their intended controls and were restored. Full validation, one bounded
independent review and exact-head PR/post-merge CI remain delivery gates.

Integrated main `35f37ba` without production conflicts, preserving R12a grants and all done
markers. Build/typecheck and the full suite pass: 2,196 tests plus two skips across 114 files,
with four workers to avoid shared-container contention. One independent Claude review
`21a600fa-7f06-4d6c-a0ba-20803e760e03` approved source head `f3f07a7`, no material findings.
Its 20-turn bound ended before a verdict (164 seconds); one authorized tools-disabled final
summary turn used only gathered evidence (29 seconds). Reviewer build/typecheck passed; its
initial full run had 23 failures/timeouts across 10 unchanged files. Isolated reruns passed,
as did 117 related tests. Resource contention is suspected, not proven. There is no independent
single full-suite pass claim. The four-worker full pass above is our own validation. Optional
polish is at the roadmap end; exact-head three-platform CI remains authoritative.

### R6c done — PR #151; post-merge CI green

Final head `9c4951d` passed all three PR platforms and merged as `09157ae`.
Post-merge CI 34022647578 passed all three platforms.

Explicit `--generated-skills` / trusted config adds selected-memory and safe-home generated
roots through the existing trust/discovery boundary. Negative overrides and manual-root
precedence remain intact. Validated manifest metadata labels actual successful model loads
with optional `skill.used.generated: true`; ordinary events stay unchanged, and denied/missing
loads never count. Labels grant no permission, approval or benefit. [Contract](plans/R6c.md).

Dependency-order rationale: R6b PR #149 and main `7c680c4` passed all-platform post-merge CI
34021388430 before this new worktree began. R6c closes the opt-in mechanical learning loop;
R6g trigger work and live benefit comparisons are separate. Existing TUI slash invocation
does not acquire new usage telemetry. Integrated main `97e18bf` preserves the R13b provenance
seams and all previous done labels. Build/typecheck and 2,167 tests plus two skips pass across
111 files; 15 focused tests pass. Default-on discovery and dropped event-marker mutations fail
their named controls and are restored. One bounded independent Claude review
`81a14c0e-e6d0-4c3d-a570-df8e42420fba` approved head `7bc42c8` with no material findings,
independently repeating build/typecheck/full tests (90 seconds, 11 reported turns). Optional
polish is at the roadmap end; exact-head PR and post-merge CI completed successfully.

### R6b done — PR #149; post-merge CI green

Final head `d02ee57` passed all three PR platforms and merged as `7c680c4`.
Post-merge CI 34021388430 passed all three platforms.

Explicit opt-in skill previews bind human confirmation to an exact artifact digest. Fresh
runtime evidence, classification and effect receipts are mandatory at apply; saved reports
cannot authorize emission. Versioned string metadata round-trips through the real loader;
generated files are not activated. Edited/locked/foreign destinations are preserved. [Contract](plans/R6b.md).

Dependency-order rationale: R6b follows merged R6a/R5e and completed H4/R6e safety foundations,
independently of R13/R12 permission and provenance work. It does not implement R6c activation.
Build/typecheck, focused tests, full suite, named mutation controls, one independent review and
exact-head PR/post-merge CI are the delivery gates; final receipts belong to the closing PR.

Updated-main build/typecheck and full suite pass: 2,134 tests plus two skips across 107 files.
One bounded independent Claude review `e1112e28-ebef-4ea5-9c7b-0498f06d2f5e` approved head
`959cc97` with no material findings and independently repeated those checks. Named digest and
ownership bypass mutations fail the intended tests and are restored. No second general review.

### Committed continuation and parallel delivery

User direction on 2026-09-06: roadmap items are part of AgentRig's vision, not candidates awaiting
new demand justification. Continue in impact/dependency order. Independent items may run in
parallel in separate Git worktrees, each on a fresh branch from updated main and each ending in
its own merged PR. R13f repairs uncorroborated supervisor progress; R5e establishes fail-closed
manifest validation before generated skills and extensions; R5d pins MCP tool definitions and
requires consent for changes. These are independent first items.

R6a/R6b/R6c are delivered; the memory track continues with R6g. R12a follows R12e semantic
authorization, while R13d follows delivered R13a/R13b metadata and assembly. Dependency-aware
parallel starts preserve the committed queue and introduce no demand veto.

Each exact head needs appropriate tests, one bounded independent review with material findings
addressed, and green three-platform CI. Integrate current main before merging; serialize merges
and wait for green post-merge main CI. Optional polish stays at ROADMAP's end, with no recursive
submilestones. Inconclusive E3 results remain honestly reported; new live comparisons still need
an agreed spend budget, but do not block implementation. ROADMAP §5 contains the complete queue.

### R12a done — PR #152; post-merge CI green

PR #152 merged as `35f37ba` after all three PR platforms passed. Exact post-merge CI
34023253550 passed all three platforms. Remaining gate wording below is historical.

Validated bounded live grant records bind exact tool/class/argv operations, absolute lexical
path scopes, cwd constraints, subject/group and session/task duration. Core uses them only for
base-policy `ask`, preserving explicit allows/denies. Permission grant/revocation events flush
before dispatch; failed audit writes retain their queue head and prevent execution. No event
replay installs authority. TUI standing allow/deny uses `resource: *` records and now revokes
across `/new`, fork, session switching and undo instead of leaking across conversations.
Same-session continuation retains live session grants; task grants expire at run end. Shared
child groups remain compatible and `delegable` is explicitly unenforced until R12d. See
[contract](plans/R12a.md) for queue bounds, idle audit and advisory path limits.

Integrated R13b main `97e18bf`, retaining its provenance pipeline and all prior CI steps.
Build/typecheck pass with 2,176 tests plus two skips across 110 files and 151 focused cases.
All-path, post-answer-audit and session-transition-revocation mutations were detected and restored.
One bounded Claude review `8a03542b-c6e2-4b1b-886a-42012a286ad7` approved with no material
findings, independently repeating 151 focused tests and typecheck. R6c main `09157ae` is now
integrated; build/typecheck and 2,191 tests plus two skips across 113 files pass.
Exact-head and post-merge three-platform CI have passed. Optional polish
stays at the roadmap end. The bounded roadmap cleanup adds missing done
markers for R4a–R4c (PRs #135–#137), R6d/R6e (#139/#140) and R6f (H5a, #122), using the
explicit merge/CI receipts below; unfinished rows retain their scope.

### R13b done — PR #150

Final head `8486a53` passed all three jobs in CI 34021725480 and merged as `97e18bf`.
Exact post-merge CI 34021998986 passed all three platforms. Following notes are implementation
history, not outstanding delivery gates.

Trusted registered source metadata assigns actual MCP/external results `external`; file readers
require canonical approved-root containment before and after execution for `project`. Unknown,
failed or changed identity checks and hook-altered results remain external. Generic tool output
has unknown ancestry, and immutable overflow recovery is explicitly external. No name/prose
heuristics, permissions, principals or web-fetch implementation. [Contract](plans/R13b.md).

Built-in summaries join their precise source slice recursively, including repeated/nested
summaries. Missing/generated/tool-output ancestry is conservatively external. Custom compaction
receives detached messages: only exact structural copies recover original labels, ambiguous
duplicates join conservatively and changed output inherits all-input ancestry, never its claimed
labels. Legacy no-op compaction and aborted-child lifecycle behavior are retained.

Runtime MCP/file/symlink/overflow controls and resumed summary-laundering discrimination pass.
H6 trace changes are limited to new metadata and its derived request hashes/token estimates.
Full validation, restored negative controls, one independent review and exact-head/post-merge
three-platform CI remain closing delivery gates; optional refinements belong at ROADMAP's end.

One bounded Claude review `44f6ca76-9abe-4f58-baf1-e055d241fa4a` independently passed 119 tests
and typecheck, finding one material post-tool cancellation regression. A failing runtime test
reproduced duplicate result events; the fix degrades provenance without re-emission. All 18 new
tests pass. MCP source removal, summary upgrade and custom-retention bypass mutations failed
and were restored. Integrated R6b main `7c680c4`: build/typecheck and full suite pass 2,152 tests
plus two existing skips across 108 files. No second general review for mechanical integration.

Integrated-head CI 34021454352 exposed a macOS partial-child-output fixture race: its 25 ms
timer could abort before any text was emitted. Delaying initial turn persistence reproduced
the exact failure. The fixture now waits for actual first-tool entry with a bounded timeout,
then aborts; delayed startup and the exact partial-output assertion remain. Suppressing retained
child text still fails the assertion (mutation restored). Production code is unchanged; full
build/typecheck and 2,152 tests plus two skips pass, including 62 focused lifecycle/provenance cases.

### R12e done — PR #148 records delivery gates

Merge `6cf3865` passed three-platform post-merge CI 34019474635.

Explicit `--allow-command '["git","status"]'` / config argv prefixes now match a bounded
literal POSIX operation descriptor derived by trusted built-in bash after validated pre-tool
hooks. Names, transcript claims and MCP hints never mint authority. Unsupported syntax and
background calls cannot satisfy narrow scopes; existing explicit blanket authority is preserved,
with CLI deny rules first. This is not read-only/binary/PATH/Git-hook attestation and does not
implement R12a grant records or R12b–R12d lifecycle/UI. [Contract](plans/R12e.md).

Integrated main `76ac082` includes R6a and R13a; build/typecheck pass and the full suite passes
2,111 tests plus two skips across 105 files. Bypassing argv equality and deriving descriptors
before hook modifications both fail named negative controls; both mutations are restored.
Bounded Claude review `fb4da610-4af1-43fa-b597-98c52b1e2c0f` approves the code and independently
passes typecheck plus 136 tests. Evidence wording and committing docs resolve its two delivery
findings. Exact-head three-platform CI passed; main `6cf3865` passed post-merge CI 34019474635.
R5d's merged `008c2ba` passed post-merge CI 34018010003; Windows repair `3c857d0` passed
post-merge CI 34017665328. R13a main `76ac082` passed post-merge CI 34018763831 on all platforms.

### R13a done — PR #147 records delivery gates

Final head `deef3ab` passed three-platform CI 34018447400 and merged as `76ac082`.
Exact post-merge CI 34018763831 passed Linux, macOS and Windows.

Optional block-level provenance now round-trips recursively through unified messages, canonical
events/snapshots, fork materialization, actual provider requests and resumed turns. Custom-provider
labels are validated and text segments retain their boundaries; vendor JSON/prose cannot supply
those labels. Wire projections add no unsupported fields. Observing hooks cannot mutate nested
labels and outbound eviction does not flatten labeled children. [Contract](plans/R13a.md).

Parallel-order rationale: R13a carries metadata only and is independent of pending R12e/grant
work and R6a wiki procedures. No authority or permission is inferred; R13b assembly/compaction,
R13d principals and R13c enforcement remain later rows. This is not a claim those policies exist.
Build/typecheck/full tests, one bounded independent review, restored negative controls and exact
PR/post-merge three-platform CI are the delivery gates; closing receipts belong to the PR.

One bounded Claude review `128bce32-4807-4eb8-9eef-75511eb6c868` approved with no material
findings, independently passing 692 core tests and all-package typecheck. Schema-drop and
stream-assembly-drop mutations fail named persistence/resume controls and are restored. Actual
vendor text/tool-call provenance spoofing is inert, and a user-labeled call still obeys denial.
Crash-only raw-delta reconstruction remains unlabeled; no unrecorded provenance is invented.
After integrating R6a main `42cef62`, local build/typecheck/full suite pass
2,072 tests plus two existing skips (103 files);
66 focused trust/hooks/eviction/H6 trace tests pass with unchanged golden traces.
Previous head `a93406a` passed three-platform CI 34018081611; the integrated head requires
its own checks before merge. PR #147 records exact-head and post-merge receipts.

### R6a done — PR #146 records delivery gates

Final head `fe12d9a` merged as `42cef62` after green PR CI. Post-merge CI 34018319273
passed on all three platforms.

R6a is independently pulled forward after the completed H3–H5/R6d–R6f and R5e foundations
(R5e PR #142, main `26e78ec`). Report-only procedure detection does not depend on unfinished
permission-grant/provenance interfaces, so it can run in parallel; R6b/R6c remain dependent.
Opt-in dream/CLI detection carries H4 witnesses for every step, scope and limitation. Structural
mode is zero-call; bounded classification may reject but never rewrite candidates, then R6e
effect review is required for the distinct reviewed status. Existing model caps are unchanged.
No skills emitted, no permission change, no live evaluation or benefit claim. See [R6a](plans/R6a.md).
Closing PR records validation/review and exact-head/post-merge three-platform CI receipts.

One bounded independent Claude review `b71374d1-cfb4-45f2-b9aa-f219fa707721` approved, independently
passing build/typecheck, 2,013 tests plus two skips and 20 focused cases before integration.
Strict-classification and adverse-effect bypass mutations failed and were restored. Current
main is integrated before final validation; optional refinements remain at the roadmap end.

### Windows memory atomic replacement — merged in PR #145

Final head `0abdfc7` passed three-platform CI 34017429109 and merged as `3c857d0`.
Post-merge main CI 34017665328 passed on all three platforms; PR #145 records final receipts.

R5d combined-head CI 34016959860 failed the existing Windows two-process ingest conservation
fixture with `EPERM` renaming a temporary index over `index.md`. This is not evidence of a known
external actor or a proven transient. A separate bounded repair now retries only Windows
EPERM/EACCES/EBUSY under the existing writer lock: same temporary file, 250 ms monotonic window,
at most 20 ms between attempts, signal-aware waits and no destination deletion or force fallback.
Other errors fail immediately; exhaustion preserves the previous target and existing cleanup.
See [repair contract](plans/windows-memory-replace.md). Deterministic actual-store regressions,
the real Windows process fixture, one independent review and exact-head/post-merge CI gate its
own PR before R5d integrates it. R6a is independent after delivered memory/manifest prerequisites.

Build/typecheck and the full local suite pass 2,024 tests plus two skips (98 files). One bounded
Claude review `29dd2b60-97d3-4862-aa2e-759c20a5a954` approves with no material findings; it
independently passes 11 repair tests, 581 memory tests plus two skips and typecheck. Disabling
eligible retries fails all three error-code controls; removing the per-attempt abort check fails
the late-attempt control. Both mutations are restored. Windows CI retains the original fixture
and repeats its conservation case, alongside the deterministic repair tests. Final exact-head
and post-merge CI receipts belong to the repair PR; R5d's earlier independent review is unchanged.

### R13f done — PR #143 records closing delivery gates

Final head `01127b7` passed three-platform CI 34016646499 and merged as `1a20f4e`.
That merge passed post-merge main CI 34016868500 on all three platforms.

Core stamps unique runtime call provenance; only matching successful write-class results in the
same turn credit file claims to loop/stall and policy accounting. Drift additionally verifies
bounded current-worktree bytes before scope classification. Claims stay in immutable JSONL.
Legacy logs without provenance remain readable but receive no file-progress credit, including
the stall evidence counter. See [R13f contract](plans/R13f.md) for deletion, race and size limits.

One bounded independent Claude review `2fdeec4f-21ca-4b77-91be-60b0d6d14088` approved with no
material findings and 162 independently executed tests. Removing the write-class gate and
bypassing the content hash fail named tests; both mutations are restored. First-head macOS and
Windows CI caught an absolute-path alias bug (including `/var` versus `/private/var`), fixed with canonical
containment and a portable symlink/junction regression that fails against the old check. The final
branch integrates R5e main `26e78ec`; build/typecheck and the full local suite pass 2,013 tests
plus two skips (97 files), with both Windows targeted suites retained. Exact final-head
three-platform CI passed as recorded above; post-merge main CI gates the next merge. PR #143
records the closing receipts.
Optional refinements are at the roadmap end, not prerequisites for R5d or later rows.

### R5e done — PR #142 records delivery gates

Final head `aafaa5b`, PR CI 34016292275 passed all three platforms and merged as `26e78ec`.
Post-merge main CI 34016511315 passed all three platforms; R5e delivery is complete.

Strict versioned skill/extension/package schemas now reject unknown fields before use. The
existing skill loader rejects malformed frontmatter and equal-precedence names, including late
duplicates beyond the catalogue limit; plain Markdown and repository skills remain compatible.
Extension/package runtime consumers remain R5a/R5c, with reusable validation/surface seams ready.
See [R5e contract](plans/R5e.md) for the intentionally flat skill dialect and supported npm subset.

One bounded Claude review `989005b4-0c49-4e97-a101-b041c1cdd6f1` independently passed typecheck,
1,993 tests plus two skips and 58 focused tests. Its one material finding (incomplete package
script blocklist) is fixed by refusing all nonempty scripts; the added regression fails against
the old blocklist. Strict-schema and equal-precedence negative mutations also fail and are
restored. Final build/typecheck/tests and exact-head three-platform CI are required before merge;
post-merge CI gates the next merge. Optional review refinements are at ROADMAP's end.

### R5d done — PR #144 records delivery gates

Merge `008c2ba` passed three-platform post-merge CI 34018010003.

CLI run/TUI now persist MCP tool-definition baselines in trusted user state, scoped by canonical
config path and server name. First use is explicitly trust-on-first-use, not a safety assessment.
Changed names, descriptions or input schemas require exact before/after consent independent of
ordinary allow/YOLO and TUI standing answers. Unattended calls refuse; changes after advertisement
or during approval require reconnection. Bounded pin reads, complete-list validation and locked
CAS preserve prior approvals on errors or stale reviews. MCP tools remain `exec`; sandbox limits
are unchanged. See [R5d contract](plans/R5d.md) for the SDK trusted-host seam and attestation limits.

One bounded Claude review `fc691d69-5cc4-4e35-8b1f-92ac33e9da68` approved with no material findings,
independently passing typecheck, 42 MCP tests, the TUI consent test and 1,981 tests plus two skips.
Missing-callback and stale-advertisement mutations failed their named core controls and were
restored. The CLI adapter independently fails closed on absent user interaction. Real Node stdio
server tests use an independent effect marker; TUI tests show the exact delta and reject standing
grants. Integrated with repaired main `3c857d0`: build/typecheck and 2,037 tests plus two skips
(100 files) pass. The prior integration exposed the Windows memory replacement failure documented
above; its independently reviewed repair was merged in PR #145 and is now included. No second
general R5d review was needed. Previous head `65bbc0b` passed all three platforms in CI 34016609070; updated-head and
post-merge CI remain required before the next merge. PR #144 holds final receipts. Optional polish
is at ROADMAP's end, not additional release subdivisions.

### R6e complete (PR #140)

Final head `77a8814`, merge `2a3aee8`, PR CI 34013775380 and post-merge CI 34014007805 passed all
three platforms. One approving independent review, 1,968 local passes plus two skips, and two
detected/restored mutations. Following notes record the implementation checks, not pending gates.

Fresh branch from updated main `762aa0c`; [contract](plans/R6e.md). Add bounded, fail-closed
effect assessment beside runtime evidence eligibility. Preserve offline previews and explicit
publication confirmation; no keyword-only safety claim or automatic rewrite. Build/typecheck and
the full Node22 suite pass 1,968 tests plus two skips (95 files). One bounded independent review
approved and independently passed the same full suite. Effect-denial and artifact-binding
mutations were detected and restored. PR #140 records the final delivery receipts. R6f was
delivered by H5 and is not repeated. The user-authorized continuation above supersedes the
previous conditional stop after R6e; generated skills still need separate benefit measurement
before becoming a default, not before being implemented.

### R6d complete (PR #139)

Final head `2e14117`, merge `762aa0c`, PR CI 34012625855 and post-merge CI 34012808696 passed all
three platforms. One approving review, full local 1,945 passes plus two skips, final targeted 76,
and two detected/restored mutations. Following notes record intermediate gates, not pending work.

Fresh branch from updated main `412a9af`; [contract](plans/R6d.md). Complete advisory write-quality
lint on existing claim tags, and identify new model summaries as inferred synthesis instead of
observed evidence. No auto-rewrite or promotion change. Build/typecheck and the full Node22 suite
pass 1,945 plus two skips (94 files). One bounded Claude review approved, independently passing
the same full suite. Reporting and provenance negative mutations fail and are restored. Optional
polish stays at ROADMAP's end. R6e remains next, after exact-head and post-merge CI gates.

### H6 complete (PR #138)

Final head `6e6803b`, merge `412a9af`, PR CI 34011748505 and post-merge CI 34011951160 all green.
One independent review, 1,934 local passes plus two skips, unchanged complete baseline traces
and two detected/restored mutations. Following notes are intermediate records, not pending gates.

Fresh branch from updated main `3c09f84`; [contract](plans/H6.md). Extract internal tool-execution
and session-lifecycle components without changing the public API or event behavior. Three complete
golden traces captured before extraction still match unchanged. Build/typecheck and the full
Node22 suite pass 1,934 plus two skips (93 files). One bounded Claude review approved, independently
passing build/typecheck and 372 targeted cases. Two negative mutations were detected/restored;
one exposed and prompted repair of a replay-only test gap, with expectations unchanged. The final
trace test also passes against original main agent.ts. PR/main CI gates remain required.

### R4c complete (PR #137)

Final head `15c6e3f`, merge `3c09f84`, PR CI 34010906102 and post-merge CI 34011105236 passed
all three platforms. One approving independent review, two detected/restored mutations and one
scoped Windows E1 fixture-timeout repair. Full local 1,931 passes plus two skips. Notes below
record intermediate gates, not outstanding work.

Fresh branch from updated main `1291c77`; [contract](plans/R4c.md). Add opt-in post-settlement
supervisor restore using the existing guarded undo seam, joined through observer shutdown and
shared CLI/TUI wiring. Defaults unchanged; no user-abort-only restore, no force path. Integration
tests exposed and now cover normal iterator completion after cancellation being mislabeled done;
core preserves usage but reports aborted. Build/typecheck and the full Node22 suite pass 1,931
tests plus two skips (92 files). One bounded Claude review `db4e2583-64e6-45c0-9a34-1e42ee8bd5d0`
approved with no blockers, independently passing build/typecheck and 1,036 selected cases.
Opt-in-gate and cancellation-classification mutations fail their named tests and are restored.
Optional polish stays at ROADMAP's end; exact-head PR and post-merge main CI remain pending.

PR #137 initial head `6593f1b` passed Linux/macOS; Windows CI 34010786976 exceeded the unchanged
E1 signal/numeric-exit fixture's five-second test budget. A scoped test-only 30-second timeout
keeps all assertions and production limits; final-head three-platform CI is required.

### R4b complete (PR #136)

Final head `0dcbb09`, merge `1291c77`, exact-head CI 34009706860 and post-merge CI 34009896484
passed all platforms. One independent review approved; one test-only Windows fixture-budget
repair. Full local suite 1,917 passes plus two skips. Notes below record intermediate gates.

Fresh branch `feat/r4b-guarded-undo` from updated main `45dac7f`. [Contract](plans/R4b.md):
post-tool ownership checks, terminal seals, explicit guarded CLI/TUI undo, retained recovery
originals and independent audit logs. Older unsealed sessions refuse; no force option. R4c is
not pulled forward. Build/typecheck and full explicit Node22 suite pass 1,917 plus two skips
(91 files). One bounded Claude pass `0d3fecf5-0182-4d8c-9140-72e70d19c1fa` approved, independently
passing build/typecheck, 125 targeted cases and the full suite. Dirty-guard mutation fails its
named test and is reverted. Optional polish is at ROADMAP's end; exact-head/post-merge CI pending.

Initial head `365d206` passed Linux/macOS CI; Windows exceeded the 5-second Vitest default in
three multi-step Git cases. Raised only checkpoint integration fixture budgets to 30 seconds;
all assertions and production deadlines are unchanged. Final-head CI must pass before merge.

### R4a complete (PR #135)

Final head `cc037e7`, merge `45dac7f`, exact-head CI 34008045638 and post-merge main CI
34008201624 passed Linux/macOS/Windows. One independent Claude pass approved. Final targeted
rerun passed 130 tests, and the full suite passed 1,901 plus two skips. Notes below are historical.

Fresh branch from updated main `56b4d8a`, after E3 PR #134 exact-head CI 34006960314 and
post-merge main CI 34007074990 passed Linux/macOS/Windows. E3 is complete under its explicitly
amended AI-assessment method: 67 PASS / 29 FAIL; original evidence retained, utility inconclusive.
See [R4a contract](plans/R4a.md). Old PR #109/worktree are preserved; this new branch ports
selected reviewed pieces and adds conservative effect coverage, raw-byte capture and writer guards.
Checkpoint creation only; R4b/R4c are not pulled into this PR. Build/typecheck and the full Node22
suite pass 1,901 tests plus two skips (90 files). Claude's single bounded pass
`124693ac-c382-45ef-a044-41be0468eb87` approved and passed 127 targeted tests; its throughput
request is satisfied by a 1,000-file local sample (3,961 ms) and explicit non-guaranteed size ceilings.
Both effect-gate and scan-consistency mutation controls fail as expected and are reverted.
Optional polish is at ROADMAP's end. Exact-head PR CI, merge and post-merge main CI remain pending.

### E3 complete (PR #134)

Delivery complete: final head `9b0751c`, merge `56b4d8a`, exact-head CI 34006960314 and
post-merge main CI 34007074990 passed all three platforms. The following assessment notes
record intermediate gates; none remain outstanding.

The user authorized independent AI assessment on 2026-09-06 after collection. The Codex
maintainer reviewed all 12 X4 explanations under the unchanged rubric: one PASS, 11 FAIL.
Final amended outcomes: **67 PASS, 29 FAIL, zero pending**. This is non-blind AI review,
not human validation; original automatic outcomes and the 2,872-file archive remain unchanged.
See [assessment and sensitivity](reviews/E3-AI-ASSESSMENT.md), [attributed verdicts](e3-ai-review.json),
[derived outcomes](e3-reviewed-results.json), and [final comparison](E3-RESULTS.md).
Memory-only meets the numerical thresholds but the overall utility evidence remains inconclusive;
features stay opt-in. No further user prose assessment or live run is needed. Final-head CI,
merge and exact post-merge main CI are the remaining delivery gates before R4a.

Final maintainer build/typecheck and Node22 suite: 1,871 passes plus two skips, 89 files.
Fourth scoped Claude pass `ac90b428-f8b2-4a73-b48c-89d1912144fd` approved the assessor amendment,
count derivation and borderline-judgment consistency with no material blockers (read-only,
no tests/delegation). The earlier three passes are recorded below; no new roadmap subdivision.

#### Historical collection record (superseded assessor gate)

All 96 scheduled Luna attempts ran once: 66 PASS, 18 FAIL, 12 BLOCKED awaiting genuine X4
prose judgments. Total 9,358,630 reported tokens including training/ingest, zero incomplete
calls, no global guard stop. All regression/scope lanes passed. The full evidence archive and
[results/limitations](E3-RESULTS.md) are published in this PR; 2,872 file hashes were verified,
all 96 reports reproduced, and all 48 frozen memory copies matched. No feature benefit is
established pending human judgments; the supervisor-on memory comparison also exceeds the
preregistered token-overhead threshold. Features remain opt-in. Human packets:
[R1](reviews/E3-X4-R1.md), [R2](reviews/E3-X4-R2.md), [R3](reviews/E3-X4-R3.md).
Do not merge or start R4 before this gate, final analysis, final-head CI and post-merge main CI.
The notes below record implementation/collection history, not new submilestones.

Subscription-only Luna is authorized and connectivity passed. Protocol and stop rules are in
[plans/E3.md](plans/E3.md). E2 PR #133 is merged at d6d82f5; exact-head CI 33977198824 and
post-merge CI 33977351290 passed all three platforms. E3 will preserve A4/X4 human review gates.

The isolated runner, fixed schedule, unknown-usage guards and E2 bundle collection are implemented.
Claude review cdd0632f-5313-422a-a483-923d4776ccbe requested three repairs, then approved the focused
second pass with 51 relevant tests passing (actual Docker controls ran). A Docker timeout test
reproduced SIGTERM client hanging; SIGKILL plus exact UUID cleanup fixed it. All four SDK conditions
have scripted wiring tests. Maintainer build/typecheck and explicit Node22 full suite pass 1,868
plus two skips (1,870 total, 89 files). The initial review could not run build; maintainer did.
Real pinned A1 preparation/build and seeded-failure checker passed their expected controls.
Frozen runner 5d990d6 passed all-platform CI 33979321280. Training and SDK ingest consumed
104,010 reported tokens; the unchanged 96-attempt collection is running. Publication-only head
1054684 passed all-platform CI 33982491430 and maintainer build/typecheck plus 1,870 Node22
tests and two skips (1,872 total, 89 files). Claude's bounded publication-helper review
1413271b-8d6d-45b3-be0b-750f61f28dc2 approved without blockers (read-only, no test execution).
That is three scoped passes total: two runner passes and one publication pass, not new milestones.
The [first X4 human packet](reviews/E3-X4-R1.md) is awaiting the user's assessment. Read the
[collection limitations](E3-COLLECTION-NOTES.md), including training task-description overlap
and A4's ambiguous output contract. Live results, human judgments, final-head CI and post-merge
main CI remain pending; no benefit is claimed and R4 has not started.

### E2 complete (PR #133)

Fresh branch from updated main aeb5ac6 after E1 PR #132 final-head CI 33975625109 and
post-merge main CI 33975763463 passed all three platforms. Produce a compact report from
validated session events, independently checked outcomes and evaluator-owned configuration/
timing/auxiliary receipts. Unknown usage stays unknown; main and auxiliary work remain separate.
No live comparison or spend is authorized by this reporting row.

Implemented the typed bounded report and JSON/text script, additive main-usage completeness flag,
explicit role pricing/coverage, separate main/child and auxiliary totals, check/config/evidence
linkage and a synthetic negative-control bundle. One bounded Claude review approved with 63
named tests passing (typecheck commands denied; maintainer verified it). Maintainer additions
exercise real observer/maintenance integration, fix a reproduced same-millisecond snapshot-order
failure, and reject actual POSIX FIFOs without blocking. No second general review or new milestone.
Build/typecheck and full explicit Node22 suite pass 1,857 plus two skips (1,859 total, 87 files),
including 25 report cases plus schema/render regressions. Exact-head PR/main CI pending.

### E1 complete (PR #132)

Completion gate: final head 3ff8ba9, merge aeb5ac6, exact-head PR CI 33975625109 and main CI
33975763463 all green. Two Claude passes, focused approval after repairs; maintainer CI repair
for Windows exit metadata; build/typecheck and 1,830 Node22 passes plus two skips. Following
notes record intermediate gates, not outstanding prerequisites.

Fresh branch from updated main a14dd57 after PR #131 exact-head CI 33973659278 and
post-merge main CI 33973789052 passed all three platforms. Eight frozen tasks will cover
AgentRig and an external repository, with isolated preparation, independent behavioral checks,
separate regression results and explicit failure/block/skip rules. This is benchmark mechanics,
not live-model evidence. E2 reporting and E3 paid comparisons are not pulled into this PR.

Implemented `docs/EVALSET.md`, eight exact task definitions, new-directory-only pinned-tree
preparation and external-receipt checks with separate behavior/regression/submitted-test/scope
lanes. Investigation explanations require an independent human verdict and remain BLOCKED until
then. Twelve mechanics tests cover every task's positive/negative controls, exact upstream blobs,
scope violations after commits, malformed receipts and preserving existing work. Actual fresh
AgentRig A1/A2/A3 workspaces fail before repair and pass all lanes after repair; A1 demonstrates
why passing old regression tests alone is insufficient. Build/typecheck and full explicit Node22
suite pass 1,827 plus two skips (1,829 total, 86 files). Independent review and PR/main CI pending.

PR #132 initial head 73a3bad passed all-platform CI 33974947019. Claude review found two
blockers: infrastructure failures counted as task failures and a false-positive extraction check.
Both repaired; a focused second pass approved and independently passed all 14 mechanics tests.
Maintainer then normalized alternate back-import paths with an additional assertion inside the
same extraction test (not a third review). Final build/typecheck and explicit Node22 suite pass
1,829 plus two skips (1,831 total, 86 files). All eight actual pinned task workspaces have correct
controls: six code tasks pass; A4/X4 automatic lanes pass and honestly remain BLOCKED pending a
human verdict. These are maintainer controls, not model results. Final-head/main CI still required.

Repair head c163b6b passed Linux/macOS but CI 33975385360 caught a Windows-only test assumption:
Node exposes the self-SIGTERM fixture as a numeric exit rather than a signal. The test now checks
the actually reported metadata; a separate real timed-child test verifies portable ETIMEDOUT
classification. The documented Windows provenance limitation does not invent causes for numeric
exits. This is maintainer-tested CI repair within E1, not another review round or milestone.
Final CI-repair validation: build/typecheck and 1,830 explicit Node22 passes plus two skips
(1,832 total, 86 files), including 15 E1 mechanics tests.

### H5d auxiliary lifecycle complete (PR #131)

Completion gate: final head a1a586f, merge a14dd57, PR CI 33973659278 and main CI 33973789052
all green. One approving Claude review; four detected/restored negative mutations; final
build/typecheck and 1,815 Node22 passes plus two skips. H5 is complete. The following notes
record intermediate gates, not remaining prerequisites. Optional work stays at the END of ROADMAP.

Fresh branch from updated main 661634a after PR #130 final-head CI 33972036578 and main CI
33972161624 passed all platforms. See `docs/plans/H5-auxiliary-lifecycle.md`. This is the last
existing H5 deliverable before E1; no further recursive subdivisions or optional-polish gates.

Implemented bounded reviewer/grader SDK calls, observer cancellation through loaders and calls,
core observer-lifetime signal, validated cumulative auxiliary events and CLI/TUI unfinished-work
reporting. Main usage remains separate; late work cannot steer or append after session.end.
Shutdown joins the observer and suppresses later TUI diagnostics; remaining ingest/recall/observer
async diagnostic rejections are isolated. Build/typecheck and Node22 full suite passed 1,812 tests
plus two skips (1,814 total, 85 files); an additional real built-in partial-usage integration test
passes in the 19-test lifecycle suite. Full final rerun, independent review, negative mutations
and PR/main CI remain required.

PR #131 initial head c809b18 passed three-platform CI 33973353340. One bounded Claude pass
approved with no blockers, independently passing typecheck and 430 relevant tests; no delegated
reviewers. Three isolated negative mutations caught missing early cancellation, discarded usage,
and missing durable records, then were restored. Maintainer follow-up adds the explicit
pre-session-end-hook cancellation test and tightens total timeout across loaders as well as
model calls; that small deadline repair is maintainer-tested, not a second review round.
Final build/typecheck and explicit Node22 full suite pass: 1,815 plus two skips (1,817 total,
85 files), including 21 new lifecycle cases. Optional polish is at the END of ROADMAP.
Fresh exact-head PR CI and post-merge main CI remain required before E1.

### H5 persistence complete (PR #130)

Completion gate: final head d4fa2a2, merge 661634a, PR CI 33972036578 and main CI 33972161624
all green. Two Claude CLI rounds, focused approval after repairs; five detected/restored negative
mutations; final build/typecheck and 1,786 Node22 passes plus two skips. Following notes are
historical intermediate gates, not outstanding work.

Fresh branch from updated main ba4569c after PR #129 final-head CI 33970456552 and post-merge
main CI 33970638299 passed all platforms. See `docs/plans/H5-memory-persistence.md` for the
remaining acceptance checklist. No additional recursive milestones; optional polish stays at
the END of ROADMAP.

Implemented opaque frontmatter retention, whole multiline fact parsing/removal, conservative
metadata-bearing merge refusal, and scoped attempt lookup with separately bounded disposable
index rebuilds. CLI supervisor supplies session/timeout/query limits and warns on incomplete
ledger results while reviewing readable attempts. Existing staged-target and actual child cleanup evidence is documented without
claiming an unproven production fix. Build/typecheck and explicit Node22 full suite pass:
1,782 passed plus two skips (1,784 total, 84 files) at initial head 8c58e75, whose CI 33971331288
passed all platforms. Three isolated negative mutations were detected and restored.

First Claude review identified two blockers: oversized legacy records poisoned all scoped reads,
and torn claims disabled every reviewer. Repairs cap new records before claiming IDs, report
oversized legacy entries under the rebuild budget, and warn/continue on partial reviewer history.
Regressions cover raw preservation, repeated append/rebuild, aggregate limits and rejecting
diagnostics. Maintainer/review compatibility fixes also preserve legacy indented known metadata,
exclude continued reservation placeholders and protect existing temps on exclusive-create failure.
Build/typecheck and full explicit Node22 suite now pass: 1,786 plus two skips (1,788 total, 84 files).
Focused independent repair review approved all five repairs; no further blockers. That pass ran
no tests (alternate test command spellings were denied); maintainer Node22 results above are the
test evidence. Two Claude CLI review rounds total; the first's skill spawned extra finders despite
the prompt, and the focused second disabled delegation/skills. Two further negative mutations
reproduced both blockers, were restored, and all 40 targeted tests passed in the clean isolated
checkout. Optional findings are at the END of ROADMAP. Final documentation-only head still needs
exact-head PR CI, then merge and exact post-merge main CI before H5d.

### H5 workspace recovery complete (PR #129)

Completion gate: final head b618b2a, merge ba4569c, PR CI 33970456552 and main CI 33970638299
all green. One approving Claude pass, three detected/restored negative mutations, build/typecheck
and 1,770 passing Node22 tests plus two skips. Following notes record intermediate gates.

Fresh branch from updated main c820c84 after PR #128 exact-head CI 33969076711 and main CI
33969215100 passed all platforms. See `docs/plans/H5-workspace-recovery.md`. Recovery is explicit and limited to
registered, ownership-checked workspaces; it never guesses ownership from a temp prefix or age.

Scope reset requested by the user: no further recursive subdivisions. Finish the original H5
acceptance criteria, then E1. Current PR covers registered workspace handoff/disposal; remaining
required work is lossless persistence/scoped attempts, closure of the target/child-abort evidence,
and reviewer/grader auxiliary lifecycle/reporting. Nonblocking follow-ups go at the END of the
roadmap and are not prerequisites. Automated interrupted-install repair is deferred; protected
backups and conservative stop-writers manual recovery remain the safety contract.

The recovery draft passed its new process/ownership tests. Its full run exposed a stale repo-map
test assumption that this growing checkout's entire file list fits 8 KiB forever. Correct that
test here with controlled tree-before-symbols evidence and retain real-checkout byte/truncation
checks; no product budget change and no separate milestone/PR for test maintenance.

Implemented manifest-v2 producer/handoff state, UUID-bound preview/discard and CLI confirmation.
Real child-process tests prove active refusal, explicit release, exited-owner recovery and refusal
to steal even a crashed writer's lock. Replacement/malformed/legacy/unknown owners, partial
cleanup, cancellation and failed handoff are covered. Full build/typecheck and explicit Node22
suite pass: 1,770 passed plus two skips (1,772 total, 83 files). Independent review and exact-head
PR/main CI are still required.

PR #129 head 9323fb4 passed CI 33970298458 on Linux/macOS/Windows. One Claude pass approved
without blockers; nonblocking polish is at the END of ROADMAP. Negative mutations caught live
producer deletion, missing under-lock owner checks, and symbol-first repo-map starvation; all
restored, with the isolated targeted suite green. The final documentation-only update requires
fresh exact-head CI, then merge/main CI; it does not reopen implementation scope.

### H5c2c1 complete (PR #128)

Completion gate: final head 19f1a71, merge c820c84, PR CI 33969076711 and main CI 33969215100
all green. Two Claude passes approved (broad, then focused reset→apply repair). Final build,
typecheck and explicit Node22 full suite: 1,751 passes plus two skips (1,753 total, 82 files).
Four negative mutations were detected and restored. Notes below describe intermediate gates.

Fresh branch from updated main 74ffbf8 after PR #127 exact-head CI 33968092090 and post-merge
main CI 33968348026 passed all platforms. H5c2c is split into metadata/log preflight (c1),
abandoned workspace ownership/recovery (c2), and interrupted-install recovery (c3), each with
its own review/PR/CI gates. See `docs/plans/H5c2c1.md` for the current bounded scope.

Implemented log preflight with shared header/UTF-8/newline framing and a bounded contradiction
count allowance, before model calls. Explicit SDK/CLI stamp reset creates an exclusive sibling
hard-link backup then removes only the regular stamp under its canonical root lock. Missing
roots, replaced roots, active locks and non-files are refused; late abort finishes after backup,
and unlink failure names both retained links. Operators stop scheduled/running dreams first.
Build/typecheck and explicit Node22 full suite pass: 1,750 passes plus two skips (1,752 total,
82 files). Review and exact-head PR/main CI remain required.

PR #128 head 988a72d passed CI 33968775029 on all platforms. One Claude pass approved with
no blocking findings (Node24 full suite independently reproduced). Its hard-link portability
note is addressed with a safe-failure hint and documentation; scheduling-reset discoverability
is documented next to the command, and log dates explicitly mean consolidation start. This is
not a claim of richer in-error help for every scheduler/ENOENT path. Final-head CI remains a gate.

A final maintainer check found retained-review apply could resurrect an explicitly reset stamp.
Apply now mirrors absent live metadata as well as present metadata, before its first rename;
the copy and archived stamp remain intact. A real reset→apply regression covers this sequence.
This semantic repair receives a focused follow-up review; it is not covered by the first approval.

### H5c2b complete (PR #127)

Completion gate: final head ef7e072, merge 74ffbf8, PR CI 33968092090 and main CI 33968348026
all green. One Claude pass with conditional approval; F1/F2 and nits fixed with regression and
mutation evidence. The following notes are historical intermediate gates, not outstanding work.

PR #126 merged at 3e97b65 after exact-head PR CI 33965907380; main CI 33966024863 passed
all platforms. Fresh branch starts from updated main. See `docs/plans/H5c2b.md` for this row.

Implemented one SDK deadline across snapshots, bounded provider consolidation, regeneration and
opt-in automatic apply. Incomplete/failed model passes are review-only; late cancellation cannot
undo a live swap already in progress. Auxiliary snapshots/unknown usage reach CLI, lint, TUI and
scheduled hooks; shutdown joins cancelled maintenance. New tests cover stalled/late providers,
timer starvation, writer lock lifetime, post-swap cancellation, callback failures and UI wiring.
Local build/typecheck and explicit Node 22 suite passed: 1,728 passes plus two skips (1,730 total,
80 files). Independent review and exact-head PR/main CI remain required before H5c2c.

PR #127 initial head e0f42f6 passed CI 33967197739. One Claude pass recommended approval after
fixing zero-finding scheduled review retention on model failure; a repeated-cadence regression
now proves disposal without a false clean report. Final maintainer repairs also add clean CLI
rejection handling and warned second-SIGINT force exit, tested in real child processes. Shared
dream defaults, early SDK hook-limit validation and the shared-run API documentation close its
nits. Retained install artifacts/log-capacity preflight are assigned to H5c2c; late-TUI diagnostics
to H5d. Final build/typecheck and explicit Node 22 suite pass: 1,735 passes plus two skips
(1,737 total, 81 files). These repairs are maintainer-tested, not a second Claude pass; fresh
exact-head PR CI and post-merge main CI remain gates.

### H5c2a complete (PR #126)

Completion gate: final head 9c06f1c, merge 3e97b65, PR CI 33965907380 and main CI 33966024863
all green. Two Claude passes; final conditional-approval repairs maintainer-tested. The following
notes are historical intermediate gates, not outstanding work.

PR #125 merged at fb8201e after final PR CI 33963220803 passed; main CI 33963323981 passed
all platforms. H5c2a starts from that updated main. H5c2 is split into bounded wiki/raw scans,
full dream cancellation/accounting integration, and explicit owned crash recovery; each gets its
own sequential PR and gates. CI action-runtime deprecation warnings are recorded as non-blocking
maintenance rather than silently broadening this memory change.

Bounded tree/page/raw/evidence traversal is implemented with explicit per-pass entry/depth/file/
aggregate caps and cooperative scan cancellation. Tree copies use bounded reads and exclusive
writes, preserving modes and H5c1 fingerprint framing; existing rollback faults still execute on
the actual new write path. New regressions cover exact caps, growth-after-stat, FIFO/cycles, stage
failure, manifest-write abort and incomplete-ledger refusal of model work/automatic apply. Full validation and
independent review/CI remain gates; provider lifecycle and owned crash recovery are not complete.

Local build/typecheck and explicit Node 22 full suite pass: 1,681 passed plus two platform-specific
skips (1,683 total, 79 files), including 26 scan-boundary tests, at initial head b48e3c8. Initial
PR #126 CI 33964137769 passed all platforms. Review repairs add bounded consolidation/pin rereads,
pin/index output caps, the 4 KiB stamp guard, configurable scheduler scan limits, explicit incomplete
review artifacts, short-read allocation regressions and a historical fingerprint vector. Windows
CI runs scan cases, skipping only FIFO creation and POSIX mode-bit/vector checks there. Follow-up
full validation, independent repair review and fresh exact-head CI remain gates.

Review-repair validation: build/typecheck and the explicit Node 22 full suite passed with 1,696
passes plus two skips (1,698 total, 79 files); the scan suite now has 36 cases. All six substantive
first-review findings are addressed. A follow-up review and exact-head CI remain pending.

Second Claude pass confirmed all six original findings closed and recommended approval after
fixing the interactive TUI auto-apply bypass. That callback now forwards scan caps and rejects
incomplete auto-apply, with real filesystem tests. Scheduled auto mode disposes incomplete copies
on repeated cadences (no persistent-fault accumulation); explicit review still retains artifacts.
These final repairs are maintainer-tested, not a third independent pass. Metadata recovery and
`memory lint` cap configuration are explicitly assigned to H5c2c/H5c2b respectively.

Final repair validation: build/typecheck and explicit Node 22 full suite passed, 1,698 passes
plus two skips (1,700 total, 79 files). Fresh PR CI and post-merge main CI remain the final gates.

### H5c1 complete (PR #125)

Completion gate: final PR CI 33963220803 passed at b26f260, merge fb8201e, main CI 33963323981
passed all platforms. The notes below record intermediate implementation and validation gates.

H5b2 merged in PR #124 at 3eee3ea; main CI 33961430044 passed all platforms. H5c1 starts from
that updated main. H5c is split into guarded snapshot/apply, bounded dream lifecycle/recovery,
lossless regeneration/session-scoped ledger lookup, and the staged-child abort investigation.
Each is a separate sequential PR with review, PR CI, merge and main-CI gates. Current work closes
unlocked/stale apply and unsafe destination/staging reuse; it does not claim all dream calls are
already bounded or cancelable.

Guarded copy/apply and persisted source/output identities are implemented. The new fault tests
exercise actual failed second rename, failed restore, pre-swap abort and finish-after-first-rename
behavior. A separate child process holds the real store mutation lock while apply waits, then
apply rejects its now-stale snapshot. Linux local build/typecheck and the full suite pass
(1,643 passed plus two platform-specific skips, 78 files), including both additional abort cases.
Independent review and exact-head CI remain pending. Windows CI now includes lifecycle/apply tests.

PR #125's first CI run found a Node 22 incompatibility with copying onto a pre-created empty
directory using errorOnExist. Copying children into absent paths fixes that without weakening
ownership checks; root permissions are preserved and included in the stale snapshot check.
The full suite now passes on Node 22 too: 1,644 passed plus two platform-specific skips (1,646
total, 78 files). Isolated removal of the content fingerprint check and source apply lock each
fails its regression; restored code passes. Review and repaired-head CI remain pending.

First independent review's fixes retain stale scheduled-apply artifacts, expose lock acquisition
waits, surface live stamp failures, and retain physical lock identity through dangling root aliases
during a swap. Added inverse copy/writer, stamp-lock, alias-gap, bounded-manifest and scheduled
stale-artifact regressions. CLI review text names both artifact and manifest. CI's pin-race fixture
now uses canonical output paths on macOS/Windows. Build/typecheck and full Node 22 suite pass:
1,654 passed plus two skips (1,656 total, 78 files). Repair review and fresh CI remain required.

Second independent review verified all eight findings resolved and found no blocking regression;
CI 33962954177 passed all platforms at ed792ea. Its two final small refinements are applied:
completion callbacks run after successful disposal and outside the apply-error catch, and global
store construction receives the configured timeout. A throwing-callback regression proves cleanup
and notification-only diagnostics. Final build/typecheck and Node 22 full suite: 1,655 passed plus
two skips (1,657 total, 78 files). Two Claude passes; these final small refinements are maintainer-
tested, not a third independent review. Final-head CI and post-merge main CI remain pending.

### H5b2 complete (PR #124)

Completion gate: final PR CI 33961342727 passed at f2edf579, PR #124 merged at 3eee3ea,
and main CI 33961430044 passed all three platforms. The notes below record intermediate gates.

H5b1 merged in PR #123 at 5fc2cb8; post-merge CI 33958820304 passed all platforms.
H5b2 starts from that updated main. It bounds ingest input/model/backend work, propagates abort
through commit boundaries, and reports auxiliary usage separately, including unreported usage.
Dream lifecycle and reviewer/grader adoption remain H5c/H5d, not implicitly complete here.

Implementation now includes linked call/run deadlines, late-result isolation, bounded file/model/
coverage work, signal-aware ingest mutations and optional backend requests, plus a shared types-only
auxiliary accounting contract. Synthesized adapter zeros are explicitly unreported. CLI and scheduled
ingest expose reported/unknown usage and local-write completion state; durable session aggregation
remains H5d. See [plans/H5b2.md](plans/H5b2.md) for exact limits and OS/remote cancellation boundaries.
New lifecycle/adapter tests pass; full validation, independent review and CI remain merge gates.

PR #124's first review ran typecheck and the full suite (1,594 passed + two platform skips).
CI 33959675267 passed all three platforms at ca3fd26. Review fixes expose limits through CLI/config
and hooks, avoid swallowed backend failure outcomes, tolerate malformed usage as unknown, reserve
backend call slots, and preserve committed results on later abort. Inspection also moved CLI
attempt-ledger scanning inside the run's bounds and removed pre-run initialization. Added tests
cover shipped composition, write-side file caps and FIFO rejection. Repair review and fresh CI
remain pending; these are not yet completion claims.

The second review reran typecheck/full tests and confirmed all five original findings closed.
Its two remaining integration regressions are corrected: scheduled ingest retains backend failure
diagnostics, and malformed CLI session IDs report clean errors. Span flags validate at parse time;
tests cover agent-builder forwarding and Lore's own fetch deadline. Full suite: 1,618 passed plus
two platform-specific skips (1,620 total, 77 files). CI 33960504444 passed all platforms at af7b4f8;
the final narrow delta still needs review and fresh CI. Ledger-wide limits intentionally fail
visibly; session-scoped attempt lookup is recorded under H5c rather than silently omitting history.

Third, narrow review reran typecheck/full tests and verified those fixes. Its final two small
refinements are applied and regression-tested: scheduled backend diagnostics use the visible
onHookError channel (including TUI), and config span sizes share the CLI upper bound. Broader
recall diagnostic routing is queued in H5d. CI 33961117588 passed all platforms at d309c30; the
refinement commit still requires fresh CI before merge. Three review passes, not a new broad
review cycle for the final two targeted changes.

### H5b1 complete (PR #123)

Completion gate: final PR CI 33958721558 passed at ee5afc2, PR #123 merged at 5fc2cb8,
and main CI 33958820304 passed all three platforms. The notes below record intermediate gates.

H5a merged in PR #122 at 3393785; post-merge CI 33955259134 passed all three platforms.
H5b is split into H5b1 persistence/repair and H5b2 bounded cancellation/accounting, each a separate
updated-main branch/PR with review and CI gates. Current work migrates ingest/provenance/pins,
corrects stale shorter captures and repairs incomplete log initialization. Provider/backend lifetime
and accounting remain H5b2; no claim that abort already cancels those calls.

PR #123 migrates source/entity/provenance writes to checked-state transforms and serializes pin
updates. Pending captures remain retryable; raw-event prefix hashes identify shorter stale logs
without confusing canonical-message projection changes. Both replacement tools recheck pins.
Distinct sessions still distill concurrently, while same-session/case aliases share a separate
lock. See [plans/H5.md](plans/H5.md) for partial-commit, recovery and H5b2/H5c boundaries.

CI 33956220720 passed Linux/macOS/Windows at 2dbce51. Two independent reviews prompted final-trailer
capture parsing, single-line normalization of newly distilled facts, preserved interior narrative
blank lines, no-findings bookkeeping, lazy initialization, bounded/cancelable lock acquisition,
applied/skipped pin counts, comment-free pin matching and no-op status writes. Tests also prove
dream pin persistence and malformed-input failure without modifying its source wiki.

Current local validation: build/typecheck and 1,556 tests pass plus two Windows-only skips
(1,558 total, 74 files), including 53 persistence cases. Real processes test same-session skipping
and distinct-session fact/source/index/pin conservation; fixture assertions pin own-PID session-lock
ownership during providers and mutation-lock ownership during source/concept transform reads.
Isolated mutations of shorter-prefix detection, provenance locking, page-update locking and pin
page-version guards fail relevant regressions; restored tests pass. The process test was strengthened
after an outcome-only version escaped a lock-removal mutation through favorable scheduling.
Repair review and repaired-head CI remain pending. Legacy multiline facts and unknown-frontmatter
preservation discovered during inspection are recorded under H5c, not claimed complete here.

Capture repair review at 4746913 found no blocking issue; its minor test/documentation notes are
addressed. Pin review verified snapshot guards but found skipped dream statuses only reached an
optional callback. Counts now travel in the returned/rendered report and count as findings even
without that callback; a deterministic pin-edit fixture proves it. Dream passes its actual store
to validation; per-input-check counts and upgrade-induced comment-only status corrections are
documented. CI 33957190843 passed all platforms at 4746913; this final reporting delta still needs
independent review and latest-head CI.

Six independent Claude review passes are complete. The final pass verified guarded pin snapshot
comparison and external staleness checks; its remaining canonical-path fixtures and advisory-channel
documentation are corrected. Duplicate status-changing checks now count consistently against the
original guarded snapshot. The CLI labels advisory dream diagnostics as warnings or failures, not
necessarily a failed dream. All-platform CI 33957831735 passed at e75a8ef; final corrections await
fresh CI. Provider lifetime and dream swaps remain explicitly in H5b2/H5c.

### H5a complete (2026-09-05; PR #122)

H4 merged at 2eb5632 and post-merge CI run 33952441371 passed. H5 is split into ordered sub-items
H5a–H5d (ROADMAP); each gets its own branch/PR and all validation gates. H5a adds guarded writes
and store serialization; maintenance integration/cancellation remains H5b–H5d, not implicitly done.

Page reads and write receipts carry 128-bit content-hash tokens; agent replacement tools require
the checked token, or create-only absence. Conflicts expose the current content/version for an
intentional merge. Metadata defaults come from the checked state. Content tokens are not monotonic
generations. Cross-process locks serialize page/index/log mutations and reservations; they have
bounded waits, never steal by age, and report stopped-writer recovery paths. Init remains available
for read-only inspection behind a stale lock. Committed writes remain explicit successes with
warnings if index, pin recheck or release bookkeeping fails. Real reservation placeholders remain
planned through dream. See [plans/H5.md](plans/H5.md) for the cooperative-writer boundary.

Build/typecheck and 1,503 tests pass with two Windows-only skips on Linux (1,505 total, 73 files).
Coverage includes actual two-process CAS plus 50 conserved appends, stale/raw-edit conflicts,
metadata races, aliases, malformed/absent tools, CLI recovery inspection, failed marker/identity/
release/index/pin writes, timeout/abort, Windows delete-pending retries, and deterministic missing-log
initialization races. Isolated mutations removing CAS checks, shared locks or pin-warning handling
fail their corresponding regressions; all mutations were restored.

Independent reviews closed the correctness findings; the repair review at 58d3d0b reproduced the
full suite and found no introduced correctness gap. The separate staged-abort fixture review is
clean; ten readiness/FIFO repetitions retain both AbortError and unchanged-target assertions.
CI 33954441586 passed Linux/macOS/Windows, including both Windows-only lock tests. Final diagnostic
wording/readability edits require narrow review and latest-head CI before merge. Main CI must then
pass before the next updated-main branch. H5b owns ingest/provenance/pins migration and the newly
recorded empty/partially initialized log recovery; H5c owns dream swaps/recovery. None is implicitly
protected just because H5a primitives exist.

Final narrow review at 229a365 closed all remaining notes. CI 33954975532 passed Linux/Windows;
macOS passed every test assertion but detected an unhandled rejection in the injected-fstat test.
Its expected path is now resolved before starting the rejecting operation, so the rejection
assertion attaches synchronously. No production behavior or unhandled-error gate was weakened;
repaired-head CI/review were required. Final fixture review at a7b2cd5 reports no findings, PR CI
33955143444 passed every platform, and post-merge main CI 33955259134 is green.

### H4 complete (2026-09-05; PR #121)

Promotion selection now requires an opaque runtime-loaded evidence index, not model/page-written
validation claims. Bounded regular raw logs are checked for identity, sequence, lineage and exact
claim locations in complete tool-result text. Each distinct claim needs at least two independent
witnesses; related fork/subagent ancestry and whitespace-normalized copied payloads count once.
Unsupported prose cannot accompany checked claims. The initial literal support rule deliberately
rejects unsupported paraphrases; semantic truth remains unassessed and page confidence advisory.

Dream selects final post-consolidation pages and reports event/field/character ranges, hashes and
excerpts without publishing. Manual promotion previews by default and rechecks with `--confirm`;
only checked claim lines/supporting references reach the backend, not invented extra citations.
Transport failures no longer print a false success. Local wiki pages and raw logs are untouched
by promotion. See [plans/H4.md](plans/H4.md) for the trust boundary and bounded-validation limits.

Initial build/typecheck and all 1,436 tests passed; initial PR CI was green on all three platforms.
Focused regressions cover fabricated citations,
unrelated sessions, split claim support, copied/forked evidence, location hashes, incomplete output,
resource limits, malformed logs, final dream pages, checked publication artifacts and CLI confirmation.
Independent review found agent-input echoes and legacy truncation markers could establish false
witnesses. Repairs reject claims present in session/ancestry tool inputs, exclude receipt/memory
views, recognize legacy truncation and bind receipt exclusions to registered tool names. Windows
CI exposed native-separator wiki identifiers; discovery and legacy index parsing now keep identifiers
portable while preserving literal backslashes in POSIX filenames. Every excluded tool receives a
behavioral rejection test. Build/typecheck and all 1,456 tests (72 files) pass; the promotion/CLI
pair has 46 tests and the Windows trio (including store tests) has 54. Six independent review
passes close all findings, ending with no findings at 76e368a; Linux/macOS/Windows CI is green
on that code head. Mutation tests prove that restoring citation counting, independent
fork families or the wrong skill name makes the corresponding regressions fail. The temporary
mutations were restored. Cross-session/encoded self-authorship and custom/MCP receipt semantics
remain explicit human-review limitations; H4 does not prove semantic truth.

The earlier macOS run 33952067241 timed out in H1's staged-write-abort test (not an H4 test).
The isolated local test and the next full macOS run pass; its cause is not established. H5 tracks
investigation of that abort/cleanup timing alongside the newly found reservation-placeholder bug.
Neither the timeout nor assertions were weakened. H5 starts after PR and post-merge main CI pass.

### H3 complete (2026-09-05; PR #120)

Ingest preserves canonical assistant text with labeled legacy/interrupted-stream fallback,
complete recorded tool output/input and full steering/errors. Patched displays remain separate
from original evidence. Lossless bounded spans carry line coordinates and half-open UTF-16
character ranges; prompts retain evidence-origin labels even in long-event continuation spans.
Missing historical full output and non-text evidence are reported as omissions, not inspected
coverage. Source pages persist coverage/omission accounting, CLI/hooks surface omissions, and
old projector captures are reprocessed once under the new contract. Corrupt/torn JSONL fails
before provider calls or wiki writes and can be retried when complete.

See [plans/H3.md](plans/H3.md). Tests pin canonical/legacy deduplication, assistant-only conclusions,
late tool evidence reaching distillation, exact bounded ranges, Unicode/blank lines, omissions,
corrupt logs and capture migration. Five independent Claude reviews closed all findings, ending
with no findings at code head 876bd3d. Build/typecheck and all 1,408 tests (70 files) pass; Linux,
macOS and Windows CI is green. Mutation checks detect removed assistant conclusions and restored
display-only truncation. Reviews/local diagnostics added denial records, duplicate-preview labels,
canonical-only request/result identity, nested omissions and missing-log coverage.

The additive `tool.result.outputIncomplete` field preserves collection limits through durable
logging, even with partial artifacts; ingest reports the unavailable range. Requested read_file
pages remain complete for their range and advertise further lines without phantom trailing-newline
pages. Glob/grep caps and abbreviated matching lines are explicit to both the model and ingest.
Coverage means the recorded textual range was submitted and accounted for, not that the model
verified its claims; runtime-backed promotion eligibility is the next row, H4.

### H2 complete (2026-09-05; PR #119)

Repository maps prune `.claude/worktrees` and `.worktrees` descendant containers before scanning,
so generated files consume neither the prompt budget nor the freshness snapshot. `.claude`
instructions/commands, ordinary `worktrees` directories and submodule contents remain visible.
Mapping a checkout as the requested root still works. Bounded regular in-tree gitfiles pointing
into `.git/worktrees` identify linked checkouts in other containers; `.git/modules` submodules
remain visible. Gitfiles themselves are omitted. Other layouts can use `excludePaths`; existing
exclusions are canonicalized so aliases such as macOS `/var` match the canonical map root.
No Git commands or reads into external Git metadata are used.

The initial full suite passed all 1,372 tests in the actual workspace with existing review
worktrees present. macOS CI exposed the exclusion alias bug; independent review also requested
arbitrary-container linked-worktree detection and omitted gitfiles. Repairs add alias-path and
gitfile regressions alongside budget/freshness isolation, instruction visibility, submodule
preservation and checkout-root behavior. The repaired head ac951a5 passes build/typecheck and
all 1,375 tests (70 files); Linux/macOS/Windows CI is green. Independent delta review closes all
three findings with no remaining findings. Mutation checks prove the fixtures detect removal of
both filtering and canonical exclusions. Bare-repository/custom Git metadata layouts still use
explicit exclusions when not inside a recognized generated container.

### H1 complete (2026-09-05; PR #118)

Built-in file mutations now cross the actual process sandbox using a fixed program and stdin
data, staging then renaming to preserve the target on interrupted input. Read-only and outside-workspace writes fail even under allow-all permissions. Docker
uses the caller's UID/GID so its artifacts do not become root-owned. Unsupported tools, including
memory mutations and network-backed recall, require explicit one-call outside approval; headless denies.
Local memory read/search and sandbox-inheriting subagents remain available. Host hooks
(including end-of-session memory maintenance) and CLI MCP startup are refused in enforcing modes.
Trusted SDK code, provider calls, reads and session bookkeeping are not isolated; compatibility
is declared by trusted registration code, never by a model, MCP annotation or permission class.

Validation: build/typecheck and all 1,369 tests pass in a clean checkout, including live Docker,
interrupted-target preservation, hardlink replacement, physical symlink resolution, local memory
retrieval and subagent boundary checks. Linux/macOS/Windows CI passed on code head ca81510.
Four independent Claude review rounds closed all findings; the final delta review has no findings.
Review prompted atomic writes, SDK policy propagation, retained local recall/subagents, physical
symlink handling, stronger negative tests and documentation corrections. Mutation checks confirm
the outside-cwd tests detect bypassed policy and the Lore fixture detects removal of the CLI fix.
At H1 verification, the nested-worktree map failure remained H2; no user worktrees were removed to obtain
this result. See [plans/H1.md](plans/H1.md) for implementation and trusted-host limitations.
Each subsequent row starts only after the preceding PR and post-merge main CI are green.

The user requested a roadmap revision following the code review. The authoritative order is
[ROADMAP §5](ROADMAP.md#5-sequencing-and-exit-criteria): **H1–H5 → E1–E3 → R4 → H6**, followed
by memory write-quality hardening and conditional generated skills. R4a is no longer next.
Broader capability work is backlog, activated by a concrete need and measurable acceptance.
R6f's stale-write work is pulled into H5; the minimum R9/R14 measurement work is pulled into E.

Why: the review reproduced direct file writes outside the workspace under both sandbox modes,
loss of assistant conclusions and long tool evidence before ingest coverage planning, and
promotion eligibility based on nonexistent session citations. The repository map also scans a
nested review worktree, exhausting its budget. These gaps must be corrected before expanding
the system's authority or turning memory into durable instructions.

Current limitations after H4: only supported effects cross the sandbox; trusted SDK code and
bookkeeping remain host operations. Shell authority is path-based and pre-existing hardlinks may
alias outside inodes; the file broker avoids that alias through atomic replacement. Promotion now
checks located textual witnesses, but does not prove semantic truth or all source independence.
Neither supervisor nor memory
benefit is established by scripted-provider tests alone. In-process extensions, if added, remain
trusted code with ambient env/filesystem access despite a restricted API object.

Review baseline: build and typecheck passed; tests reported 1,352 passed, one failed (nested
worktree in the repository map), one skipped. The original roadmap revision changed documentation
only and preserved existing R identifiers. H1–H4 implementation and validation are recorded above;
the remaining H/E rows are still planned. Older notes below
record decisions at the time; they do not override these priorities or current limitations.

| M | Deliverable | Status |
|---|---|---|
| 0 | Monorepo skeleton, event schema, session JSONL store, replay CLI | done (2026-08-29) |
| 1 | Core loop: Anthropic adapter, 6 tools, allow/deny/ask permissions, budget, headless `run` | done (2026-08-29) |
| 2 | OpenAI-compatible adapter, compaction, resume | done (2026-08-29) |
| 2.5 | Experimental `openai-chatgpt` provider: device-code OAuth against a ChatGPT subscription (PLAN §2.9) | validated live (2026-08-30) — authenticates and reaches the model; credential must be seeded from Codex, see notes |
| 3 | Memory v1: wiki layout + `SCHEMA.md`, session-end ingest, `index.md` injection, index ∪ BM25 search, attempts ledger, pins | done (2026-08-29) |
| 3b | Lore backend: `MemoryBackend` seam + Lore adapter (ingest push, recall union, promote, provenance both ways) | done (2026-08-29) |
| 4 | Supervisor v1: heuristic detectors, policy ladder, inject/escalate/abort | done (2026-08-29) |
| 5 | Dream = scheduled lint over a wiki copy, review/auto, promotion to global | done (2026-08-29) |
| 6 | Supervisor v2: trajectory reviewer + rubric grader, force_replan | done (2026-08-29) |
| 7 | TUI, hooks, MCP client, subagents, skills — as dogfooding demands | done (2026-08-30) |

## Release-train policy

- The checked-in `topic` skill changes multi-row roadmap bands from a per-PR merge word to one
  explicit human authorization up front. That invocation applies only to the named band's fixed,
  ordered row list and is preserved verbatim in each landed PR description, squash body, and the
  parent's final report. Each row still gets its own branch from the CI-green merged predecessor,
  dogfood builder, isolated independent review, conditional land, and post-merge `main` CI watch;
  this is sequential land-as-you-go, never a stack of open PRs.
- The authorization is bounded by fail-closed stop conditions. MEDIUM/HIGH findings, unverifiable
  review claims, merge conflicts, red CI on the actual PR head or post-land `main`, and children that
  exhaust their budget all halt the train for a human. LOW findings are never waived or skipped: the
  train gives them one narrowly scoped fix child and one delta re-review, then lands only on a clean
  result or halts. The train never rebuts a finding on its own. A preflight reserves five child
  slots per row and requires at least 60 turns per child; because pool size divides a configured
  parent token cap, that cap must rise proportionally (or remain unset). Undersized runs halt before
  branching. A TUI topic train must start after `/new`, keeping its raw human invocation as the
  non-compactable first message in a provenance-labeled block; repository-authored delimiter lines
  are neutralized. Subagent results expose the child's session
  id, which the conductor immediately restates before tool-result eviction can remove it.
- Caveat: unattended bands run unsandboxed until R2 lands. Up-front authorization removes repeated
  merge pauses; it does not add OS isolation. Use this mode only in an environment whose current
  unsandboxed execution risk is acceptable, and treat any halt as a successful safe outcome.

Second `/topic R2` run (halted at R2b on a HIGH contract finding): the halt rule keyed on severity,
and severity is not fixability. The rule is now: any finding that carries a concrete proposed fix
is repair work whatever its severity; a contract/authorization finding is arbitrated first and the
fixer carries the verdict; an unverifiable claim is fixed with evidence or by deleting the claim;
only a finding with no fix, or an arbiter "needs the human", halts. `ship` says the same for its
human-requested fix round.

Third `/topic R2` run: R2c landed unattended, R2d halted after its one repair round because the
delta reviewer found a second test gap — with the fix in its own report. That halt was the rule
being wrong, not the train: the train had stopped on a finding a child could close. `topic` §3 is
now a bounded converging loop (at most three repair rounds per row, each must close the previous
round's findings, residual LOW/MEDIUM lands recorded, residual HIGH halts), a reviewer or fixer that
dies is replaced once, a stale head gets a fresh reviewer, a finding with no proposed fix is the
fixer's to find. The only halts left are listed at the end of the skill. The child pool is sized for
the band rather than reserved per row; set `subagentMaxChildren` to at least nine per row you want
to survive three rounds.
Residuals are GitHub issues, never PR-body prose: after the third round the last fixer files one
`review-residual` issue per open finding and lists the numbers under `## Residuals`; the lander
refuses a PR whose residuals lack issue numbers. dogfood and ship say the same for anything a
review found that the PR does not fix.
First `/topic R3` run halted R3a after repair round 2 because the round "started with one finding
and ended with one" — but the one it ended with was new, in code the fix touched, and the given
one was closed. The convergence rule counted; it now asks only whether the given findings closed
and none reopened. A new finding is the next round's work until the cap.

## Abort grace: a parent waits for the children its abort orphaned (#86)

`control.abort()` raced past a running tool via `raceAbort`, so a parent's `session.done` resolved
while a subagent it had aborted was still writing its snapshot and `session.end`. Readers of the
child's log in that window (`sessions show`, the abort test) saw a session with no end; the test
flaked roughly one run in five. The loop now keeps the promises an abort orphaned and, in its
`finally`, awaits them before the snapshot, `session_end` hooks, and `session.end`, bounded by
`abortGraceMs` (default 1s). Past the grace it ends anyway and records a non-fatal `error` naming
how many executions were still running. No new event type; no-op on a session that was not aborted.
The default is deliberately short: an aborted child finishes its log in milliseconds (its hooks
are skipped, see #88), and the existing "abort wins over a tool that ignores its signal" contract
means an abort must not sit behind a hung tool for long — a 10s draft made those tests time out.
If #88 makes `session_end` hooks run on abort, a child in a slow ingest will outlive this grace and
be recorded as still running, which is honest but worth revisiting then.

- Rejected: fixing only the test by polling the child's log. The observable contract — a parent
  that says "aborted" has no running children — was the thing that was false.
- Rejected: an unbounded wait. A child inside a long `session_end` hook would hold its parent's
  abort open for the hook's full budget; the grace keeps abort responsive and the record honest.
- Tests hold the child's end open at its store (`GatedStore`), not with a slow `session_end` hook:
  an aborted session skips its hooks entirely (`runHooks` returns at once on an aborted signal),
  which also means memory ingest never runs for an aborted session — filed as #88.
- Review findings folded in: the grace timer is deliberately NOT unref'd — a first draft unref'd
  it, and in a bare process (not under vitest) Node exited mid-grace with no snapshot and no
  `session.end`, exit code 0; a subprocess test (`test/fixtures/abort-exit.ts` under tsx) pins it.
  A subagent child gets half its parent's grace, otherwise a child waiting as long as its parent
  always finished after the parent gave up on it. The subagent tool now aborts a child spawned
  into an already-aborted signal (a listener added to an aborted signal never fires; the child ran
  its whole budget). The record names what was orphaned (`tool <name>` or `compaction`).
- Costs to know: aborting a tool that ignores its signal, or a hung compaction call, now takes up
  to the grace (1s) and records one non-fatal `error`; the bash tool honours its signal, so a
  Ctrl-C on a normal command still lands in milliseconds. A tool orphaned by the abort can still
  emit during the grace, so its events (a `file.changed`, a `subagent.end`) land after `turn.end`
  and before `session.end` — more faithful than dropping them, and the supervisor's detectors do
  not count `error` events, so the record cannot escalate a normal abort.

## Deviation gate and repair-round change (skills)

The first `/topic R2` run landed R2a and halted on R2b. Two things went wrong in the halt and both
were process, not code:

- The train rewrote its own contract. The R2b row said `docker` + `seatbelt`; the expansion listed
  "Seatbelt and Bubblewrap", the builder implemented that and edited the roadmap row to match,
  calling the original a "superseded draft". Nothing on `main` had ever mentioned Bubblewrap. The
  reviewer saw the roadmap diff and did not flag it.
- The train halted on two MEDIUM findings that came with concrete fixes. The halt rule was
  severity-based; the thing worth bounding is the number of repair rounds.

Changes:

- New `arbiter` skill: a second agent with fresh context judges one proposed deviation from a
  contract (row, issue, task) and returns `VERDICT: APPROVE|REJECT` with a RECORD line naming the
  exact roadmap/issue text. Its bar: intent preserved, inside the human's authorization, reason is
  a verifiable fact, change recorded as a reviewable diff. Scope reductions and security-posture
  changes are always "needs the human".
- `dogfood` §2 deviation gate: a builder never edits the row it implements without an arbiter
  record. Standalone it spawns the arbiter itself; under `ship`/`topic` it cannot (children do not
  nest — `maxDepth` is 1 and there is no flag), so it pushes, stops, and ends its report with
  `DEVIATION REQUESTED`; the conductor arbitrates and spawns a continuation builder. PR bodies gain
  a `## Deviations` section.
- `review` §4 contract fidelity: a deviation without an arbiter record is a HIGH finding regardless
  of merit; merit is judged separately so the human sees both.
- `topic`: rows are copied verbatim from `origin/main` at expansion and quoted to children; one
  arbitration per row; the repair round now covers LOW and MEDIUM findings that carry a concrete
  fix, while HIGH, design/contract/authorization findings, and unverifiable claims still halt. The
  one-round cap and "any delta finding halts" are unchanged.
- Consequence to know: under `topic`, an arbiter-approved deviation lands without the human. The
  PR body carries the verdict block so it is visible at a glance; if that is too much autonomy,
  make `DEVIATION REQUESTED` a halt instead of an arbitration.

- **#95 (partial) — a forged or host-caused "read-only file system" line classified as a
  denial.** No provider can authenticate a child's stderr, so classification is now corroborated
  against the policy: `deniedPaths(line)` reads every absolute path a denial names (quoted, then
  bare tokens, trailing punctuation stripped; relative paths never, because the command may have
  `cd`'d), and `writeDenialPlausible(line, policy)` drops a write denial only when EVERY path it
  names is inside a `workspace-write` workspace, which is writable and so could not have produced
  it (docker's "read-only file system", seatbelt's `file-write*` denials). A real denial often
  names an inside source before the outside target (`copyfile '/work/a' -> '/etc/x'`, a script
  path before a redirect target), so one outside path keeps the line. Paths are normalised
  (`..`) and canonicalised through the host's symlinks for their longest existing prefix (a link
  inside the workspace that points outside is outside to the boundary; docker binds the workspace
  at the same host path); the boundary is the directory, never its prefix. A line naming no
  absolute path keeps today's classification: corroboration narrows, never widens. What remains,
  and why #95 stays open: a forged line naming a path outside the workspace still classifies —
  the boundary's own verdict on that path, since the sandbox would deny the write, and the
  escalation prompt (which yolo never auto-answers: it goes to `onAsk`, denied headless) shows the
  provenance label — and the provider-controlled signal the issue asks for needs a boundary
  redesign. Mutants killed: docker ignoring the corroboration; a prefix sibling counting as
  inside; no `..` normalisation; seatbelt ignoring the corroboration; first-path-only; no symlink
  canonicalisation; trailing punctuation kept; relative quoted paths corroborated.
- Second delta round on the same: a relative path is now *unknown* rather than ignored, so a line
  naming an inside absolute source and a relative outside target (`mv '/work/a' '../../etc/x'`,
  a `$0`-prefixed script with a relative redirect) is kept; the canonical walk is one pass over
  the components, refuses tokens longer than any filesystem accepts, and the classifier reads at
  most sixteen paths per line and two hundred lines per stderr, so a child cannot make the
  synchronous scan expensive; a dangling link inside the workspace is followed to its target
  (`lstat`, then `readlink`); docker canonicalises only strings already inside the workspace,
  because a host link from outside into the bind does not exist in the container (seatbelt,
  host-native, canonicalises both ways); quote characters bound bare tokens so an unbalanced
  apostrophe (`can't`) cannot hide a quoted path. Mutants killed: relative treated as inside;
  dangling link not followed; docker canonicalising outside strings; quote and arrow boundaries
  dropped; last-path-only; no line bound; bare tokens inside a taken quoted span. Not killable by
  test: the length cap (the one-pass walk is already fast; the cap is defence in depth).
- Third delta round found that "one pass" still meant one throwing `lstat` per component — a
  child printing sixteen 4KB paths per line froze the process for a second per line, minutes
  per stderr. The deepest existing prefix is now found by binary search with a non-throwing
  stat (eleven probes for two thousand components); the classifier reads the head and tail of
  stderr (64KB each, `classifiable`) and spends corroboration on at most fifty matching lines —
  a matching line past that budget is kept as a denial, uncorroborated, so a genuine late denial
  after chatty output is still classified and a forger past the budget gets at worst a prompt.
  Symlink chains resolve again (`realpath` on the existing prefix first, then a dangling link's
  target through the same walk with a hop budget), and an unprefixed relative operand (`sh:
  line 5: hosts: Read-only file system`, a quoted bare word) is unknown, keeping the line.
  Mutants killed: linear probing (timing); one hop only; no operand pass; no corroboration
  budget; no byte bound; quoted bare words gated again. Not observable: `realpath`-first on an
  existing link (the hop-by-hop path reaches the same target).
- Fourth delta round: the probe count was bounded but each probe and the final `realpath` cost
  one syscall per EXISTING component, so a child that built a two-thousand-level tree inside
  the workspace made each classification a three-minute block. The walk now judges a path deeper
  than sixty-four components by its string (drop-only), uses the native `realpath`, and a test
  builds a real seven-hundred-level tree and bounds fifty lines of sixteen leaves. Past the
  fifty-line corroboration budget a matching line is judged by string alone rather than kept,
  so printing a forged inside line fifty-one times no longer buys a prompt; identical lines are
  folded first; a late genuine outside denial is still kept. The head/tail cut of a huge stderr
  lands on line boundaries so no denial line is split into an inside-only fragment. ENOTDIR
  and ENAMETOOLONG probes are pinned as absent, not thrown. Mutants killed: no depth cap
  (timing); past-budget lines kept; no catch around the probe; cut not line-aligned.
- Fifth delta round: the per-axis caps each bound one dimension and a child could still buy
  their product — a forty-hop dangling chain whose every target is sixty directories deep cost a
  `realpath` per hop, each re-walking the remaining chain, a hundred seconds per classification.
  The structural fix: one syscall budget per classification (`probeBudget`, two thousand
  filesystem calls across every line and path), threaded from `firstDenialLine` through
  `writeDenialPlausible` into the walk; once spent, the rest of the stderr is judged by string.
  A dangling chain is now followed with one `readlink` per hop and resolved once at its end, and
  a `realpath` failure other than ENOENT (ELOOP, ENOTDIR) is judged by string because a write
  there fails with that errno, not EROFS. The string judgement tests membership against both
  forms of the workspace (literal and real), so a symlinked `policy.cwd` cannot make it keep a
  line. The deep-tree fixture is three hundred levels (macOS PATH_MAX is 1024). Mutants killed:
  a `realpath` per hop (timing); the workspace in one form only; probes not budgeted.
- Sixth delta round: the budget counted calls, not cost — one platform `realpath` over an
  EXISTING forty-hop chain whose targets were long `w/../` walks made the kernel do thirty
  thousand readlinks for one budget unit. The platform `realpath` is gone from the child-path
  walk: every component is one memoised `lstat` (plus one `readlink` for a link), charged to
  the budget; a link restarts the walk on its target with the rest re-joined, up to the hop
  budget; the memo makes a chain cost its distinct paths rather than its hops times its depth,
  and the sixteen leaves of one line share their prefixes. A path the walk cannot finish
  (budget, hops, caps, a component the filesystem rejects) is judged by string. The chain
  fixture is forty levels and twenty hops, under the sixty-four-component cap with macOS's
  seven-component tmpdir and under its thirty-two-link resolution limit — past either, a write
  fails with ELOOP or is judged by string, and the test says so. The walk takes the path as
  written: a `..` after a symlink climbs from the link's target, as the kernel does (`out/../x`
  with `out -> /outside` is `/x`), where a lexical collapse had judged it inside. Mutants
  killed: no memo; probes not charged; a lexical `..` collapse. Not observable within the
  platform limits: a platform `realpath` per link (a chain short enough to resolve on macOS is
  also cheap for the kernel).
- Seventh delta round: with the memo warm a probe cost nothing, so a chain ending inside the
  workspace was walked for free, restart after restart — eighteen seconds of pure string work
  inside the budget. Every step of the walk now costs one unit, memo hit and `..` included, so
  the budget bounds the work itself (four thousand steps, tens of milliseconds); the memo saves
  syscalls only. A relative link target inside the workspace is pinned as resolving inside.
  Mutants killed: memo hits free; relative target base ignored. A free `..` is not observable:
  every restart costs a charged link probe, so dots alone cannot walk far.
- Eighth delta round: two regexes ran before the budget and backtracked — the trailing-punctuation
  strip (`/[:.,;]+$/`, four seconds on a token of sixty thousand colons) is now a scan from the
  end, and the seatbelt matcher (`sandbox…deny` with `.*`, backtracking from every `sandbox` on
  a line that never says `deny`) is gated by the cheap literal first. A budget that dies on a
  `..` is pinned to keep the `..` in the string it hands back. Mutants killed: the regex strip
  restored (timing); the seatbelt gate removed (timing); the `..` dropped from the dying return.
## Open-issue sweep (2026-09-03)

- **#88 — `session_end` hooks never ran for an aborted session.** The point ran under the
  session's own signal, which an abort has fired by definition, and `runHooks` skips a point whose
  signal is already aborted; so the ingest and dream trigger that hang off `session_end` never saw
  a cut-off session. `session_end` now runs under its own controller; the abort reason still
  reaches hooks as `summary.reason`. A second abort once the session is ending aborts that
  controller too, so ctrl-C twice means "stop waiting" rather than "run ingest for fifteen
  minutes". Tests: an aborted session's `session_end` hook runs with reason `aborted` and a live
  signal; a second abort stops a hook that would otherwise wait out its budget; a session abort
  still stops a hanging `pre_tool` hook. Mutants killed: the session's signal for the point;
  ignoring the second abort; every point under the end signal.
- Children (review finding): the parent's signal fires once, and that once is the child's first
  abort, so a child's `session_end` hooks could outlive the parent's grace with nothing able to
  stop them. The subagent tool now cuts them with a second abort at 1.5× the child's grace —
  the child may first spend its whole grace waiting for a tool that ignores the abort, and its
  hooks still get half a grace after that, ending before the parent's own grace (2×) expires;
  armed at the child's grace, a child mid-tool at abort ran no end hooks at all — and forwards
  the parent's own second abort through a new optional `ToolContext.endSignal` (a field added,
  never repurposed) so ctrl-C twice reaches the child's hooks too. The CLI's children carry no
  hooks today, so this binds SDK embedders; CLI children still leave no ingest behind
  (unchanged, noted). A grandchild's grace now derives from its parent's (the nested tool's
  `childConfig` carries the child's halved grace), where it used to read the root config and
  get the same grace as its parent, so its cut landed after the child had stopped waiting. The
  tests set the parent's real grace and assert it never reports the child as still running, and
  that the stubborn-tool case really spent the child's grace (its own log carries the orphan
  note). Mutants killed: no grace cut; second abort not forwarded; cut at the child's grace; cut
  at the parent's deadline; grandchild reading the root grace.
- Both entry points say what each abort does: "aborting… (abort again to skip session_end
  hooks)" then "skipping session_end hooks" — the first promises nothing about the hooks, because
  a session that had already finished its turn and was in its hooks is cut by the first abort
  and the controller cannot tell that case from a mid-turn abort. The TUI keeps answering SIGINT
  until shutdown has finished (it used to remove the handler first, so a ctrl-C during the hooks
  went to Node's default handler and killed the process mid-hook with no `session.end`) and says
  so on stderr, since the frame is gone by then; headless `run` prints the same two lines. Both
  read `abortNotice(nth, key)`, tested; the SIGINT wiring itself is code-read only.
- Semantics, stated: an abort that lands while the session is already ending (a normally
  finished session in its end hooks) counts as the second abort and stops them — that is what a
  person pressing ctrl-C during a long ingest means.
- **#100 — the malformed-injection test could not tell "ignored" from "injected an empty
  message".** It now pins the exact provider conversation (the task alone), the exact appended
  messages (the reply alone), and the snapshot and materialized lists. Mutant killed: reporting
  the error and then injecting `""`.
- **#104 — a forged spawn record naming a deeper session was undecidable.** `session.start`
  gains an optional `parent` (schema-added, never repurposed); the subagent tool passes
  `parent: ctx.sessionId` into the child's `run`, so a child's own log names its parent.
  `liveChildren` now accepts a spawn record only if the named session's log does not dispute it:
  a `session.start` naming a different parent belongs to that parent, whatever the record says. A
  missing log (starting) or one written before the field cannot testify and is accepted, so old
  logs keep rendering. `renderEvent` prints the parent. Mutants killed: dropping the dispute
  check; not recording the parent.
- **#96 — child abort grace floored to 0; the clamp lived twice.** `abortGraceOf(config)` is the
  one clamp (finite, non-negative, else 1000ms), used by the loop and the subagent tool; a child
  gets `max(1, floor(parent / 2))`. Mutant killed: dropping the floor.

## R3 notes

| Row | Deliverable | Status |
|---|---|---|
| R3a | `session.fork` event, append-only child creation, and recursive event/message materialization | done |
| R3b | Session fork/search CLI and bounded replay | done |
| R3c | TUI `/fork` and `/tree` | done |
| R3d | Live `/children` tree | done |

- R3a adds `SessionStore.fork(parent, atSeq)`: the child log contains only its seq-0
  `session.fork` record, while the parent log and existing snapshot behavior remain untouched.
  Fork points address the named parent's physical log, so recursive materialization naturally
  supports forks of forks without flattening or copying ancestry.
- `SessionStore.materialize` returns inherited recorded events followed by the child's records;
  `materializeMessages` folds that stream into provider-neutral messages. Additive `message.append`
  records preserve the exact assistant/tool-result boundaries used by the model, and
  `context.compact.messages` preserves authoritative post-compaction state. Historical logs retain
  the original event fold. Recorded tool results and both `modify`/`inject` patches replay directly;
  tools are never looked up or executed during replay.
- Fork child ids are reserved with exclusive on-disk creation. Reopened stores retry collisions
  without changing the existing log, preventing a second seq-0 record from entering another session.
- Acceptance coverage diffs parent/child message lists at the fork point, follows two levels of
  ancestry, hashes the parent file across child creation, rejects nonexistent fork points before a
  child is written, compares a real parallel-tool plus compaction run to its stored message state,
  preserves colliding files byte-for-byte, covers both patch modes, and uses a counter tool fixture
  to prove materialization does not repeat effects. No roadmap deviation was needed.
- R3b adds `sessions fork <id> [--at <seq>]`, defaulting to the final event in the parent's own
  physical log; `sessions replay <id> [--until <seq>]`, which renders the side-effect-free
  materialized tree; and `sessions search <query>`, which runs the memory package's existing BM25
  scorer over those same rendered materialized transcripts. Sequence options reject non-negative
  integer violations at argument parsing, and no scorer move or dependency-boundary change was
  needed.
- R3c adds `/fork [seq]` and `/tree` to the TUI. `/fork` writes a child log holding only its
  `session.fork` marker and switches the conversation to the child; the next prompt resumes the
  child, so the parent's log never gains a byte (the controller test hashes it across the fork and
  the child's first turn). `/tree` prints the root-to-current ancestry and every fork under the
  root. Discovery is `SessionStore.tree(id)` in core (the CLI keeps only the renderer, which R3d
  will drive with live state): the parent records nothing about its forks because it is never
  written, so children are found by reading the first event of every log in the store. A log
  that does not parse is skipped and named under `unreadable`, never fatal — one stray file must
  not take `/tree` away from every healthy session — while the named session and its ancestors
  must parse. Cycles terminate: a marker naming itself is nobody's child, and two markers naming
  each other render once. Both commands are injected into the controller like `/memory` and
  `/dream`, so it stays free of stores; the TUI wires them to a `SessionStore` on the agent's root.
- Decision beyond the row, in core: a fork child had no snapshot until it completed a turn, so
  `sessions fork` produced an id that could be replayed but never continued — `run --resume
  <child>` died with "no snapshot found", and `/fork` would have too. Resume now falls back to
  `SessionStore.materializeSnapshot(id)`, which exists only for logs opening with `session.fork`
  and folds the materialized tree into a snapshot (messages, the latest task and cwd from
  `session.start`/`session.resume`, turns from the last `turn.end`, usage summed over
  `model.response`; a test compares every field against a written snapshot). Caveat: `usd` is
  the one field no event records, so a fork child resumed without explicit pricing starts its
  USD budget at zero where a written snapshot carries the parent's figure — token budgets are
  unaffected. A plain session with no snapshot is still an
  error — "died before its first turn.end" must not become "resumable from nothing" — and the
  restored messages go through the same open-tool-call synthesis a written snapshot gets, because
  a fork point can sit between a `tool.call` and its result. Nothing executes: it is the R3a
  materializer, and the call-counter fixture pins that the resumed child runs no recorded tool
  again. Mutants killed: dropping the fallback, dropping the tail synthesis, widening the
  fallback to non-forks, not switching the TUI session, allowing `/fork` mid-turn, dropping the
  cycle guard, keeping a self-parent as a child, making an unreadable log fatal, taking the first
  task instead of the latest, not marking the fork resumable.
- Skills: the land skill now checks the completed row carries `*(done)*` (the LOW #101's delta
  review found, made a precondition rather than a memory).
- R3d adds `/children`. The controller records which children exist from the parent's own
  stream (`subagent.spawn` gives the id and label, `subagent.end` the reason); everything else —
  the turn it is on, the tool it is in, the plan item in progress, when it started and ended, the
  children it spawned itself — is read from each child's own log by `liveChildren` in core, which
  folds the log with `summarizeSession` and follows the child's own spawn records to
  grandchildren, visited once. Nothing is written and nothing is copied into the parent's log
  (the test compares the parent's byte count across `/children`). One line per child: `id ·
  label · turn N · <tool> <since> · plan: <item> · <elapsed>`; a finished child shows the
  parent's `subagent.end` reason and its duration; a child with no log yet is "starting"; a log
  torn mid-line (the child is still writing it) is reported on that line rather than failing the
  command. Nested children render as an indented tree through the same `renderTreeLines` that
  `/tree` uses.
- Decision beyond the row: `/children` reads the logs when invoked rather than repainting on a
  timer. Every invocation is a fresh read of the source of truth, so what it prints is the state
  at that moment; a self-refreshing block would need the live frame to hold N growing lines,
  which the viewport design (`viewport.ts`) budgets against, and the scrollback is `Static`. A
  timer-driven view is a follow-up if dogfooding asks for it.
- Review fixes, each pinned: a `tool.result` closes the open call (a child thinking after `bash`
  is not "in bash"); `/children` has no running-turn guard, and a test invokes it while the child
  is blocked inside a tool; a torn last line — a child mid-write — keeps every line before it and
  is flagged "log still being written" (`SessionStore.readPrefix`), while a corrupt terminated
  line or a seq gap is still an error; `/resume <other>` drops the previous session's children and
  seeds the list from that session's own log (`onSpawned`), or starts empty when nothing is
  wired; a child log whose spawn record names the parent or a sibling cannot pull that session
  under itself — the walk is breadth-first and every id found at one depth is claimed across
  all branches before the next depth is read, so a record cannot steal a session of the same or
  a shallower depth from another branch either; a record naming a session that truly belongs
  strictly deeper in another branch is undecidable from child logs alone (residual issue, see
  the PR) — and an id that is not a session id renders as "invalid id"; every `subagent.end` reason the log can carry is
  recorded, "ended" when it carries none (`applyChildEvent`, exported and tested directly).
- Mutants killed: a session that ended still "in" its last tool; a `tool.result` leaving the
  call open; dropping the visited guard on looping spawn records; a torn tail throwing; no
  up-front claims for parent and siblings; throwing on an unreadable child log; not recording
  `subagent.end`; a hard-coded end reason; a resume keeping the previous session's children; a
  running-turn guard on `/children`; preferring the child's own end reason over the parent's.

## R3.5 notes

| Row | Deliverable | Status |
|---|---|---|
| R3.5a | Named provider entries, per-role selection, `reasoningEffort`, doctor coverage | done |
| R3.5b | Train review via `claude -p` + `codex review` | done |

- R3.5a keeps one instance per entry: two roles on `cloud` share one object, exactly as every
  role shared one before. Roles are constructed eagerly so a missing credential fails the run
  before a session starts; `get(name)` builds spawn-only entries on first use.
- Typed `--provider`/`--model`/`--base-url` (or `AGENTRIG_MODEL`) pin only `main` to the flat
  default entry; `modelExplicit` was not reusable for this because it is also true when config
  sets `model`.
- `memory ingest` and `dream` construct only the role they use, via a new
  `buildRoleProvider(opts, role)` in `packages/cli/src/provider.ts`, rather than the full eager
  `buildProviders` set — otherwise a dream failed on a credential some unrelated role needed.
  Typed provider flags still pin them to the flat default entry (`main` under `providerOverride`).
- Doctor's `providers:roles` table derives `providerOverride` from the same four-way rule as
  `loadRunConfig` (typed `--provider`/`--model`/`--base-url` or `AGENTRIG_MODEL`), so it shows
  what `run` would resolve, not only the env-var case.
- R3.5b moves the train's review out of subagents entirely: `topic` §2 step 4 runs `claude -p`
  (pinned `claude-opus-5`, asserted from `modelUsage`) and `codex review --base review-base-NN` in
  parallel in one conductor-made worktree, on the full review and on every delta; reviews are
  posted as PR comments and replace reviewer session ids in reports. The arbiter is spawned on
  the main entry. Preflight child counts drop from three to two per row.
- Deliberate deviation from spec §6, found by the R3.5b dry run against PR #109: §6 called for
  `codex review --base <branch>` with "a prompt carrying the same adversarial standard" as
  Claude's. `codex review` on the installed CLI (0.153.2) rejects `--base <BRANCH>` combined with
  a `[PROMPT]` positional argument (`error: the argument '--base <BRANCH>' cannot be used with
  '[PROMPT]'`, confirmed with `--help` and by swapping argument order). The Codex job therefore
  runs `codex review --base review-base-NN` with no custom prompt; Codex's own review mode carries
  its own instructions, and the adversarial standard is enforced by Claude's brief plus step 5's
  finding-sorting rule, where a Codex finding without a proposed fix is still repair work.
- Codex names no SHA in its own output; its provenance rests on the PR-comment heading (which
  records `HEAD`) plus the pre-merge assertion that the worktree was at `HEAD` before
  `origin/main` was merged in.
- Observed dry-run cost against PR #109 (one file changed): the Claude leg cost $3.76 and took
  13 minutes; the Codex leg took roughly 25 minutes — long enough that the final-review fix wave
  raised the dead-job timeout in `topic` §2 step 4 from 45 to 60 minutes.
- The dry run ran under Claude Code itself, so `bash_job` polling of the two backgrounded review
  jobs from inside AgentRig's own `bash`/`bash_job` tools is the one part of the pass the dry run
  did not exercise; the first real train verifies it.

## R2 notes

| Row | Deliverable | Status |
|---|---|---|
| R2a | Core `SandboxProvider` execution seam, three sandbox modes, and `sandbox.denied` event | done |
| R2b | Concrete no-op, Docker, and macOS Seatbelt providers | done |
| R2c | Sandbox-denial escalation with one approved unsandboxed retry and distinct TUI prompt | done |
| R2d | CLI/config sandbox selection, composed `--yolo` guidance, Docker fixture CI, and Windows no-op CI | done |

- R2d adds `--sandbox read-only|workspace-write|none` and the matching validated config key to both
  agent entry points. Linux selects Docker, macOS selects Seatbelt, and `none` selects the explicit
  identity provider on every host; unsupported enforcing modes fail closed. Parent and subagent
  configurations carry the same boundary independently of their shared approval policy.
- The `--yolo` warning now distinguishes an absent boundary from an active sandbox and explicitly
  recommends skipping approvals inside `workspace-write` for unattended runs. Boundary escalation
  remains a separate explicit prompt even when ordinary approvals are skipped.
- CI pre-pulls `alpine:3.20` on Ubuntu so the network-free Docker integration test runs live. A
  Windows job builds and typechecks all packages, then runs the focused `sandbox=none` identity-seam
  proof; it does not misrepresent POSIX-only process integration tests as Windows coverage. The local
  Docker test still skips loudly when Docker or the pre-existing fixture is absent.
- R2d's focused wiring/config/warning tests passed, the existing fake-provider outside-cwd acceptance
  and single-retry tests passed, and a mutant permitting a second unsandboxed retry was killed by the
  cap test. No Landlock is introduced in R2.
- R2d dogfood token usage is unavailable in this API-runner session rather than fabricated.

- R2c turns an explicit provider `SandboxDeniedError` into a second-axis permission request with
  `origin: "sandbox-escalation"`. Core records the denial, asks explicitly, and on approval invokes
  the original validated command outside the provider exactly once; denial retains the failed tool
  result. A provider-shaped failure from the unsandboxed retry is an ordinary tool failure and cannot
  reopen the prompt, pinning the single-retry cap.
- TUI sandbox escalation says “blocked by sandbox — run outside it?” and offers only a one-call grant.
  Standing allow/deny answers for the tool neither answer this prompt nor get replaced by its answer,
  preserving sandbox and ordinary permission as independent axes. Headless runs have no `onAsk`, so
  escalation fails closed. No Landlock is introduced in R2.
- Acceptance coverage uses a fake model and sandbox to attempt an actual write outside the run cwd,
  observes `sandbox.denied` and the escalation request, approves it, and verifies the outside file and
  successful retry. A second-denial mutant is pinned to one prompt and one unsandboxed execution. The
  R2b Docker prerequisite gate and Seatbelt profile-shape tests remain the provider acceptance seams.
- R2c dogfood token usage is unavailable in this API-runner session rather than fabricated.

- R2b adds an explicit identity provider while keeping omitted sandbox configuration equivalent to
  today's behavior. Docker runs process tools with a read-only root, a cwd bind that follows the
  selected filesystem mode, and `--network none` unless network is separately granted. Seatbelt's
  generated deny-default profile permits reads/processes, scopes writes to cwd only in
  `workspace-write`, and denies network unless separately granted.
- Foreground and background shell launches consult the active provider at the process boundary.
  Backend-specific denial text is converted to `SandboxDeniedError`; ordinary non-zero command
  exits retain their existing tool-result behavior. Docker's live integration test first requires
  `docker info` and a local fixture image, prints a prominent reason, and skips rather than failing
  when either prerequisite is absent; it never pulls during the test. Seatbelt profile shape is
  tested without requiring nested macOS sandbox support.
- R2b does not add selection flags/config or the outside-sandbox retry path: those remain R2d and
  R2c respectively. No Landlock or substitute Linux-native backend was added.
- Deviation, arbitrated and recorded (see PR #90 `## Deviations`): the docker integration test is
  gated behind `docker info` *and* a locally present fixture image, never pulling, because tests
  are network-free and `docker run` would implicitly pull; R2d's CI pre-pull makes the live test
  run on the ubuntu leg. The R2 acceptance text carries the arbiter's RECORD line.
- Skill change riding along (attended PR, human-visible): dogfood §8's "record, never fix" cap
  now bounds review rounds, not fixes — a LOW the delta reviewer finds may be fixed post-delta
  with a fail-first test and a killed mutant, labelled "post-delta, self-verified, not
  re-reviewed" in the PR body; MEDIUM and above stay record-only; `topic` stays record-only
  because nobody reads a label on an unattended train. `ship` mirrors it.
- Review repairs: no provider can authenticate a child's stderr, so classification is narrowed to
  what the active policy would produce — generic "operation not permitted" is never a denial, and
  "network is unreachable" only counts when the policy denies network — and the denial reason is
  labelled as the command's own unauthenticated words, so the R2c escalation prompt cannot present
  child output as the sandbox speaking. Background jobs classify from a retained tail of
  everything the job wrote, not from the last poll's drain, so a denial printed early and drained
  by an intermediate `bash_job` status is still reported at exit, once.
- Post-delta-review fixes (self-verified with fail-first tests and mutants, not re-reviewed by a
  second agent — the human saw that label at merge): classification runs before the poll drains,
  so the poll that reports a denial no longer swallows the output that arrived with it; the
  registry retains the job's first 4 KiB as well as its last, so a denial ahead of a long log is
  still classified; seatbelt drops a network denial under a network grant, matching docker. Not
  fixed, inherent: a forged or ambiguous "read-only file system" line under `workspace-write`
  still classifies — the provenance label is the mitigation, and R2c must keep it in the prompt.

- R2a models a sandbox command as a deferred tool execution. After ordinary permission approval,
  core passes that command and `{ mode, cwd }` policy to the configured provider and executes the
  returned wrapper. A denied permission never reaches `SandboxProvider.prepare`, keeping approval
  and OS isolation independent rather than letting either layer stand in for the other.
- Providers identify an OS-enforced block by throwing `SandboxDeniedError`. Core then appends a
  bounded `sandbox.denied` record (tool id/name, active mode, and reason) before the ordinary failed
  `tool.result`; unrelated tool exceptions retain their existing behavior and are not mislabeled.
- Sandbox configuration is optional in R2a, preserving today's execution when no provider is wired.
  The `none` mode still traverses a configured provider seam. Concrete no-op, Docker, and seatbelt
  providers remain R2b; escalation/retry remains R2c; CLI/config wiring remains R2d.
- Rejected: infer sandbox denial from generic `EACCES`/`EPERM` tool exceptions. Host filesystem
  permissions can produce those without a sandbox, so only the boundary provider can classify the
  failure honestly. Also rejected: invoking the sandbox before permission policy, which would make
  denied calls enter an execution layer despite never being approved.
- Caveat: R2a establishes and tests the boundary but supplies no enforcing provider, so unattended
  runs remain unsandboxed until the later R2 rows land.

## R1 notes

| Row | Deliverable | Status |
|---|---|---|
| R1a | `AGENTS.md` discovery and system-prompt injection, with `CLAUDE.md` alias and `context.loaded` event | done |
| R1b | Zod-validated user/project config, named profiles, and explicit-source precedence shared by `run` and the TUI | done |
| R1c | TTY-scoped bracketed-paste mode with streaming marker decoding in the quiet-point input path | done |
| R1d | Realpath-keyed, fail-closed consent gate for project instructions and config, shared by run and TUI | done |
| R1e | Read-only `agentrig doctor` with actionable local diagnostics and scriptable exit status | done |

### Post-R1 TUI refinements

- Issue #55 adds a statusline working indicator derived entirely from the controller's live event
  stream: model requests show wall-clock `thinking Ns` until first output, and tool calls show the
  tool name (plus a bounded one-line command prefix for bash) until the matching result. A 1 Hz view
  clock updates elapsed time without adding core events. Its writes are suspended while bracketed
  paste framing is open or partial and coalesced into the existing quiet-point draw after completion.

- R1e ships the complete local checklist: effective provider credentials (environment presence or
  readable ChatGPT token source and expiry/time remaining), user/project config validity, active
  profile and provider/model precedence sources, trusted/untrusted/undecided project state, writable
  memory plus readable wiki index, MCP config plus command-on-PATH checks, informational Git branch/
  detached state, and stdin/stdout TTY capability. Every failure names a corrective command, setting,
  path, or permission repair; any failure exits non-zero, while informational skips do not.
- Doctor never prompts, writes, refreshes a token, or opens an untrusted project's config. Its
  filesystem, environment, clock, command lookup, project-boundary, and Git probes are injectable, so
  tests use no host credentials, HOME, PATH, or repository state. MCP protocol handshakes were
  deliberately left out: R1e diagnoses configuration and executable availability, and the roadmap
  explicitly does not require speaking the protocol.
- Rejected idea for R1e: instantiate `OpenAIChatGPTAuth` and ask it for current credentials. Its normal
  read path may seed the token file from the environment and its use path may proactively refresh and
  persist rotation, violating doctor's read-only guarantee. Doctor instead parses a snapshot through
  read-only probes and reports only source/presence/expiry, never token bytes or parser source context.
- R1e dogfood token measurement: the interrupted implementation attempt used **271,083 input tokens
  over 30 turns**. This resumed API-runner session exposes no provider usage telemetry, so its
  additional token count is unavailable rather than fabricated. Add 271,083 plus this unavailable
  continuation beside the **1,718,936 / 669,418 / 3.3M / 4.0M** existing baselines.

- R1d stores interactive allow and decline decisions in `~/.agentrig/trust.json`, keyed by the
  project's canonical `realpath`; aliases and descendant working directories therefore share the
  same boundary. Core independently requires the run cwd to be at or below that canonical root and
  bounds instruction discovery there, while CLI resolves consent before opening project config.
  If a repository is the home directory or contains it, `~/.agentrig` is also repo-controlled, so
  user config and persisted trust are ignored and only invocation-scoped `--trust` can opt in.
- `--trust` applies only to the current invocation and is not persisted. This is deliberately the
  least-ambient interpretation: CI or a one-off automation command may opt into a reviewed checkout
  without silently granting all later interactive sessions permission to load that checkout.
- Missing trust state is untrusted. Malformed or unreadable `trust.json` warns and behaves as an empty
  trust store; headless run, headless TUI, and resume never prompt and visibly skip both project
  instruction names and project config unless a prior allow or `--trust` applies. A recorded decline
  is also visible and is not prompted again.
- Rejected idea for R1d: place consent in project `.agentrig/` beside config. That file would be under
  control of the freshly cloned repository whose claims are being evaluated, allowing the project to
  mark itself trusted. Consent therefore lives only in the user's home-level AgentRig state.
- R1d dogfood token measurement: this API-runner session exposes no provider usage telemetry, so its
  exact token count is unavailable rather than fabricated; add this unavailable point beside the
  **1,718,936 / 669,418 / 3.3M / 4.0M** existing baselines.

- R1c holds any suffix that is still a possible `ESC[200~` or `ESC[201~` marker (including a bare
  `ESC`) across raw stdin chunks. When later bytes complete it, the marker is stripped; when they
  disprove it, the held bytes are released to Ink's ordinary key path, preserving fallback behavior.
  Drawing is suspended without a deadline while paste mode or a partial marker remains open, then
  one draw and any queued submit are released through the existing stdin quiet point.
- An unmatched `ESC[201~` is treated as protocol framing and stripped while remaining outside paste
  mode. This prevents a damaged or duplicated terminal wrapper from leaking marker bytes into the
  prompt. A `201~` sequence inside pasted payload necessarily closes the paste, as defined by the
  terminal protocol.
- Rejected idea for R1c: replace Ink's input handling with a new raw-stdin key parser. That would make
  bracketed-paste support reproduce every existing key and burst heuristic. The implemented side
  channel retains each exact raw chunk for marker decoding while Ink still supplies ordinary key
  semantics, so terminals that ignore `?2004h` keep the old path.
- R1c dogfood token measurement: this API-runner session exposes no provider usage telemetry, so its
  exact token count is unavailable rather than fabricated; record this as the next unavailable point
  beside the **1,718,936 / 669,418 / 3.3M / 4.0M** existing baselines.

- R1b precedence is **CLI > environment > project config > user config > built-in defaults**. The
  only existing non-credential `AGENTRIG_*` setting is `AGENTRIG_MODEL`; credential environment
  variables remain provider/login concerns and can never be represented in config.
- Config merge is shallow by setting. In particular, `allow`, `deny`, drift-contract/scope, skills,
  and every other array replace the lower-precedence array rather than append to it. Appending can
  silently retain a user-level permission that a project intended to narrow, while replacement makes
  the effective policy locally legible. A selected profile overlays its own file's top level before
  the next file-precedence layer is applied. Relative path settings retain CLI semantics and resolve
  from the invocation cwd (the project root), not from whichever user/project config file supplied
  them; this keeps the same resolved value on `run` and TUI paths and makes a user default portable
  across projects.
- Rejected idea for R1b: infer whether a CLI option was explicit by comparing its value to the
  Commander default. A user may intentionally type the default value, so comparison loses source
  information; `getOptionValueSource` instead determines which values enter the CLI overlay.
- R1b dogfood token measurement: this API-runner session did not expose provider usage telemetry, so
  an exact token count could not be recorded without inventing one. This missing first post-eviction
  data point is noted explicitly beside the 1.7M/4.0M baselines rather than reported as a false value.

- R1a walks upward from the session cwd, prefers a regular `AGENTS.md` over its alias (directories
  and symlinks are not instruction files), preserves the file body verbatim between explicit
  system-prompt delimiters, and records the absolute path and file byte count without copying the
  body into the event stream or conversation messages.
- Considered Gemini CLI's trusted-project boundary from the studied harnesses, but deliberately did
  not implement it: the roadmap assigns trust and consent persistence to R1d, and pulling it into
  R1a would expand this row beyond discovery and injection.
- External-review stall measurement: no supervisor stall warning occurred during the external-review
  phase.

## R1.5 notes

| Row | Deliverable | Status |
|---|---|---|
| R1.5a | Outbound-view eviction of stale, large tool results with `context.evicted` accounting | done |
| R1.5b | Discounted cache-read budget accounting and cached-token usage displays | done |
| R1.5c | Mode-split turn defaults and fixed turns-remaining soft-warning threshold (issue #54) | done |
| R1.5d | Per-turn prompt bill of materials with hashes, provenance, freshness, and TUI `/context` | done |
| R1.5e | Budgeted mechanical repository map with mtime refresh, context accounting, and opt-out | done |
| R1.5f | Immutable-log overflow artifacts with bounded `read_output` range reads | done |

- R1.5b completes the cached-token path that already populated and accumulated the disjoint
  `Usage.cacheRead` field. Hard token budgets now count uncached input, cache reads, cache writes,
  and output exactly once. USD budgets charge cache reads at the provider-advertised input-price
  fraction (Anthropic reads 0.1 and writes 1.25; official OpenAI/openai-chatgpt reads use a
  model-family fallback of 0.1, 0.25, or 0.5), and conservatively use full input price when no
  provider/model discount is known. Explicit `--price-cache-read` / `--price-cache-write` rates
  override those defaults. The same accounting is used in the supervisor's soft limits, when
  reconciling bounded subagent pools, and when deciding compaction from reported usage.
- Human-facing headless, TUI, and event-trace usage lines show total input and identify a nonzero
  cache-read and cache-write subsets, for example `3.3M in (2.9M cached) / 12.3k out` and
  `182k in (180k written) / 500 out`; JSON remains schema-compatible and trace fields stay
  machine-readable (`in=`, `cached=`, `cacheWrite=`, `out=`). Counts are floored to one decimal so
  summaries never overstate measured use.
- Decisions beyond the row: cache discounts are additive optional provider capability metadata, so
  existing third-party `ModelProvider` implementations remain source-compatible. Unknown discounts
  deliberately fall back to full price rather than silently under-enforcing a USD budget. Cache
  writes are labelled separately because they are charged writes, not discounted reads. Tests pin
  both sides of discounted USD pricing (neither full-price nor free), explicit-rate overrides,
  exact-once hard and soft token-budget accounting, provider metadata, and compact displays.

- R1.5d emits `context.manifest` immediately before every model request, after outbound eviction,
  repository-map refresh, and `pre_model` hook patches. Each rendered system/history/tool-result/tool
  catalogue block records source, origin, instruction-vs-data authority, a 16-hex SHA-256 content hash,
  load reason, UTF-8 bytes, a conservative bytes/4 token estimate, kept-vs-evicted disposition, and
  freshness where applicable; the event also hashes the complete unified request. Bodies remain only
  in the outbound request, never the immutable JSONL log. The exact `context.repo_map.freshness` marker
  is threaded into the corresponding manifest block rather than recomputed. CLI assembly labels base
  instructions, skills catalogue, and memory index separately; trusted project instructions and repo
  maps are labelled in core. TUI `/context` renders the latest manifest.
- Compactness measurement: a representative first-turn manifest with base prompt, skills, memory,
  an 8 KiB repo map, one user-history block, and two tool schemas serializes to **1,338 bytes** including
  the event envelope. Prompt body size does not affect that cost; each later history/tool-result block
  adds one metadata record rather than duplicating content.

- R1.5f turns display overflow into a self-describing artifact without adding a second mutable store.
  `tool.result` gained additive `output` and `truncated` fields: only a result whose display actually
  overflowed carries its complete textual rendering, and the event's existing `seq` is the handle.
  The model-facing prefix remains within the 30,000-code-unit display cap after the handle is appended,
  carries an explicit complete-output cursor, and offers the immediately following range rather than a
  duplicate prefix. Non-prefix summaries/previews keep their meaning and page complete text from cursor
  zero. The distinct handle-bearing model view is recorded as a
  `tool.result.patched` event by `core:output-overflow` for replay/audit. `read_output {seq, from, to}`
  serves a zero-based, half-open range of at most 30,000 UTF-16 code units directly from the validated
  append-only session log, so hidden output can be inspected without replaying a command. Surrogate-pair
  splits are rejected with corrected offsets rather than returning malformed Unicode.
- `read_output` is registered by the core agent rather than by CLI/builtin assembly because it must
  capture the exact `SessionStore` used by the active session. Its session id comes only from
  `ToolContext`, never model input; a handle therefore cannot read another session. The name is reserved
  so caller tools cannot shadow this recovery path. It is explicitly allowed by the default policy: like
  `bash_job`, it only exposes data from an already-authorized operation in the same session and has no
  honest filesystem path with which to satisfy the generic cwd-only read rule. Tool-free agents do not
  advertise it. Reads stream the log instead of materializing every event and check aborts while scanning.
  A later replacing `post_tool` patch seals the raw artifact, so a redaction hook cannot be bypassed by
  range reads; inject-only patches carry an additive mode and leave recovery available. Hook output
  reserves bounded space for both result context and guidance rather than truncating the injection away.
  Overflow handles use one strict core marker and survive stale-result eviction. The core also applies the final display bound to
  third-party tools, thrown errors, and post-hook output, while `ToolResult.fullDisplay` plus an optional
  `displayPrefixChars` cursor lets already-bounded builtins and MCP tools preserve their own smaller caps
  and distinguish prefix previews from summaries/headers and from semantic collection caps such as grep's
  match limit. Empty/malformed `fullDisplay` values do not create artifacts.
- Rejected alternatives: serializing arbitrary structured `ToolResult.output` would not faithfully
  reproduce a tool's rendered text, and copying overflow into sidecar files would duplicate the raw log
  and create a second retention/trust boundary. A complete textual rendering is explicit at the tool
  seam instead. Caveat: ranges use JavaScript string indexing (UTF-16 code units), not UTF-8 byte offsets;
  callers should continue at the prior `to` value.
- R1.5f dogfood fixture: a 31,006-code-unit Unicode output persisted once, exposed a bounded next-page
  handle, and returned all hidden code units through `read_output`; the originating tool had exactly one
  call and the session ended `done`. Regression fixtures also pin redaction sealing, streaming reads,
  runtime and surrogate bounds, tool-free catalogues, stale-result handle preservation, core-view audit,
  thrown/hook output bounds, and malformed tool results. Mutation checks killed removal of `fullDisplay`
  persistence, replacement of the requested range with a prefix read, substitution of a different session
  id, removal of the default-policy allow rule, and both post-hook and thrown-error bounds.
- Review caveat retained deliberately: complete output is unbounded in JSONL and therefore inherits the
  size and machine-readable disclosure properties of the raw immutable session log. Capping it or hiding
  it from JSON replay would directly violate R1.5f's “full text from the raw log” contract; operators must
  protect raw logs accordingly. A future storage row may chunk append-only records atomically, but this
  row does not introduce a mutable sidecar or silently discard command output.

- R1.5e builds an 8 KiB-bounded, deterministically ordered file-and-export map with the TypeScript
  syntax parser only: no module resolution, imports, execution, LSP, or build graph. Conventional
  generated/state trees and every symlink are skipped. Function signatures and declared variable
  types are retained while function bodies and variable initializers are discarded, so orientation
  does not require whole-file reads and executable source cannot run during extraction.
- The map is appended to each outbound system prompt between conspicuous data-not-instructions
  delimiters. A per-session view compares a SHA-256 freshness marker over sorted path/size/mtime
  tuples before each turn and reparses only when that marker changes. It obeys the same canonical
  project-trust boundary as instruction files and excludes active session artifacts. Only `context.repo_map`
  accounting (bytes, file count, truncation, and freshness) enters JSONL; map content never enters
  messages or the immutable log. `--no-repo-map` and the boolean `repoMap` config key disable both
  injection and accounting for parent and subagent sessions.
- Rejected idea: persist the map in the session log and replay it on resume. The map is mutable prompt
  context, not raw history; persisting its body would inflate every replay, expose stale structure as
  current, and violate the same outbound-view boundary used by tool-result eviction.

- R1.5c keeps the interactive TUI at 50 turns but gives non-interactive `run` and `sessions resume`
  300 turns by default. A resumed session follows the entry mode doing the new work rather than
  inheriting its original cap. The split lives in Commander's per-command defaults so config,
  profiles, environment overlays, and flags keep their existing precedence; explicitness still comes
  from `getOptionValueSource`, which means a typed `--max-turns 50` remains an explicit choice even
  though 50 is also the TUI default. Three hundred was chosen over the roadmap's old 200 proposal
  because observed full-PR runs were already approaching 150 turns and user-side mitigation had
  validated 300, while raising the interactive cap would make an accidental runaway much costlier.
- R1.5c's budget warning now trips on the earlier condition of `supervisorSoft` or a fixed
  `supervisorTurnsRemaining` window (15 turns by default). The fixed window applies only to turns;
  tokens, USD, and minutes retain proportional thresholds because they have no turn-equivalent unit.
  Both conditions share the existing per-dimension one-shot latch, and the new value uses the same
  config/profile/CLI resolution path as `supervisorSoft` via `--supervisor-turns-remaining`. Resume
  events carry the cumulative completed-turn count (optional for old-log compatibility), so the
  supervisor can warn before the first new model request instead of learning the count after a
  near-cap resume has already spent its last turn.

- R1.5a was implemented before nominally-next R1b because the earlier measured work sessions cost
  3.3M and 4.0M input tokens on quadratic full-history resends. The first R1.5a session itself cost
  **1,718,936 input tokens over 43 turns** and died twice on provider overloads; the retry layer now
  on `main` addresses those transient in-stream failures. The required review continuation ran as a
  fresh session and cost **669,418 input tokens over 34 model turns** through final delivery.
- Eviction is a pure outbound request view. The live conversation, append-only session log, raw
  sources, compaction input, and resume snapshot retain full tool results; stale large results are
  replaced with pairing-preserving re-fetch stubs only in the request sent to the provider. The most
  recent five assistant turns and results whose serialized JSON payload is at or below 8 KiB remain
  verbatim by default.
- Rejected idea: replace stale results in the live `messages` array to avoid rebuilding a shallow
  request view each turn. That would make snapshots and resume lossy, feed synthetic stubs into
  compaction, and violate the event-sourced log's complete-history contract; bounded view allocation
  is the safer tradeoff.

## Supervisor ladder incident fix

Status: **done**.

- The R1a work session could not write its own ending: during final verification, four stall signals
  fired on varied `git status` / `git diff` / build-test-typecheck and known-file reading stretches.
  The ladder accumulated those separately resolved signals through guidance, replan, escalation, and
  abort, killing the session at 81 tool calls while the repository-required green check was running.
- Varied consecutive tool inputs now reset the stall detector's quiet-turn tally, while an identical
  command repeated without progress remains quiet and can still signal. Ladder recurrence advances
  only when no file change followed the prior intervention for that signal type; durable progress
  resets that type to guidance, while command variation alone cannot forgive a periodic loop. Abort is opt-in through
  `--supervisor-abort` on both `run` and the TUI; `--supervisor-no-abort` remains a documented no-op.
- Rejected idea: disable or substantially lengthen the stall threshold during verification. That
  would hide genuine same-command loops and make detection depend on guessing which commands are
  "verification"; comparing input identity preserves the ladder's teeth without command-name
  special cases.

## First checked-in skill: `dogfood` (2026-09-01)

Status: **done**.

`.agentrig/skills/dogfood/SKILL.md` — the end-to-end shipping flow (fresh branch → green trio by
real exit codes → docs → PR → two parallel external reviews via background jobs → fix all
findings fail-first → stop at the PR, never merge), distilled from this project's accumulated
dogfood lessons. Auto-loaded in every trusted session via #61's discovery. `.gitignore` was
restructured (`**/.agentrig/*` + re-includes) because git cannot re-include below an excluded
directory — session logs and wikis stay ignored at every depth, only `/.agentrig/skills/` is
tracked. A core test now guards the repo's own skills: frontmatter must parse and names and
descriptions must fit the catalogue bounds untruncated, so a skill edit that would degrade every
future run fails CI instead.

## Skills auto-discovery — issue #61 (2026-09-01)

Status: **done**.

`loadRunConfig` now appends the conventional skill directories after any explicit `--skills`
dirs — `<trusted project root>/.agentrig/skills` first, then `~/.agentrig/skills` — so projects
carry their skills with zero flags and R6b's generated skills get picked up the next session.
Ordering matters and is pinned: `discoverSkills` is first-root-wins, so explicit dirs shadow
discovered ones. Trust boundary: the project dir loads only under the same R1d decision as
AGENTS.md and project config (an untrusted checkout contributes no skills); the user dir is
skipped when the repository contains the home directory (`userStateSafe`), like user config.
Opt-out via `skillDiscovery: false` in config or `--no-skill-discovery` (with `--skill-discovery`
as the positive override, the paired-negation pattern) — named that instead of the issue's
`--no-skills` because Commander would let `--no-skills` clobber the repeatable `--skills` array
type. `agentrig doctor` gains a read-only `skills` line naming which dirs a run would load and
why the skipped ones are skipped — and says "unknown" while config is invalid rather than
asserting dirs a run would never reach. Discovered dirs are deduped against explicit ones.
Pinned by discovery-order, untrusted-checkout, home-inside-repo (with and without `--trust`),
nested-cwd-vs-trusted-root, dedupe, opt-out, flag-override, and doctor tests. Mutation-verified,
including the two gaps the adversarial review found surviving the first round: discovery removed
fails 3, trust gate removed fails 1, order inverted fails 1, unconditional home append fails 1,
`join(cwd)` instead of the trusted root fails 1, dedupe removed fails 1.

## Self-hosting: `review` and `land` skills (2026-09-01)

The dogfood loop covered only the BUILDER role; the independent final review and the merge
sequence still lived outside the harness (in the cloud-session workflow that has been reviewing
and landing these PRs). Two new checked-in skills codify those roles so the whole cycle can run
through AgentRig itself:

- `review` — independent adversarial review of one PR on its final head: isolated worktree merged
  with current main, green trio judged by real exit codes, the whole diff read against the repo
  invariants, test-quality checks, 2–4 mutation probes on the load-bearing lines (serial, never
  overlapping runs in one worktree), re-verification of at least one of the PR body's fail-first
  claims, CI checked on the actual head SHA. Verdict is findings (file:line, severity, scenario,
  fix) or an evidence-listing pass. Hard boundary: never merges, never pushes to the PR branch.
  Meant to run in a session that shares no context with the author run.
- `land` — execution of a human merge decision, never the decision: re-check every precondition
  now (human named this PR; review verdict resolved; CI green on the re-fetched current head,
  both platforms; mergeable), squash with a final-state body, then WATCH main CI on the merge
  commit and treat red main as an emergency. One flake re-run permitted under the same rule the
  drive-to-green flow uses. One merge at a time; open PRs with a moved base get flagged.

- `ship` — the conductor: one session that spawns a builder subagent (dogfood skill), then an
  independent reviewer subagent (review skill — subagent isolation makes the independence
  structural: the reviewer gets none of the builder's context by construction), then STOPS and
  presents the verdict. The human's next message is the only path to landing; a fix request
  spawns a scoped fix child plus one delta re-review. A ship run that ends waiting at the
  verdict is a success. A builder child dead at its budget is reported by session id for manual
  resume, not silently re-spawned — the rough child-resume story is the R4 session-trees row
  starting to matter.

The remaining role AgentRig cannot self-host is the escape hatch: when a bad merge breaks the
harness itself, the fix needs a tool that is not the broken tool.

## Implementation plans for a band: `docs/plans/<band>.md` (2026-09-04)

The trains so far ran builder, reviewer and lander on one model, and the builder's mistakes were
design choices made mid-implementation (which snapshot mechanism, which hook point, what the
test list is) rather than typing. A plan written by a stronger model before the train fixes
those choices so a cheaper builder does mostly mechanical work, and the review gates stay
unchanged. `docs/plans/R5.md` is the first: mechanism, file-level changes, tests with named
mutants and known pitfalls per row, written against main `aad81ee` with the R4 train still
running (drift from R4 is the builder's to note).

- The plan is guidance under the row, never a second contract: the roadmap row text still wins
  and the deviation gate still applies to the row. A departure from the plan is recorded in the
  PR body under `## Plan departures` with its reason (dogfood §2); the reviewer compares the diff
  against the plan and an unlisted departure is a LOW finding (review §4).
- The subagent tool inherits the parent's provider, so a train cannot yet pin a different model
  per child; a plan file is the mechanism that works without that. A per-child model pin is a
  separate, small core change if the experiment pays off.
- Topic children and the dogfood skill's external reviews (2026-09-04, from the R4a fixer's log):
  the builder brief in `topic` §2 says "skip the external reviews", the fixer brief in §3 did not,
  and dogfood §8 unconditionally starts two. The R4a fixer pushed its fix in seven minutes, then
  ran three rounds of `claude -p` and `codex exec` reviews of its own, waited on them for about
  thirty minutes with three-minute silent polls, and widened its diff on what they found — all
  before the train's own delta reviewer had seen anything. Fixed in the skills: dogfood §8 is
  skipped under `ship`/`topic`, and the `topic` fixer and continuation briefs carry the same
  sentence the builder's does. A running conductor keeps its loaded skill text, so this applies
  from the next `/topic` invocation; children load `dogfood` fresh, so the §8 skip applies to the
  next child spawned from a checkout that has it.
- Rejected: putting the plan in the roadmap row. The row must stay short enough to quote
  verbatim in every child brief, and a plan that becomes contract would need the arbiter for
  every implementation detail.

## Dogfood skill: bounded review staleness (2026-09-01)

The first R1.5f dogfood run read §8's staleness rule as "full dual review after every fix
commit" and looped review→nit→fix→review for five rounds (~25–40 min each) without converging.
§8 now bounds it: staleness covers the delta only, fix-only commits are verified by their
fail-first tests rather than a fresh review round, at most one delta re-review, and a
non-converging reviewer gets its remaining findings recorded in the PR body instead of chased.
Also hardened the subagent abort test's tmpdir cleanup with rm retries — an aborted child still
flushing its JSONL raced the recursive delete on macOS CI (ENOTEMPTY, one observed flake).

## User-invocable skills: /skill-name — issue #62 (2026-09-01)

Status: **done**.

`/<skill-name> [task...]` in the TUI resolves an unclaimed slash-word against the loaded catalogue
and submits the skill body plus the trailing args as the turn, through the same submit path as any
task. The body rides inside `BEGIN/END SKILL` banners naming it repository-authored (the R13d
principal model: user invocation does not promote project-trust content), mirroring the
project-instructions banner convention. Built-ins always win by construction — `parseCommand`'s
switch claims its names first and only the default falls through to skill resolution —
`RESERVED_COMMAND_NAMES` exists so `/skills` can mark shadowed skills, with a guard test pinning
that every reserved name parses to its built-in. An unmatched `/word` keeps the old typo
protection: unknown-command treatment with a bounded-Levenshtein did-you-mean over built-ins ∪
skill names, and no model turn spent. `/skills` lists the catalogue (empty-state message, shadow
markers, a marker for space-containing names that cannot be slash-invoked).

New core event `skill.used {name, invokedBy: "model"|"user"}` — the issue said "existing" but no
such event existed; model-side activation was only visible as a generic `tool.call`. The `skill`
tool now emits it on successful loads only (a typo'd lookup is not an activation), and the event
is added to `TOOL_EMITTABLE_EVENTS` with `skill` as its sole emitter in `TOOL_EMIT_SOURCES` —
the first consumer of #67's source axis beyond the original three. `invokedBy: "user"` is
schema-valid but emitted by no core path yet: the CLI cannot (by design) append events to the
session log, so a TUI invocation's record is the delimited block in the user turn itself; the
enum value is reserved for a core-side invocation seam, and R9's user-vs-model comparison reads
the turn text until then. `buildAgent` now returns the discovered catalogue so the TUI can serve
it.

## Source-scoped emit gate — issue #67 (2026-09-01)

Status: **done** for findings 1 and 2; finding 3 (detector-side `file.changed` laundering) is
tracked separately — it needs detector changes, not a tighter emit gate.

The #63 gate was type-scoped: any tool could emit any of the four allowed kinds. Two of those
kinds carry authority beyond information, so `emitFromTool` now checks a third axis, SOURCE,
between TYPE and SHAPE: `TOOL_EMIT_SOURCES` in `events.ts` maps `plan.updated` to `update_plan`
and `subagent.spawn`/`subagent.end` to `subagent`; an emit of a mapped type from any other tool is
dropped and reported (`the "<tool>" tool tried to emit a "<type>" event, which only the "<sole>"
tool may emit; dropped` — all rejections now name the emitting tool). The bound name is the
REGISTERED tool's (`tool.name` from the loop's own lookup, the same identity `tool.call` records),
never anything the payload claims. `file.changed` deliberately stays open to every tool.

Why it matters: `emit` clears the supervisor's `force_replan` gate on any `plan.updated`, and the
forged plan also rewrites the scope the drift detector enforces — so under the old gate any tool
could release the one intervention PLAN §4.2 promises "cannot be ignored". The regression test
stages exactly that attack (gate raised mid-execution, tool forges `plan.updated`) and pins that
the gate survives; the constraint direction pins that `update_plan`'s own emit still lands and
still releases the gate. Both were verified fail-first against the gate with the SOURCE axis
removed. Decisions: the map lives in `events.ts` as plain strings rather than importing the tool
name constants (no events→tools dependency; a mapping change is a deliberate, visible edit guarded
by a drift test); an in-process tool that registers under a sole-emitter's name inherits its emit
right knowingly — tool registration is config-level trust, and the MCP adapter never calls
`ctx.emit` at all.

## Tool emit allow-list — issue #63 (2026-09-01)

Status: **done**.

`emitFromTool` in `agent.ts` now gates a tool's `ctx.emit` to `TOOL_EMITTABLE_EVENTS` (in
`events.ts`): `plan.updated`, `file.changed`, `subagent.spawn`, `subagent.end` — the four
informational/state kinds tools legitimately produce (inventoried across update-plan, edit-file,
write-file, subagent; the subagent deliberately does not forward child events). Anything else — a
forged `permission.decision`, `session.end`, or supervisor record — is dropped and reported as a
non-fatal `error`, mirroring `record()`'s validation of supervisor writes. Together the two seams
make the `record()` comment's guarantee ("an observer cannot forge a `tool.call` or a
`session.end`") actually hold. Grants no capability either way — the permission engine adjudicates
from the request, not the log — but the log is what the supervisor fold, `sessions show`, export,
and evidence read as truth, so a forgeable audit trail was its own harm. The set is a hand-kept
string list, not derived from the schema, so a new event type is not tool-emittable until someone
adds it deliberately. R13e fixture #2 was strengthened from "the forgery is ineffective" to "the
forgery is rejected AND ineffective". Pinned by `packages/core/test/tool-emit-allowlist.test.ts`
(both directions + reporting + a drift guard on the set), each verified fail-first against the
reverted gate.

## R13e injection fixtures (2026-09-01)

Status: **done** (pulled early per the roadmap's "rows, not milestones" note — pure tests, no
feature dependency on R13a–d).

`packages/core/test/injection-fixtures.test.ts` pins the R13 capability invariants that already
hold structurally, so a future R13a–d change cannot silently regress them:

- an injected instruction in a tool result cannot authorize a first exec call (headless ask→deny
  stands; the `run` call is `tool.denied`, never executed);
- a forged `permission.decision: allow` emitted into the log does not make the real engine skip a
  later call — the forgery is the adversarial setup, the still-denied exec is the pinned
  non-behavior;
- the permission engine decides from a `PermissionRequest` with no field for conversation, memory,
  or tool output — identical class+paths yield identical verdicts whatever the injected payload;
- a `pre_tool` hook cannot inject or fabricate an `allow` (the action is not in pre_tool's
  allow-list — rejected and reported);
- a forged supervisor audit record is rejected by the validated `record()` seam;
- a poisoned subagent brief inherits no widened permissions — the child runs under its own policy.

Each was mutation-verified: flipping the `RulePolicy` fallback to `allow` breaks four of them, and
dropping `record()`'s validation breaks the audit one.

**Finding surfaced, filed separately (not fixed here — out of R13e's pure-test scope):** a tool's
`ctx.emit` (`emitFromTool` in `agent.ts`) is unfiltered, so a tool can append a forged
`permission.decision` or `session.end` to the append-only log. It grants no capability (the real
engine still adjudicates every call — fixture #2 pins exactly that), but it contradicts the
`record()` comment's stated guarantee that "an observer cannot forge a tool.call or session.end."
An allow-list on `emitFromTool` is the fix, tracked as its own issue.

## Roadmap third pass (2026-09-01)

Two unified analyses of the `system_prompts_leaks` prompt-capture corpus were folded into
`docs/ROADMAP.md`: a new "third corpus" section (with per-capture confidence tiers and CC0
reuse caveats), new rows R1.5f, R5e, R6d–R6g, R12e, R13d–R13e, R14d, an amended R1.5d
(prompt bill of materials + freshness markers), and renunciations №10–12 (no prompt-compiler
subsystem, no mode state machine, no verbatim reuse of captured prompt text). Rows, not
milestones — the sequencing diagram is unchanged.

## CLI: leading --profile (issue #56)

Status: **done**.

- `--profile` is now also a root-level option, so the alias shape `agentrig --profile personal
  <subcommand>` dispatches correctly instead of dying in the default TUI command's stray-operand
  check with "unknown command 'sessions' (Did you mean sessions?)".
- Deliberately the ONLY dual-registered flag: Commander scans root options out of argv wherever
  they appear (the shipped root-option regression documented in `program.ts`), so the root copy
  swallows the subcommand's `--profile` token — the value is recovered at the config seam via
  `optsWithGlobals()` (`configured` and the doctor action). A test pins that the root option set
  is exactly `["--profile"]` so no other flag quietly migrates up.
- Behavior note: subcommands that never consult config (`sessions ls`, `login`, `dream`,
  `memory ingest`, …) accept `--profile` in ANY position (the root scan reaches trailing flags
  too) where they previously errored "unknown option". Never silently: a preAction hook prints
  `note: --profile is ignored by \`<command>\`` — erroring instead would break the alias shape
  this exists for, since a wrapper function appends the flag to every forwarded subcommand.
- Known accepted cost (adversarial review): a literal `"--profile"` used as another option's
  VALUE (`--system "--profile"`) is stolen by the root scan and errors misleadingly. The escape
  hatches work and are documented in `program.ts`: the `=` form (`--system=--profile`) and
  anything after `--` are never scanned. `enablePositionalOptions()` would remove the class but
  forbids the pinned bare-launch shape `agentrig --yolo`.
- Pinned by dispatch, both-positions value flow, run/TUI/doctor end-to-end profile resolution,
  nested `sessions resume` recovery (a `cmd.parent?.opts()` mutant survived the original suite),
  the ignored-note behavior, and root-option confinement tests; each verified to fail with the
  corresponding code reverted.

## Supervisor refinement

Status: **done**.

- Background polling now composes with the loop detector's durable-progress reset: a `bash_job`
  status result carrying incremental output clears repetition, and a poll with positive `waitMs`
  that comes back empty is NEUTRAL — not spinning, but not progress that clears other tallies
  either (clearing there let a `waitMs` poll on a finished job, which returns immediately, launder
  an unrelated loop running between polls). Immediate repeated polls that report `(no new output)`
  still tally, as do identical non-poll calls. Pinned by `treats identical bash_job status polls
  carrying new output as progress`, `does not count deliberate bash_job status polls that use
  waitMs as spinning`, `a waitMs poll between identical failing commands does not launder the
  loop`, `still counts repeated non-blocking bash_job polls with no new output`, and the
  pre-existing `loop: the same call three times with nothing changing is still a loop`. The
  `(no new output)` literal is pinned core-side too, as a cross-package contract.
- Verification/shipping is observable progress when a bash exit code transitions in either direction
  or a successful command stages, commits, pushes, or performs a `gh pr` operation. Variation credit
  is withdrawn when that varied call fails, preserving PR #36's varied-input lesson without allowing
  failure alternation to escape. Pinned by `treats bash exit-code transitions in either direction as
  verification progress`, `treats repeated successful git push operations as shipping progress`, and
  `does not forgive an A/B loop of fifteen failing bash commands on variation alone`.
- Escalation handlers may now resolve `answered`, `expired`, or `closed`; TUI prompts return that
  outcome, while legacy/non-TUI void handlers default to closed. An expiry counts as the issued
  rung's outcome and suppresses another ask only for the same stable signal signature for the rest
  of that policy/session, degrading it to guidance. Pinned by `degrades an expired escalation
  signature to guidance for the rest of the session`, `still escalates a different signature after
  another escalation expired`, `an answered escalation suppresses nothing`, `an expired escalation
  is counted once and recurring signals degrade to guidance`, `a void non-TUI escalation handler
  defaults to closed and suppresses nothing`, and — through the real timeout path rather than an
  explicit return — `a timed-out escalation counts as expired and degrades the recurring
  signature`.
- Rejected idea: exempt every `bash_job` status call from loop detection. It would hide the R1e shape
  where immediate polls repeatedly return no output; result-aware handling preserves that evidence.
- This refinement session's exact token count is unavailable from the API runner rather than
  fabricated; record it as another unavailable point beside the **1,718,936 / 669,418 / 3.3M /
  4.0M** existing baselines.

## M0 notes

- `HarnessEvent` = envelope (`seq`, `sessionId`, `ts`, stamped by the store) + discriminated `EventPayload`.
- `SessionStore` is append-only JSONL, one file per session; `read` validates every line and fails on seq gaps.
- `memory` and `supervisor` export interfaces only.
- `pnpm demo` writes a session containing the exact loop pattern M4's `loop` detector must catch.

## M1 notes

- `agentrig run "<task>" --headless --json` works end to end; `ask` resolves to deny headless.
  Without `--headless` on a TTY, `ask` prompts on stderr via `AgentConfig.onAsk` (the same seam
  the M7 TUI will use).
- Tools declare `paths()`; `cwdOnly` permission rules confine file tools to the project.
  `--allow write` is cwd-confined; `--allow write:anywhere` lifts it. bash declares no paths and
  cannot be confined — `--allow exec` is all-or-nothing.
- Stop reasons: `refusal` ends the session `done` with a non-fatal error event; a final response
  truncated at `max_tokens` ends it `reason: error` (CLI exit 1); unknown provider stop reasons
  surface verbatim via `raw` in the fatal error message.
- `steer()` takes an optional source (`user` default; the M4 supervisor passes its own); a steer
  still queued when the session ends is recorded as a non-fatal error, never silently dropped.
- Every event — including `file.changed` emitted from inside tools — goes through
  `SessionStore.append` on one promise chain, so `seq` order is emission order and
  `session.events` replays identically to the on-disk log.
- `ToolResult` gained optional `isError`: expected failures (non-zero exit, missing file, bad
  regex) reach the model as error tool_results; throwing is for unexpected failures only.
- Anthropic adapter speaks the streaming REST API directly (no vendor SDK) with an injectable
  `fetchFn`, so tests exercise the full SSE path with no network.
- Budgets are enforced at turn boundaries; `maxUsd` binds only when `pricing` is configured.
- Deferred to their milestones, per build order: hooks, compaction, resume (M2), TUI (M7).

## Exit-criterion debt: dogfooding

PLAN §6's exit criterion ("the harness is used to build the next milestone") is **not yet met**:
M1 and M2 were built without running the harness. Two live smoke attempts against
`gpt-5.6-sol` (2026-08-29, reports on PR #2) got as far as real streaming requests: the first
was blocked by the environment's network allowlist, the second by an exhausted OpenAI credit
balance. Both validated the error path live — well-formed fatal `error` events carrying the
provider's response verbatim, `session.end reason=error`, exit 1, clean log replay — and the
second prompted retry/backoff in the adapters (below). M3 must be built through `agentrig run`
(worker sessions for real subtasks, resume and compaction under real load) once the OpenAI
account has credits.

## M2 notes

- `OpenAICompatibleProvider` speaks Chat Completions streaming (OpenAI + local servers); one
  unified user message fans out to individual `tool` role messages; `apiKey` is optional for
  keyless local servers; same injectable `fetchFn` and truncated-tool-JSON guard as the
  Anthropic adapter. New event type `session.resume` (zod variant + render case + tests).
- Compaction defaults on: `summarizeOlderTurns()` fires past 70% of the provider's context
  window, keeps the task message and the last N messages verbatim (boundary widened so no
  tool_result is orphaned), and summarizes the middle via a direct provider call — that call is
  not metered by the budget. Emits `context.compact`.
- Resume: the loop writes a snapshot (`<id>.snapshot.json`, atomic overwrite) after every
  completed turn and at session end; `run(task, {resume: id})` restores messages/turns/usage/usd
  from it, appends to the same JSONL with contiguous `seq`, and emits `session.resume`. The log
  stays the source of truth — the snapshot is a cache; resuming without one fails loudly.
  CLI: `agentrig sessions resume <id> [task...]` and `run --resume <id>`; `--provider openai`
  with `--base-url` for local servers.
- Hardening from the M2 adversarial review: compaction is raced against abort and gets the
  session signal (a hung or failing summarization call can no longer wedge or kill a session;
  no-progress compaction warns once and stops retrying); snapshots synthesize error
  tool_results for a trailing unanswered `tool_use` so interrupted sessions stay resumable, and
  a resumed run that completed no turn never overwrites the prior snapshot; resume takes an
  advisory `<id>.lock` so concurrent resumes fail loudly instead of corrupting the log's seq
  order (a crashed holder's lock must be deleted by hand — the error names the path); the
  OpenAI adapter sends `max_completion_tokens` against api.openai.com (`max_tokens` for other
  base URLs, `maxTokensParam` to override); when a provider reports no usage the loop warns
  once and compaction falls back to estimates. `maxTurns`/`maxTokens`/`maxUsd` bind across
  resumes; `maxMinutes` is per-run wall clock. Resuming a budget-ended session requires an
  effective budget above the exhausted count; that can come from config/an explicit override or
  from resuming through an entry mode whose default is higher.

## Post-M2 hardening (from live smoke findings)

- All three provider adapters (and the ChatGPT auth/refresh calls) retry transient HTTP failures (429 rate limits, 5xx, network errors) with
  exponential backoff honoring `Retry-After`, capped at 3 retries / 30s, abort-aware; a 429
  that is quota/billing exhaustion fails immediately (retrying can't help). `RetryPolicy` is
  per-provider config.
- Headless `--json` mode mirrors fatal error events to stderr so a human tailing the process
  sees them without parsing the event stream.

## M2.5 notes

- `OpenAIChatGPTProvider` speaks the Responses API against
  `chatgpt.com/backend-api/codex/responses` with self-identifying attribution headers
  (`originator: agentrig`, own User-Agent — see §2.9), authed by the OAuth access token. Whether
  the endpoint accepts a non-first-party originator is the open live question; a 403 there is a
  real answer, not a thing to route around.
  `OpenAIChatGPTAuth` owns the device-code login, an atomic token store (default
  `~/.agentrig/openai-chatgpt-auth.json`, `AGENTRIG_OPENAI_CHATGPT_AUTH` to override), and
  proactive + 401-forced refresh that persists refresh-token rotation. CLI:
  `agentrig login openai-chatgpt` then `run --provider openai-chatgpt --model gpt-5.6-sol`.
- **Validated live on 2026-08-30 (Windows, Node, seeded from a Codex credential).** Two answers
  the unit tests could never give:
  - **The honest originator is accepted post-authentication.** `originator: agentrig` with a real
    token reached the application layer and was answered on its merits — no 403, no edge block.
    The spike's worry that a non-Codex originator is filtered is now disproved on both sides of
    authentication.
  - **The backend rejects `max_output_tokens`**: `HTTP 400 {"detail":"Unsupported parameter:
    max_output_tokens"}` on the first authenticated request, before a single token was generated.
    Codex does not send it either. The provider no longer sends it, so `ModelRequest.maxTokens`
    cannot bind one response here — the session budget still meters what was spent, and the CLI
    warns when `--max-tokens-per-turn` is typed against this provider rather than accepting a
    number it will not send.
- **Auth reuse for cloud/unattended runs.** Authorize once, then seed every session: run
  `agentrig login openai-chatgpt` on any machine, `agentrig login openai-chatgpt --export` to
  print the bundle, and set it as `AGENTRIG_OPENAI_CHATGPT_TOKEN` in the environment. A fresh
  container with no token file reads that env var (AgentRig's own shape *or* a pasted Codex
  `~/.codex/auth.json`), and within-session refresh still writes to the file. The interactive
  browser approval is inherently human and one-time — the harness cannot and should not perform
  it; the seed makes it a once-per-token step, not once-per-session.
- Hardening from the M2.5 adversarial review: every token response is validated before it may
  overwrite a stored credential (a drifted 200 fails loudly instead of writing `undefined` into
  an unrecoverable loop — the endpoint is expected to drift, so this is the load-bearing check);
  the token file is written via `O_EXCL` under a random temp name, so it can never follow a
  planted symlink or inherit a loosened mode, and the temp is removed if the rename fails; a
  corrupt token file falls through to the env seed with a one-time warning instead of bricking
  the provider; the provider and all auth calls go through `fetchWithRetries`, and a refresh
  failure distinguishes a rejected grant ("re-run login") from a transient outage
  (`TransientAuthError`, credentials still good); quota-vs-rate-limit classification is
  structured rather than substring-matched (a rate limit that merely links to a billing page is
  retried, not hard-failed); `Retry-After` accepts the HTTP-date form; response bodies are
  redacted before they enter an error message, since errors reach the session JSONL; an
  unrecognised `incomplete_details.reason` surfaces as an `error` stop with `raw` rather than a
  clean `end_turn`; a missing `call_id` gets a synthesized id so tool pairing holds; an opaque
  (non-JWT) access token refreshes on age via `lastRefresh`.
- **Reasoning replay.** Responses-API reasoning models emit `reasoning` items that must
  accompany their `function_call` on the following request, and the unified `ContentBlock`
  schema has nowhere to hold them — so the provider caches each response's raw items keyed by
  call id and replays them verbatim (requesting `include: ["reasoning.encrypted_content"]`).
  Without this, turn 2 of any tool-using conversation would 400. The cache is bounded and
  per-provider-instance, so a resumed session in a fresh process replays reconstructed calls
  instead — acceptable for non-reasoning models, and the most likely first live failure to
  watch for with a reasoning model.
- **The browser sign-in works (verified live, 2026-08-30, macOS, no Codex credential present).**
  First attempt, first try: the authorize parameters read from the codex source are right, and the
  loopback redirect, state check and code exchange all behaved. Nothing in the auth path is
  unverified any more.
- **`login` exits when it is done, which is correct and was unhelpful.** It is a separate command
  from `run`/`tui`, like `gh auth login` — but the only "what now" it printed was `--export`, for
  seeding a cloud environment. It now names the two commands a person actually wants next, both
  with `--model`, since this provider requires one and a hint that does not run is not a hint.
- **`loginCommand` has tests** (it had none): the auth object is injected, so everything except the
  one human-and-browser step is covered — the unknown provider, the URL being printed before the
  wait, `--no-browser`, the next-step hint, a failed sign-in exiting non-zero, and `--export`
  keeping the credential on stdout alone.
- **Sign-in is a browser flow now; the device-code flow is deleted (F1, 2026-08-30).**
  `auth.openai.com` puts an interactive Cloudflare challenge in front of BOTH `/deviceauth/usercode`
  and `/oauth/authorize` (`cf-mitigated: challenge`, 403 — reproduced from a cloud container and
  from a desktop, and confirmed again against `/oauth/authorize` while building this). The
  challenge targets the HTTP *client*: `fetch` is not a browser wherever it runs, so no Node
  process can complete either. An earlier note here said to "sign in on a machine with a browser";
  that was wrong.
  `startLoopbackLogin` inverts it — **the browser makes the challenged request and we never do**:
  - PKCE S256; the verifier never leaves the process, the challenge goes in the URL.
  - A one-shot listener on `127.0.0.1` **and** `::1`, because the browser decides what `localhost`
    means and on Windows that is usually `::1` — a v4-only listener never hears the redirect.
  - `state` is checked before anything is exchanged: a redirect that fails it is not ours, and a
    code we did not ask for is never sent to the token endpoint.
  - The code is never echoed into the page the browser shows. Paths other than the callback get a
    404 rather than failing the login, because a browser also asks for `/favicon.ico`.
  - The code is exchanged at `/oauth/token` — the same endpoint every refresh already uses, and the
    one endpoint that is NOT challenged, which is what makes the whole flow possible.
  - The device-code code and its tests are deleted rather than kept: a path proven unusable in
    production, kept "just in case", is dead code that reads like a fallback.
  Seeding from Codex's `~/.codex/auth.json` still works and is still the fastest path on a machine
  that already has it.
- **The token file reader accepts both shapes.** It used to parse only AgentRig's own camelCase
  bundle, so the obvious move — copying `~/.codex/auth.json` into place — failed with a "corrupt
  file" error that named neither the cause nor the fix, while the env-var path accepted exactly
  that shape. Both now go through `tokensFromEnvValue`.
- **Honest originator was NOT rejected pre-auth (verified 2026-08-29), and is accepted
  post-auth (verified 2026-08-30).** An unauthenticated probe returned **401, not 403** — it
  cleared the edge and was refused only for missing credentials. The first credentialed call then
  got a **400 about a request parameter**, which is an application-layer answer: the request was
  authenticated and read. The question this row was carrying is closed.
- Concurrency caveat: one subscription token should have a single refresh owner. Fanning out
  many resumed/parallel worker sessions on one token can race on refresh-token rotation; a
  static env seed sidesteps this only while the access token is still valid (~hours).

## M3 notes

- **Wiki on disk, no database.** `FileMemoryStore` over plain markdown: `index.md` is the
  catalog *and* the reservation ledger, `log.md` the append-only chronology, pages under
  `sources/ entities/ concepts/ analyses/`. Frontmatter is a deliberately tiny hand-rolled
  subset (scalars + inline lists) so the wiki needs no YAML dependency and stays human-diffable;
  a malformed page throws rather than being half-read. Index rows escape `|` and parse on
  unescaped pipes only — a summary containing a pipe used to corrupt the row.
- **Reservation is an O_EXCL page placeholder.** `reserve(slug, claimant, type)` creates the
  page atomically; a second claimant gets `exists` and is appended to `claimedBy` rather than
  overwriting the first. The LLM call happens outside the claim, per PLAN §3.2.
- **Retrieval is additive by construction.** `unionRetrieve` returns index-selected pages ∪ BM25
  top-k, and index picks are never subject to the BM25 `k` cutoff — so recall cannot regress
  below index-only. Hits carry `via: index | bm25 | both`. BM25 searches slug and aliases as well
  as the body, so "auth" finds `auth-module`.
- **Coverage is enforced, not hoped for.** Ingest splits the transcript into character-bounded
  spans (so one huge tool result can't blow the window) and every span must return either facts
  or an explicit `nothingDurable`. A span the model fails to distill throws and names the line
  range — a silent coverage hole is the failure this exists to prevent. `model.delta` events are
  dropped from the transcript as noise; tool calls, results, file changes, errors and steers are kept.
- **Duplicate captures** are settled by prefix comparison against a `capture:prefix` marker in
  the source page: a re-ingest of identical content is skipped, a grown transcript supersedes the
  earlier capture, and existing fact lines are never duplicated on re-ingest.
- **`raw/` is immutable in practice, not just in doctrine.** Attempts are one immutable file each
  (a duplicate id is refused), `addDoc` never overwrites (name collisions get a numeric suffix),
  and `isSessionLog` excludes core's `*.snapshot.json` / `*.lock` working files.
- **Pins store the claim, not a diff**, so re-application survives rewording; `claimSatisfied`
  tolerates one dropped content word. A contradicted pin becomes `conflict` and is surfaced —
  never silently dropped — and a missing anchor becomes `orphaned`.
- **Index injection is bounded.** The catalog rides in the system prompt (`run --memory <dir>`);
  past the cap the tail becomes "…and N more pages; use memory_search", so a large wiki degrades
  to search rather than eating the context window.
- CLI: `agentrig memory init|ls|show|search|ingest|lint`. `lint` currently reports the pin
  re-check and unfilled reservations; the full dream lint is M5. Provider construction was
  extracted to `provider.ts` so `run`, `sessions resume`, and `memory ingest` share it and the
  CLI stays thin.
- Ingest is exercised with a scripted fake `ModelProvider`; as with M1/M2 the model call is one
  seam and the suite stays network-free.

### M3 hardening (from the adversarial review)

The review found three of the milestone's headline guarantees were not actually kept, and two
defects that meant M3 did not run at all. All fixed, each with a regression test:

- **`index.md` was a lost-update race.** `upsertIndex` is a read-modify-write; two concurrent
  ingests deleted each other's catalog rows, leaving pages on disk permanently invisible to
  index-first retrieval — the exact scenario `reserve` exists for. Index mutation is now
  serialized in-process and behind an `index.md.lock` across processes (stale locks are broken
  after 10s). `reserve` also re-adopts a page whose row went missing instead of returning
  `exists` and leaving it orphaned.
- **`memory ingest` could never find a session `run` wrote.** Sessions defaulted to
  `.agentrig/sessions` while ingest reads `raw/sessions` per PLAN §3.1. The default is now
  `.agentrig/raw/sessions`, so the run → ingest flow works out of the box.
- **The memory tools were never registered.** `run --memory` injected an index telling the model
  to call `memory_read`/`memory_search` while the agent only had the six built-ins. They are now
  registered when `--memory` is set, with the read-class ones allowed by tool name (they are
  confined to the wiki root by the store, which a `cwdOnly` rule cannot express).
- **Source-typed facts were counted and written nowhere.** The prompt offers `pageType: "source"`
  and the schema accepts it, but the target loop skipped them while every accounting surface
  reported success. They now land on the session's own page.
- **"Explicitly closed" was not enforced.** `nothingDurable || facts.length === 0` collapsed
  "the model told me the span was empty" into "the model gave me nothing" — so a truncated reply
  read as covered. Now: an explicit `nothingDurable` is coverage; facts are coverage; a summary
  with no facts is coverage; and a reply with none of those throws, naming the span. Summaries
  are recorded before the branch so one can never be discarded.
- **A diverged re-ingest destroyed the source page.** The prefix check only decided skip-vs-not;
  the source body was replaced unconditionally. It now merges unless the capture was provably
  superseded, keeping PLAN §3.2's "unique content is never deleted" true.
- **Pins could not see a reversal, and nothing re-checked them.** The search tokenizer drops
  "not"/"never", so a page rewritten to the opposite claim read as `kept`. `claimSatisfied` now
  compares clause-scoped negation polarity and requires short claims to match in full — biased
  toward a false `conflict` over a false `kept`, since a silent loss is the failure pins exist to
  prevent. `recheckPins` now runs on every regeneration (ingest and `memory_write`), surfacing
  conflicts in the result rather than waiting for someone to run `memory lint`.
- **`raw/` could be overwritten.** `addDoc` had a stat/write TOCTOU that let concurrent calls
  clobber a source; it now creates exclusively and advances the suffix on `EEXIST`. Attempts are
  written temp+rename, and one torn file is reported via `readAttempts().corrupt` instead of
  throwing a raw `SyntaxError` that took down every ingest.
- **`memory_read` escaped the wiki root.** `../` resolved straight out, and the tool declares no
  `paths()` (a wiki-relative path would wrongly satisfy a `cwdOnly` rule), so enabling it granted
  unconfined reads. The store now rejects any path escaping its root.
- **Retrieval: `k` was not a bound.** Index picks were unbounded, so one common word could return
  every page. The index side is now ranked by term overlap and capped at `k`. The honest
  guarantee is therefore *"index-matched pages always outrank BM25-only ones, and the index side
  is ranked rather than arbitrarily truncated"* — not "index picks are never dropped".
- Smaller: `extractJson` scans top-level balanced values and keeps the richest (a `{}` in prose
  used to win, and a nested object could outrank the payload); coverage spans report original
  transcript line numbers; the capture marker is stripped from search text and snippets; hyphenated
  slugs are indexed by their parts (`auth` finds `auth-module`) while queries stay exact;
  frontmatter list items survive commas and unknown keys survive a rewrite; `indexInjection`'s cap
  covers the header and tail; `applyPinChecks` merges instead of replacing; `memory search -k`
  validates its argument; `memory show` reports a non-page instead of dumping a stack trace.

## M3b notes

- `MemoryBackend` is a sink and an *extra* recall source, never the truth and never a
  dependency. With nothing configured there is no backend at all — `loreConfigFromEnv` returns
  null unless both `LORE_API_URL` and `LORE_API_KEY` are set, so the no-infra default stands.
- **A backend can never block or break the wiki.** The backend block is genuinely the *last*
  thing `ingestSession` does — after page writes, after the pin re-check, after `appendLog` — and
  it is wrapped internally in `tolerant()` regardless of what the caller passed, so a raw
  (unwrapped) backend that throws still leaves a fully ingested session. `tolerant()` also
  imposes a timeout (default 15s) so a hanging backend cannot stall ingest, and guards `onError`
  itself so a throwing logger (EPIPE under `| head`) does not become the failure it was
  reporting. The ordering test observes the wiki *from inside* `onIngest` rather than asserting
  after the fact — the earlier version passed even with the call moved to the top.
- **Union, never replacement.** `withBackendRecall` appends backend hits after every local hit
  and drops any that duplicate a page already returned, so enabling a backend can only add. It
  enforces `k` itself, and `LoreBackend.recall` also slices to `k` (Lore's `limit` is advisory).
  Backend page tags (`<pageType>/<slug>`) are normalized to wiki paths before comparing, and
  backend-only hits carry a synthesized `page` so a caller never has to special-case them.
- **Provenance both ways, and it is written down.** A Lore memory carries
  `metadata.agentrig = <project>/<type>/<slug>` plus `agentrig` / `project:` / `session:` /
  `page:` tags; on the wiki side `annotateProvenance()` rewrites the stored fact lines to
  `(session:s1, lore:m0)` from the `BackendAck[]` that `onIngest` returns, so the memory id is
  durable in the page rather than only visible on a later recall. `promote` uses the same
  provenance namespace as ingest so the two do not diverge.
- Lore's contradiction check is **opt-in** (`checkBackendConflicts`) rather than a per-ingest
  round trip; when on, `backendConflicts` is reported alongside the wiki's own pin conflicts. The
  wiki lint runs regardless (the full dream pass is M5).
- `promote` maps a wiki page to one shared-scope Lore memory (private→shared), exposed as
  `agentrig memory promote <path>`. `openBackend()` is try/caught in the CLI so a malformed
  `LORE_API_URL` degrades to no backend instead of crashing `run`. The project name defaults to
  `basename(resolve(process.cwd()))` when `LORE_PROJECT` is unset.
- Lore responses are parsed **per row** with zod: one malformed row is dropped with a report
  rather than failing the whole recall.

## M4 notes

- **Two additive core changes** were needed and nothing else. `SessionControl.record()` lets the
  supervisor append `supervisor.signal` / `supervisor.intervention` through core's *single* append
  chain, so `seq` remains one total order over the agent's events and the observer's — a second
  writer would have raced the chain and corrupted that order. It is deliberately narrow (those two
  payloads only) so an observer cannot forge a `tool.call` or a `session.end`, and it drops records
  after the session ends so `session.end` stays the log's last line. `PlanItem.scope?: string[]`
  gives the `drift` detector something to compare against; nothing carried a declared scope before.
- **Fanning out the event stream needed no change at all.** Core's `EventStream` buffers and
  replays from position 0 for each `[Symbol.asyncIterator]` call, so the CLI and the supervisor
  each get their own cursor over the same events. The observer therefore applies no backpressure
  to the loop: an observer that is slow *asynchronously* delays interventions and nothing else.
  The limit of that guarantee is worth stating plainly — the observer shares one JS thread with
  the agent, so a detector that burns CPU **does** stall the run. `EventStream` decouples
  backpressure, not CPU. Detectors are expected to be cheap; that is what "heuristic, LLM-free"
  buys.
- **The ladder skips rungs it cannot perform rather than parking on them.** One definition
  (`inject_guidance → force_replan → run_reviewer → escalate → abort`) is filtered by declared
  capabilities, so in M4 it collapses to guidance → abort and deepens by itself when M6 attaches a
  reviewer and M7 lands the pre-tool hook. The important case is `escalate`: it is available only
  when an `onEscalate` handler exists, because a headless run has no human and a ladder that
  stopped there would leave a looping agent to burn its whole budget.
- **A signal suppressed by cooldown does not advance the rung.** Otherwise a noisy detector would
  silently climb to `abort` while every intervention was being thrown away — the session would die
  from interventions it never actually received.
- **The supervisor cannot break the session.** Every detector, policy and apply call is wrapped;
  a throw is reported through `onError` and the observer continues. `onError` itself is guarded, so
  a throwing logger does not become the failure it was reporting. Tests drive an exploding
  detector, an exploding policy and an exploding logger and assert the session still finishes
  `done`.
- **`onEscalate` is bounded (60s by default).** It runs inside the event loop, so an unbounded
  wait did not merely delay one intervention — the observer stopped consuming events, never
  reached the `abort` rung, and the looping agent it existed to stop burned its whole budget. The
  natural handler (prompt a human) blocks until someone types, so this bound is the difference
  between a supervisor and a deadlock. Reaching `escalate` with no handler is reported through
  `onError` rather than recorded as an intervention that quietly does nothing, and `supervise()`
  derives the capability from the handler's presence so declaring it without one cannot buy a
  dead rung. In the TUI the handler is now a free-form prompt rather than a line printed into
  scrollback: the answer is queued back to the running agent as a user steer. The prompt expires
  and is also settled on session/UI teardown, so a user who never answers cannot hang the run.
- **`record()` validates before appending.** `Detector` is a public interface and `signal()`'s
  clamping is optional, so a third-party detector can hand back `confidence: 1.4` — or `NaN`,
  which `JSON.stringify` writes as `null`. `serializeEvent` is a bare stringify, so either would
  write a line `SessionStore.read` then refuses forever, breaking `sessions show`, resume and
  `memory ingest` for that session with no repair path because `raw/` is immutable. Invalid
  records are dropped and reported as a non-fatal `error` event instead.
- **Pass counts come from scraped test output**, because no event carries one and two detectors
  (`stall`, `test_regression`) are specified in terms of it. Every pattern is **anchored on
  something only a test runner prints** (`Tests`, `Tests:`, `test result:`, pytest's `=` rule, a
  count at the start of a mocha line, go's `--- PASS:`). The first version scanned for a bare
  `/(\d+)\s+passed/` anywhere and defaulted the missing half to zero, so `rsync: 3 failed to
  transfer` read as a completed run with *zero passes* — `test_regression` scored that as losing
  the whole suite and the ladder escalated to `abort`. A half-match on prose must return `null`,
  never a zero.
- **`test_regression` fires only on a *drop* against the best count seen, in a comparable run.**
  Two things it must not mistake for a regression: a **subset run** (327 → 120 after "run
  everything, then iterate on one package" — the most common agent workflow there is), so a run is
  only compared when its `total` is at least the best total seen; and a **newly written failing
  test** (added failures with no lost passes), so failures alone are never the trigger.
- **`loop` clears its tallies on real progress.** A file changing to content it has not held
  before means the session moved, so the repeat counters reset. Without this, re-reading one spec
  file between edits — textbook agent behaviour, three identical `read_file` inputs — read as a
  loop, and a session writing a new file every turn was aborted at turn 6 with five files of
  genuine progress behind it. "Going in circles" has to mean circles, not repetition. The same
  reset applies to the repeated-error rule: three different assertion failures with edits in
  between are debugging, three identical failures with no edit are a loop.
- **`loop` fingerprints errors before comparing them**: durations, hex ids, pids and temp paths
  differ on every run and would otherwise make one tight loop look like a stream of distinct
  errors. The duration rule is `\b`-anchored so it cannot fire inside an identifier (`p5s` is not
  five seconds), and the hex rule requires a digit so ordinary words like `deadbeef` do not
  collapse into each other. Edit→revert thrash is `file.changed.contentHash` returning to a value
  the path held *earlier* and differing from what it holds now — rewriting the same content is a
  no-op write, not a revert — tallied per file, with both the per-path history and the tracked-path
  set bounded.
- **`stall` treats exploration as progress, not just a new tool name.** A turn that reads a file or
  searches/globs a path not seen before resets the quiet-turn tally, so an agent orienting itself
  through an unfamiliar tree is not called stuck; repeatedly reading the same target still fires.
  One continuous stall condition now emits once and re-arms only after progress, instead of
  generating the same escalation every N turns and climbing the ladder on unchanged evidence. Its
  test-run branch has the same one-signal-per-unchanged-count behaviour, counts only runs that are
  **still failing**, and resets whenever a file changes: an unchanged pass count on a *green* suite
  is the success condition, and re-verifying that a refactor kept the suite green is exactly the
  shape this would otherwise have called a stall.
- `drift` is v1 as specified: a literal path-prefix comparison, no model in the loop. Scope entries
  are exact paths or directory prefixes, not globs, on the grounds that a plan forced to write `**`
  will declare a scope so broad drift can never fire. Both sides are normalized before comparing —
  `\` becomes `/`, `..` is resolved so a path climbing out of the scope is not counted as inside
  it, and an entry that normalizes away (`.`, `""`, `/`, `./`) means **the whole repo**. That last
  case matters: leaving `"."` as a literal segment made the most natural way to declare a repo-wide
  scope turn *every* file into a stray. The LLM-judged, sampled version is M6.
- `force_replan`, `run_grader` and `checkpoint_rollback` are recorded but **not applied** — they
  need the pre-tool hook (M7), a grader (M6) and git checkpoints respectively. The default policy
  will not emit them unless the capability is declared; a hand-written policy that does gets an
  `onError` report rather than silence.
- CLI: `--supervise`, `--supervisor-no-abort`, `--supervisor-soft <fraction>`. The soft budget
  thresholds are derived from the same `--max-*` flags core enforces as hard limits, so the two can
  never disagree. Flag validation now runs **before** the provider is built: a typo'd budget flag
  should say so rather than be masked by a missing-credential error from a provider the run was
  never going to reach. The `finally` join on the observer is bounded (2s, then `detach()`) so an
  early exit from the render loop — EPIPE under `| head` — cannot hold the process for the
  session's whole remaining lifetime.
- **Caveat: the supervisor reacts one event behind.** It observes asynchronously, so between the
  event that triggers a signal and the steer landing, the agent may take another action. `steer` is
  queued to the next turn boundary anyway (the only coherent injection point), so this is inherent
  to an out-of-band observer rather than a fixable lag.
- **Caveat: `drift` cannot fire today in practice.** Nothing emits `plan.updated` yet — there is no
  planning tool until M7 — so the detector is correct and tested but dormant until something
  declares a plan.

## M5 notes

- **The dream actually edits the wiki it hands back.** `applyConsolidation` removes lines, marks
  superseded claims, annotates relative dates, and merges pages. The first cut of this milestone
  did none of it: it reported merges and removals and handed back a directory identical to the
  input, and under `--auto` told the user the corrections were live. PLAN §3.7's "review the
  artifact, not the plan" only means something if the artifact differs from the input. The report
  is now built from what was **applied**, never from what the model proposed — a removal whose
  line could not be matched is reported as unmatched rather than as done.
- Apply is conservative in one direction: **losing a true fact is worse than keeping a redundant
  one.** Merges append with a `<!-- merged from … -->` marker rather than interleaving (a wrong
  ordering that keeps every fact is recoverable; a wrong interleaving is not), removals need a
  near-exact line match, superseded claims are annotated rather than deleted (a replaced claim is
  still evidence of what was believed), and relative dates are annotated with the dream's date
  rather than rewritten — rewriting would guess at what "yesterday" meant.
- **The input is never touched, by construction rather than by discipline.** The dream is only
  ever handed a *copy* (`copyWiki`), and `fingerprint()` — a content hash of every file, path
  sorted — lets a test prove the original came out byte-identical. A dream that mutated its input
  would be unreviewable: the thing you are reviewing would already have happened. Review is the
  default mode for the same reason; `--auto` is opt-in.
- **That invariant had a hole, and "by construction" is what closed it.** `copyWiki` copied
  symlinks as symlinks, and `appendLog` was the one writer not using tmp+rename — so a symlinked
  `log.md` carried the dream's log line straight back into the original wiki. `copyWiki` now
  dereferences (which also makes the copy self-contained, so it cannot track the input mid-dream)
  and `appendLog` writes atomically like every other writer. A symlinked wiki *root* used to fail
  the whole command with an opaque `ERR_FS_CP_NON_DIR_TO_DIR`; it is resolved first now.
- **Most of the dream costs nothing.** The structural half (orphans, missing pages, index drift,
  stale file refs, relative dates, unsourced facts, unfilled placeholders) is derivable from the
  wiki's own text, so it runs with no model call. Only `consolidate` — contradictions, superseded
  claims, merges, removals — needs judgment and therefore tokens. That split is what makes
  `agentrig memory lint` free enough to run on every session end, and it is why `--structural-only`
  does not require a credential at all.
- **`memory lint` is now the real thing.** PLAN §5 defines it as "a dry-run dream report, no output
  store", so it runs the actual dream in structural-only mode and deletes the copy. It used to be
  a stub that only re-checked pins.
- **Promotion is a structural gate, not a prompt instruction.** PLAN says twice that nothing
  derived from a single session may be promoted, so the rule is enforced by counting *distinct*
  `session:` refs from frontmatter and each fact line's parsed `(…)` provenance group — and only
  from that group. Free-scanning the line text for `session:` meant a CI log URL
  (`https://ci/logs/session:9f3a1b`) or a sentence mentioning another session corroborated the
  page with itself, so a single-session page promoted itself to global. The model writes the page
  body, so anything derived from the body's free text is something the model can talk its way
  past — the gate has to read only the parsed provenance. One session cited five times still
  counts as one. The floor cannot be lowered below two even by a
  caller passing `minSessions: 1`. A low-confidence page is held back even with enough sessions.
  The reasoning: one session's conclusion may be true only of that branch, that machine, that
  afternoon; corroboration across two independent sessions is the cheapest proxy for "this
  generalizes", and it is the difference between a global wiki worth consulting and one that
  accumulates noise.
- **Model findings are filtered against reality.** A consolidation naming a page the wiki does not
  have would send the apply step at a file that does not exist, so `dropUnknownPages` discards it;
  a "merge" of fewer than two pages is likewise dropped. The report has to be actionable.
- **A failed consolidation costs the consolidation, not the dream.** `extractJson` *throws* on a
  response with no JSON in it, so it is guarded separately from the schema check — a model that
  answers in prose leaves the structural findings intact and sets `consolidationError`.
- **`--auto` keeps the previous wiki beside the new one** as `wiki.before-dream-<stamp>` rather
  than deleting it. A dream is a bulk LLM rewrite of the agent's memory; undo has to be a directory
  rename, not a restore from a report. It refuses to overwrite an existing backup, refuses to apply
  a wiki onto itself, and restores the original if the second rename fails. It copies-then-swaps
  rather than renaming twice because the dream's output normally lives in the OS temp dir, which is
  often a different filesystem — `rename()` cannot cross one.
- Each phase is a separately exported function, per PLAN §3.7's "each its own prompt so they can be
  tested independently" — a test drives one phase with a scripted provider without standing up a
  whole dream. `orient` and `prune`/`rebuildIndex` turned out to need no model at all.
- **The prompt is bounded on both axes.** Page text is capped (24k chars, truncated at a page
  boundary) and so are signals — those come from the attempts ledger, which grows for the life of
  the project, and 400 attempts with long lessons built a 212k-char prompt against that 24k page
  budget. Signals are now ranked best-corroborated-first and capped by count and characters.
- **`--since` and `.last-dream` now affect what the dream considers.** They previously reached
  only a log line: attempts were read unfiltered and uncapped, so the marker changed nothing.
  `--since` is validated as a positive integer — `Number("abc")` is `NaN` and `slice(0, NaN)`
  silently yielded nothing, so a typo turned the dream into a quiet no-op.
- **`rebuildIndex` preserves the reservation ledger.** Stamping every row `active` destroyed it:
  the `unfilled` check could never fire again after one dream, and `index.md` — injected into
  every system prompt — began advertising placeholders as real pages whose summary read
  "Reserved by session:s1; content pending ingest."
- **`applyDream` names the directory your wiki is in when a restore fails.** The restore error
  used to be swallowed and the *apply* error rethrown, so a user whose wiki no longer existed at
  `wiki/` was told "could not move staged into place". Nothing else would have told them.
- **Caveat: `consolidate` still sees a bounded slice of the wiki.** On a large wiki the later
  pages are not considered for contradictions in a given run. Chunking across several calls is
  the obvious fix and is not done here.
- **Caveat: the four phases are one model call, not four.** PLAN says each phase gets its own
  prompt; only `consolidate` currently needs one, so that is the only prompt that exists. The
  others are exported and testable but model-free, which is a simplification of the spec rather
  than a full implementation of it.
- **Caveat: nothing schedules the dream yet.** `agentrig dream` is the manual trigger; the
  `session_end` hook and cron triggers PLAN §3.7 names need the hooks surface, which is M7.
- **Caveat: promotion proposals are reported, never performed.** Even with `--auto`, a promotion is
  listed and nothing is written to the global wiki. `--global <dir>` now attaches one so the
  section can at least render — previously no caller ever set `globalWiki`, so the proposals could
  never appear at all and "promotion to global" looked implemented when nothing could reach it.
  Actually writing across scopes is still deliberately left until there is a global wiki worth
  writing into.
- Structural lint hygiene, all from the review: fenced code blocks and inline spans are stripped
  before matching, so a recorded `git log --since="2 days ago" -- src/nope.ts` is a transcript
  rather than two defects; the file-reference check matches any backticked path with an extension
  instead of a four-prefix allowlist that missed `lib/`, `README.md` and `apps/`; the containment
  guard compares on a path boundary, so `../wikix/absent.ts` no longer escapes a `…/wiki` root;
  and an orphan is no longer counted a second time as "unlisted", which inflated the printed
  finding count and the exit code.
- A failed dream disposes its temp copy. `memory lint` runs on every session end, so leaking a
  full wiki copy per failure — one malformed `pins.json` is enough — would quietly fill the disk.

## M6 notes

- **`update_plan` had to exist first.** Two supervisor pieces were specified against
  `plan.updated` and neither could work, because nothing in the harness ever emitted one: `drift`
  (§4.1) compares `file.changed` against the plan's declared `scope`, and `force_replan` (§4.2)
  requires a fresh plan before more tool calls. Both shipped dormant in M4. Adding the tool
  activates both — M4's drift detector is live for the first time.
- **`force_replan` is a real gate, not a message.** `SessionControl.requirePlan(reason)` makes the
  loop refuse every tool except `update_plan`, with the reason passed through so the model is told
  *why* and what to do rather than just failing. It clears the moment a plan lands — including one
  emitted in the same turn — so a cooperative agent loses one tool call, not a turn. This is
  exactly why the rung sits above `inject_guidance` on the ladder: guidance can be ignored, a gate
  cannot.
- **A gate can never be permanent, and is never raised where it cannot be satisfied.** Both halves
  were needed, and the first cut had neither. `update_plan` declares `read` and touches no path,
  and the default read rule is `cwdOnly` — which `RulePolicy` skips when a call declares no paths
  — so under the harness's *own* defaults it fell through to `ask` and headless denied it: a gate
  nothing could ever clear. `defaultRules` now allows it by name. Separately, `supervise()`
  asserted the `forceReplan` capability unconditionally on the grounds that the gate "needs no
  collaborator"; it does — the session's tool list must contain `update_plan`. It is now derived
  from `control.canRequirePlan()`, and a caller asking for the rung on a session that cannot serve
  it gets an `onError` report. As a belt-and-braces third measure the gate releases itself after
  `MAX_REPLAN_REFUSALS` (2) with an `error` event saying so, and immediately when the session has
  no plan tool at all. Without these, `agentrig run --headless --supervise --supervisor-no-abort`
  was a live deadlock: 34 of 40 turns refused by a gate nothing could clear, ending on `budget`.
  A supervisor rung that can wedge the loop is strictly worse than the loop it was catching.
- **The reviewer proposes several directions, not one.** A supervisor that hands back a single
  instruction has replaced the agent's judgement with its own on the strength of one sample.
  Candidates keep the decision where the context is, and make the guidance falsifiable — an agent
  can look at three options and recognise that none of them fit. The prompt is also explicit that
  re-suggesting something the attempts ledger already records as failed is the least useful
  possible answer.
- **The reviewer reads the attempts ledger, which is the piece AVO lacked.** Reviewing a
  trajectory alone means re-deriving what was already tried; the ledger says it outright.
- **The grader fails closed.** An unparseable grader response returns `pass: false` with the parse
  failure as the gap. Defaulting to pass would mean a broken grader silently certifies everything,
  which is strictly worse than having no grader at all. The reviewer, by contrast, degrades to
  empty guidance — a reviewer that says nothing costs a rung; a grader that says "yes" costs the
  whole point of grading.
- **The grader is told to grade artifacts, not narration.** "If the trajectory claims something
  the files do not show, that is a gap, not a pass" is in the system prompt, because the failure
  mode of self-assessment is reading your own output charitably.
- **`run_reviewer` became a real `Intervention` variant** rather than the `run_grader`
  placeholder M4 used for that rung. Additive to the discriminated union, with a zod round-trip
  test and a `renderEvent` case, per the repo rule. `renderEvent` now prints an intervention's
  payload instead of `JSON.stringify`-ing it at the reader.
- **Capabilities are derived from what was actually supplied**, applied after any caller-declared
  ones — the M4 review's lesson about `escalate`. Declaring a rung whose machinery is absent buys
  an intervention that silently does nothing; reaching one now reports through `onError`.
  `forceReplan` defaults on because core's gate needs no collaborator.
- Both LLM rungs are bounded by the same timeout mechanism as `escalate` (90s default): they run
  inside the observer's event loop, and an unbounded one would stop it consuming events — the
  M4 review's critical finding, which applies verbatim to any blocking rung.
- CLI: `--supervisor-review` opts into the LLM-backed rungs. They cost tokens, so the default
  stays the free M4 ladder — detectors and guidance — rather than nothing.
- **Caveat: the reviewer and grader share the session's provider and model.** A cheaper or
  differently-aligned reviewer model is the obvious next step and is not wired.
- **Caveat: `artifacts` is caller-supplied.** The supervisor does not infer which files to grade
  from `file.changed`; the CLI passes none today, so `run_grader` grades the trajectory alone
  unless a caller supplies them through the SDK. The CLI also supplies no rubric, so the rung
  stays unreachable from `agentrig run` — reachable from the SDK, and honest about it, rather than
  advertised and dead.
- **Caveat: the reviewer sees the last 400 events condensed to 120**, not "the whole trajectory"
  as PLAN §4.3 words it. The bound is what keeps a stuck session's trajectory from growing the
  prompt without limit; the tail is kept because what the agent just did matters more than how it
  opened.
- **Caveat: a replan gate does not survive `--resume`.** It lives in session state, so resuming
  silently drops a pending requirement.
- **Caveat: `checkpoint_rollback` is still the one unimplemented rung.** It needs git checkpoints,
  which nothing creates yet, and the default policy never emits it.

## M7 notes — hooks (the first row)

M7 is the one milestone PLAN deliberately leaves unordered ("in whatever order dogfooding
demands"), so it ships as several PRs rather than one. **Hooks went first because three earlier
milestones left caveats explicitly waiting on them**: M3's session-end ingest, M5's dream trigger,
and M3b's Lore auto-retrieval. Two of those three are now closed.

- **Seven points, wired where the loop can actually act on them**: `user_prompt`, `pre_model`,
  `post_model`, `pre_tool`, `post_tool`, `pre_compact`, `session_end`.
- **Not every action means something at every point**, so each point declares which it accepts and
  anything else is reported and ignored rather than silently dropped. `session_end` accepts only
  `continue` — the session is already over, so a denial there would be a lie.
- **A hook cannot break the session.** Every handler is wrapped; a throw becomes a non-fatal
  `error` event and is treated as `continue`. An extension point that can kill the thing it
  extends is worse than no extension point.
- **A hook influences the session through its return value or not at all.** Each handler gets a
  *copy* of everything mutable it can see. Without this the whole validation story was theatre:
  `ctx.request.messages` **was** the live message array, so a handler returning `continue` — no
  patch, nothing to validate — could push messages the model then saw with zero events in the log,
  and a `pre_compact` hook, at a point that accepts no `modify` at all, could empty the history and
  send the next request with `messages: []`. Replaying the JSONL would have reconstructed a
  conversation that never happened.
- **A hook cannot hang the session — including after the work is done.** Each handler is raced
  against a timeout (30s default, per-hook override), *and* each point has one wall-clock budget
  for the whole chain. Per-hook overrides alone were not enough: ingest (10 min) and dream (15
  min) run sequentially at `session_end`, so a wedged network call in either could hold
  `session.done` for 25 minutes with Ctrl-C unable to shorten it. The timeout now also aborts a
  controller the handler can observe, and the runner races the session's abort signal — a race
  that merely abandons a promise leaves the work running.
- **A `modify` patch is validated before it is applied.** A `pre_tool` patch is re-parsed against
  the tool's *own* zod schema, and a patch that fails is reported with the original input used
  instead. A hook is third-party code; its patch is a proposal, not an instruction.
- **`pre_tool` sees the parsed input**, not raw JSON, so a hook reasons about typed data. It runs
  before the permission check, so a hook denial and a permission denial produce the same
  `tool.denied` event.
- **`post_tool` can rewrite what the *model* sees without rewriting the log** — and that
  divergence is itself recorded. The `tool.result` event keeps what the tool returned, and a new
  `tool.result.patched` event records that a hook changed what the model consumed. Without it the
  asymmetry ran the wrong way: a hook could inject text into the tool result the model read that
  appeared in neither the log nor anything the supervisor sees, steering the model unobserved.
  "A hook shapes the conversation, it cannot rewrite history" was true but understated — it could
  write *future* history invisibly.
- **A hook nudge is attributed to the hook.** `post_model` injects were logged as
  `steer source: "user"`, and the supervisor's reviewer grades trajectories off those events — so
  a hook nudge was being scored as a human correction. `steer.source` gains `"hook"` (added to the
  enum, not repurposed).
- **Wrong-shaped `modify` patches are reported at every point**, not just `pre_tool`. Three
  mutually incompatible patch shapes hide behind one `patch: unknown` — a bare string
  (`user_prompt`, `post_tool`, last-string-wins), `{system: string}` (`pre_model`), and a shallow
  object merged into the tool input (`pre_tool`). A plugin author with the wrong shape used to get
  silence at three of the four.
- **`HookContext.result` carries `display` as well as `output`.** It was typed
  `{ok, output: string}`, but six of the eight builtins return a non-string `output` (bash returns
  `{exitCode, stdout, stderr}`); a redaction hook written against the declared type crashed on
  `.replace` and was reported as a generic hook failure — the worst outcome for a redaction hook.
  Worse, `output` was not even the string a patch replaces. Now `{ok, display, output: unknown}`.
- **The first `deny` wins and stops the chain.** Asking the remaining hooks to weigh in on
  something already refused is meaningless. `modify` and `inject` accumulate, so two hooks can
  each contribute.
- **`session_end` runs before `session.end` is written**, so a hook can still append to the log —
  which is exactly what ingest needs. `session.end` remains the last line.
- **Both memory hooks are advisory.** `ingestOnSessionEnd` and `dreamOnSessionEnd` report through
  `onError` and return `continue` regardless. A session that finished its work has finished it;
  a failed ingest must not change that.
- **A session id is validated where it is created, because it becomes a filename.** `--resume
  <id>` puts a user-controlled string there and nothing checked it, so
  `--resume '../../../home/user/notes' --ingest-on-end` made the ingest hook read a `.jsonl`
  anywhere on disk, send it to the model, and distil it into the agent's *persistent* memory —
  exfiltration and memory poisoning at once, durable in a wiki every future session reads through
  `index.md` injection. `SessionStore` now rejects anything but `[A-Za-z0-9_-]{1,128}` at
  `create()` and in every path builder, and the ingest hook re-checks containment itself rather
  than trusting a caller upstream to have done the right thing.
- **The dream trigger stamps the LIVE wiki, not just the copy.** The stamp answers "when was a
  dream last run", not "last applied" — writing it only into the output copy meant review mode
  never advanced it, so once the threshold was crossed it stayed crossed: `--dream-on-end` ran a
  full consolidate-phase dream on **every** session end forever, leaking a wiki copy to `/tmp`
  each time and making both cadence flags inert. A never-dreamt wiki is also no longer treated as
  instantly overdue, and a clean review-mode dream disposes its copy instead of keeping one
  nobody asked for. `--dream-structural-only` makes the unattended trigger free.
- **The dream trigger reports, it does not apply.** PLAN §1.5 makes review the default, and an
  automatic dream that applied itself would be the least reviewable thing in the system. `auto`
  exists but is off.
- CLI: `--ingest-on-end`, `--dream-on-end`, `--dream-every-sessions`, `--dream-every-hours`. Both
  are opt-in: ingest costs tokens, and a harness that silently spends them on every exit would be
  the wrong default.
- **Caveat: `pre_model`'s `modify` only patches the system prompt.** Patching messages or tools
  wholesale needs a validated patch shape that does not exist yet, and an unvalidated one is the
  M6 lesson repeated.
- **Caveat: a `pre_compact` veto is permanent for the session.** Re-asking every turn would put a
  hook on a hot path forever; a hook that said no once means no.
- **Caveat: `session_end` hooks still run sequentially.** They cannot deny, so running them
  concurrently would be sound and faster; the group budget bounds the damage in the meantime.
- **Caveat: hooks are constructed in code, not configured.** PLAN §5's `agentrig.config.ts` would
  let a project register hooks declaratively; the CLI wires the two memory hooks behind flags and
  everything else is SDK-only.
- **Still open in M7**: the Ink TUI, the MCP client, subagents, and skills. Lore's auto-retrieval
  (M3b's caveat) now has a `user_prompt` point to attach to but is not wired.

## M7 notes — the TUI (second row)

- **`agentrig` is an `isDefault` subcommand, not options on the root.** Options declared on the
  root `program` are consumed by Commander *wherever they appear in argv*, including after a
  subcommand name — so putting the TUI's flags there silently swallowed `--root`, `--model`,
  `--max-turns` and the rest from every shipped subcommand, which then fell back to its default
  with no error. `agentrig sessions ls --root foo` wrote to the wrong directory and said nothing.
  A default subcommand keeps the TUI's options on the TUI, and preserves Commander's
  unknown-command error so a typo is rejected instead of dropping the user into an interactive
  agent with their intended command discarded.
- **One `buildAgent()` assembles the agent for both entry points.** `run` and the TUI each built
  their own, and the copies had already diverged in seven ways inside the commit that created
  them — different system prompts, no flag validation on the TUI side, no `--allow`/`--deny`, and
  no `session_end` hooks at all, so an interactive session could read the wiki but never write to
  it. That is precisely what CLAUDE.md's "keep the CLI thin" rule exists to prevent, and it was a
  self-inflicted violation.
- **The TUI is layout; a headless `TuiController` is everything else.** A terminal UI is close to
  untestable, so every decision — what a line says, when a permission prompt appears, what a slash
  command does — lives in a class a test drives without a screen. `app.tsx` has no logic in it,
  which is why it needs no test and why the 27 tests here are worth something.
- **Slash-command parsing is a pure function** with a test asserting that *every* command
  `/help` advertises actually parses. A help list that drifts from the parser is the classic way
  a TUI lies to its user.
- **A typo is reported, not sent to the model.** Someone who typed `/memroy` meant to run a
  command; spending a turn on it as a prompt is the least useful possible response. Unknown
  commands print the help so the answer is always in reach.
- **The permission prompt is a promise bridged to UI state.** `controller.ask` is the agent's
  `onAsk`; it parks a resolver, the view renders it, and a keypress resolves it. While a prompt is
  up it takes the keyboard entirely. Requests **queue** rather than replacing each other: a single
  slot silently overwrote the first resolver when two overlapped, leaving its promise unsettled
  and the loop wedged. Core runs tool calls sequentially today so that was latent, but parallel
  execution is an obvious next change and a queue costs nothing now. Nothing is ever dropped
  unsettled — shutdown and abort resolve every outstanding request as a denial.
- **ctrl-C had to be taken back from Ink.** With `exitOnCtrlC` on (the default) Ink unmounts on
  ctrl-C *and refuses to dispatch it to `useInput`*, so the abort handler in the view was dead
  code: the UI vanished while the agent kept running, still executing bash, now invisibly. The TUI
  now renders with `exitOnCtrlC: false` and installs the same `SIGINT → abort` handler `run` does.
- **`/quit` stops the turn before exiting**, for the same reason.
- **Scrollback is `<Static>`.** As live `<Text>` the render cost grew with the buffer — 800 lines
  took 5s at a 500-line cap versus 0.5s at 50 — because Ink repaints the whole frame on every
  print, which also destroys terminal scrollback. `Static` writes each line once above the live
  frame, so the cap could go from 500 to 5000.
- **`/supervisor` says no supervisor is attached** rather than "nothing raised". The TUI attaches
  none, and "nothing raised" reads as *all clear* when the truth is *nothing is watching*.
- **`/abort` answers a pending prompt as well as aborting.** Without that the loop would sit
  waiting for an answer nobody is going to give, and the session would never end.
- **The line buffer is bounded** (500 by default). An unattended terminal running a long session
  must not grow without limit.
- `/memory` and `/dream` are **injected**, not imported, so the controller stays free of stores
  and a test can drive them without a wiki. When they are not wired the TUI says so rather than
  failing silently.
- **Caveat: the input line is a minimal reader** — printable characters, backspace, enter. No
  history, no cursor movement. A paste arrives as one multi-character chunk, which used to land
  embedded newlines in the buffer literally and corrupt the line; it now submits at the first
  newline and keeps the remainder, which is correct rather than pleasant.
- **Caveat: `model.delta` is dropped rather than streamed.** Rendering per-token deltas as lines
  would drown everything else; showing them as a live-updating block is the obvious improvement
  and is not done.
- **Caveat: the TUI does not attach the supervisor.** `/supervisor` shows signals from the event
  stream, so it stays empty unless something else attached one.
- **Caveat: no test renders the React tree.** `ink-testing-library` is installed but unused — the
  controller split means there is nothing in the view worth asserting on, and a snapshot test of
  terminal output would break on every cosmetic change.

## M7 notes — the MCP client (third row)

- **Written against the wire format, not the SDK.** A client needs three request shapes —
  `initialize`, `tools/list`, `tools/call` — over newline-delimited JSON-RPC. The official SDK
  would pull a large surface for that, and the adapter is the interesting part anyway.
- **An MCP tool's permission class is `exec`, always.** The harness cannot know what a
  third-party tool does: a server's `search` may read a database or shell out. `read` would be a
  guess that fails open, and the permission system's whole value is that the dangerous default is
  the safe one. It also declares no `paths()`, so it can never satisfy a `cwdOnly` rule — there is
  no honest way to say which files a remote tool will touch.
- **Tool names are namespaced *and sanitised*.** Both halves are user- or server-controlled and go
  straight into the provider payload, which requires `^[a-zA-Z0-9_-]{1,64}$`. A server named
  `my server` in a config file, a dotted tool name (common in real servers), or a long name from
  an enterprise server all produced a name the provider rejects — and the rejection is a 400 on
  *every* model request, so one bad entry killed the whole session rather than costing only its
  own tools, falsifying the claim that a broken server is contained. Disallowed characters are
  mapped, over-long names truncated with a hash of the original, and the hash is applied whenever
  the composition is not reversible — which also closes the `__`-delimiter collision where
  server `a__b`/tool `c` and server `a`/tool `b__c` composed to one name.
- **A server's schema is normalised before it is advertised.** A server declaring
  `{"type":"string"}` is both rejected by the provider and, if accepted, tells the model to send a
  string that `inputSchema`'s zod check then refuses forever — the two sides disagreeing by
  construction. Non-object schemas fall back to an empty object schema, and `$schema` is stripped.
- **`Tool.jsonSchema` was added to core** (additive) so an MCP tool advertises the *server's* own
  JSON Schema. Converting it to zod and back would degrade it to "an object", losing every field
  description the server wrote — which is exactly what the model needs to call the tool correctly.
  `inputSchema` still governs validation, so a permissive zod schema plus the server's real schema
  is honest on both sides rather than a lossy round trip.
- **A server is third-party code, so the M7a hook lessons apply unchanged**: every request is
  timeout-bounded, a non-conforming reply is rejected rather than trusted, a dead child rejects
  everything outstanding rather than leaving requests pending forever, and non-JSON on stdout is
  reported once rather than crashing the reader. `tools/list` pagination is bounded, because a
  server returning a cursor forever would loop.
- **`close()` reaps the process *group*.** Real MCP servers are commonly wrappers (`npx`, `uvx`,
  a shell shim) that spawn the actual server, so signalling one pid orphaned the grandchild — the
  common case, not the exotic one. The child is spawned `detached` and killed by group, as the
  bash tool does. The teardown sleep is also no longer `unref`'d: an unref'd timer let Node exit
  before it fired, so `close()` never resolved when the event loop was otherwise quiescent — which
  is exactly the teardown case, meaning the SIGKILL escalation was skipped and any later server in
  the list was never closed at all.
- **Config accepts `mcpServers` and `servers`.** Claude Code and Cursor use the former, VS Code
  the latter; accepting only one — with a default of `{}` on top — meant pointing the flag at a
  working config produced a silently tool-less session. Neither key present is now a hard error.
- **The environment is not inherited wholesale.** A user pointing at a third-party binary should
  not hand it every secret in their shell, so only `PATH` plus explicitly configured vars are
  passed.
- **A server that fails to start costs its own tools and nothing else** — one broken entry in a
  config file must not stop the agent from running, the same way a failed hook or backend does not.
- Config is `{"servers": {"<name>": {"command", "args", "env"}}}` — the shape Claude Code and
  Cursor use, so an existing file works unchanged. `--mcp-config <path>`.
- **Caveat: stdio transport only.** HTTP/SSE servers are not supported.
- **Caveat: only `tools/*` is implemented.** MCP resources and prompts are not, and neither is
  the server-initiated side of the protocol (sampling, roots).
- **Caveat: servers are started per session**, so a long-lived server is respawned each run.
- One real-process test covers group reaping, because it cannot be faked. Note the trap it
  documents: `kill(pid, 0)` succeeds on a *zombie*, so checking existence rather than liveness
  reports a false failure — the test polls process state instead.

## M7 notes — subagents and skills (the last two rows)

### Subagents

- **`subagent.spawn` / `subagent.end` had been in the schema since M0 with nothing emitting one** —
  the same dormant contract `plan.updated` was before M6. `subagent.end` gains an optional
  `reason`, because knowing *how* a child finished is the useful part in a log.
- **The point is context isolation, not parallelism.** A search that would fill the parent's
  window with fifty file contents happens in a session of its own and the parent receives only the
  answer. So the child's events go to the child's log; forwarding them would defeat the entire
  reason to spawn one. The parent's log records that a child ran and how it ended — enough to
  trace, not enough to drown.
- **Depth-limited, and the tool threads `depth` itself.** Unbounded recursion here is a fork bomb
  with a token budget attached. Default depth 1: a subagent cannot spawn its own. The child's
  subagent tool is built by the tool at `depth + 1`, and any subagent tool the caller's
  `childConfig()` supplies is dropped — the first version left `depth` for the caller to thread,
  which nothing did, so `maxDepth` could never fire (3601 sessions in 5s with `maxDepth: 1`).
- **A child's budget is stated, never inherited.** A child is a separate session with a separate
  meter, so a parent's `maxTokens`/`maxUsd`/`maxMinutes` cannot bind it: spreading the parent's
  budget gives *every* child the parent's whole allowance, and omitting it gives every child none.
  `subagentTool` takes `childBudget` explicitly and the CLI fills it from the parent's flags.
- **Descendants are pooled per parent session** — `maxChildren` (default 8), `maxChildTokens` and
  `maxChildUsd`. Without this a parent could finish `done` inside a 10-token cap having spent
  thousands of dollars through its children. Three details that a first version got wrong:
  - the pool is threaded down the tree (`ancestorPools`), so a grandchild is charged to *every*
    ancestor. Held per level, `maxChildren` bounded a level rather than a tree — total children
    was `maxChildren ** maxDepth` — and everything below the first level was invisible.
  - a child's cap is **reserved when it spawns** and reconciled against actual usage when it
    finishes. The loop runs tool calls sequentially today, but `parallelTools` is advertised and
    this tool is public API: a gate read before an `await` and written after it is not a gate.
  - because the pool reserves, the CLI gives each child a **share** of the parent's budget
    (`maxTokens / maxChildren`), not the whole of it — otherwise the first subagent would be the
    only one that could ever run.
- **Pool eviction is by last use and never touches a live pool.** Sessions are never announced as
  finished to a tool, so the map is capped (256); evicting the oldest *inserted* entry would
  target the longest-running session and hand it a pool with its limits back at zero.
- **The same permission policy object *and* the same asker.** A subagent that could do more than
  its parent would be a permission bypass with extra steps; a subagent that can do less is the
  failure the first version had — `AgentConfig.onAsk` defaults to deny, so under the TUI a child
  could not write a file, was never prompted about it, and had no way to say why. The child's asks
  now route through the parent's prompt carrying `PermissionRequest.origin = "subagent"`. That is
  set on the child's **`AgentConfig`**, not wrapped around `onAsk`, so the emitted
  `permission.request` carries it too — the prompt, the log, `renderEvent` and `sessions show` all
  agree on who asked. Only whoever builds a session can set it; a tool or a model cannot.
- **The parent's abort reaches the child**, and `subagent.end` is emitted on the abort path rather
  than after the event loop: by the time the loop unwinds the parent has ended and its events are
  dropped, which left a `subagent.spawn` in the log that no `subagent.end` ever answered.
- **The parent logs the child before the child starts.** `Agent.run` takes an optional
  pre-allocated `id` (from `store.create()`) so `subagent.spawn` can name a session that has not
  written anything yet; a trace read in order never shows a session that came from nowhere. Two
  runs appending to one id would restart `seq` and leave a log that cannot be read back at all, so
  a fresh run now **claims** its id for its lifetime (in-process; the resume path's advisory file
  lock covers the cross-process case), and `store.create()` never returns an id it has already
  handed out.
- **The last turn that *said* something is the answer, and a preamble is labelled as one.** Keeping
  only the final turn's text meant a child that stated its conclusion and then made one more tool
  call — normal, and not something a system prompt prevents — reported "the subagent finished
  without a final message". But an opening remark is also text, so when the kept text did not come
  from the child's last turn the parent is told so, rather than handed a preamble as a conclusion.
- The tool is `exec`: a child can do anything its tools can do, so claiming less would let
  `--allow read` run arbitrary writes through one.
- A child that ends on anything but `done` is reported to the parent as an **error**, not as an
  answer, and a child that says nothing is reported as such rather than as an empty result.

### Skills

- **Index-first, like the wiki, for the same reason.** A project may have twenty skills of a
  thousand words each; injecting them all would cost more context than the task. The system prompt
  carries name + description one line each, and the body is fetched through the `skill` tool only
  when the model decides one is relevant.
- **The description is what the model chooses on**, so a skill without one falls back to the first
  heading or line of its body rather than showing an empty entry it cannot reason about.
- `<name>.md` or `<name>/SKILL.md`; a nested skill is named by its **directory**, since the file is
  a fixed marker.
- **The first root wins**, so a project skill shadows a global one of the same name — the order a
  user expects. Shadowing is matched **case-insensitively**, because the `skill` tool looks up that
  way: keeping both `Deploy` and `deploy` advertised two skills and served one body for both.
  A shadowed skill is reported through `onError` rather than silently dropped.
- **What reaches the system prompt is untrusted input, and is treated as such.** A name and a
  description are stripped of C0/C1 control characters *and* of zero-width and bidi formatting
  (U+202E can visually reorder the rest of a line), bounded to 80 / 200 **code points** so
  truncation cannot leave a lone surrogate, and the catalogue as a whole is capped at 8 KiB
  **measured in bytes** — a cap counted in UTF-16 units lets a CJK catalogue through at ~3× what
  it claims. A directory name may contain newlines — enough to
  forge a second `## Skills` section with entries nobody wrote — and a frontmatter `description:`
  may be 60,000 characters that ride in *every* request.
- **Symlinks are not skills.** Discovery `lstat`s and skips them: `skills/notes.md -> ~/.ssh/id_rsa`
  would otherwise put the target's first line into the system prompt of every request, with no
  model decision involved.
- **A subdirectory with no `SKILL.md` is not an error** — `--skills .` on a repo root would
  otherwise report one failure per `.git`, `node_modules` and everything else.
- **The `skill` tool reads only what was already discovered**, keyed by name into a fixed map, so
  there is no model-supplied path to traverse. Bounded by file size and count.
- **Caveat: skills are discovered once at startup.** Editing one mid-session has no effect until
  the next run.
- **Caveat: nothing validates a skill's *body*.** Names and descriptions are sanitized because they
  reach the prompt with no model decision; a body only arrives when the model asks for it, and is
  then shown verbatim. A skill is as trusted as the repository it lives in.
- **Subagents get the skills too** — the `skill` tool and the catalogue — since a child doing a task
  the project has instructions for should be able to load them.

## Standing permission answers (from the first task worth approving, 2026-08-30)

- **Approving every action individually is how a prompt stops being read.** A task that edits
  twenty files raised twenty identical prompts, and the only alternatives were `--allow write
  --allow exec` at startup (all-or-nothing, decided before you know what the task will do) or
  answering all twenty. Both are worse than a prompt that remembers.
- `a` at a prompt allows that **tool** for the rest of the session; `d` denies it for the rest of
  the session, which is how a tool that is misbehaving gets shut off without aborting the task.
  `y`/`n` still answer once.
- **Per tool, not per class or per call.** A class ("allow all writes") grants more than the
  prompt was showing; a per-call grant remembers nothing. The tool name is what the prompt named.
- **In memory only, never written to disk.** A blanket grant that survives the process outlives
  the task it was made for, and nobody remembers making it. `/permissions` lists what is standing
  and `/permissions reset` clears it.
- Caveat: a standing answer applies to a subagent's requests too, since they carry the same tool
  name (with `origin: "subagent"` shown on the prompt). Granting `bash` for the session grants it
  to children as well.

## The TUI held no conversation (from the second interactive run, 2026-08-30)

- **Every prompt started a new session.** `submit` called `agent.run(task)` with no `resume`, so
  nothing the user said was ever in scope for what they said next — three exchanges in a row
  reported `turn 1` and sent 1330, 1335, 1330 input tokens, an input that never grew because no
  history was being sent. A task now continues the current session, and `/new` drops the thread
  deliberately. A session is only continued once a `turn.end` has been seen, because that is when
  the loop writes the snapshot a resume reads: a session that died before finishing a turn (a
  provider rejecting the request, as the live `400` did) has nothing to resume from, and asking
  would lose the next prompt to an error.
- **A bare `exit` was sent to the model.** It spent a turn and 1330 tokens replying "Exiting." and
  then did not exit. `exit`, `quit`, `bye` and `:q` on their own are now the quit command, as in
  every other REPL; inside a sentence they are still ordinary words.

## The output surfaces (from the first real interactive run, 2026-08-30)

- **Neither surface ever showed the model's reply.** The TUI skipped `model.delta` as per-token
  noise and `agentrig run` skipped it for the same reason — and nothing else carries the text, so
  a session that answered a question printed `session.start`, `turn.start`, `model.request`,
  `model.response`, `turn.end`, `session.end` and no answer. The one live run that *looked* like
  it worked only did so because the answer happened to appear inside a `tool.result`.
  `AssistantText` now gathers the deltas and emits them once per turn; the TUI also streams the
  turn in progress live and commits it when the turn ends.
- **The default view is the conversation, not the trace.** `renderChatEvent` shows the reply, what
  the agent did (`⚒ bash pnpm test`), files it changed, plan progress, supervisor signals, errors
  and anything that ended badly — and hides session/turn/model/permission-decision/compaction
  plumbing. `renderEvent` is unchanged and is what `--verbose` (and the TUI's `/verbose`) shows.
  `--json` is untouched: machine consumers still get every event.
- The two views are deliberately separate functions over the same event stream rather than a
  filter over rendered strings, so what a person reads and what a debugger reads can diverge in
  shape without either drifting from the log.

## The first dogfood run, and what it found (2026-08-30)

PLAN §6's exit criterion — "the harness is used to build the next milestone" — was honoured for
the first time: agentrig implemented the caller-declared drift scope, on the drift detector, using
itself. It read the detector, the CLI wiring and the existing tests, made the change, hit a real
cross-package typecheck failure and fixed it correctly by rebuilding the supervisor's declarations
first, then committed and pushed on request.

The review of that work found the change sound — and found two things the work could not have
known about:

- **`--drift-scope` was proven to parse, not to arrive.** Deleting the line that passes it into
  `supervise()` broke no test, because the wiring was inline in `runCommand` and the only way to
  exercise it was to run a whole session. `supervisorOptions()` is now exported and pure, the same
  shape as `subagentOptions()`, and the mutation that drops the flag fails a test.
- **`--supervise` did nothing in the TUI, and never had.** `runCommand` calls `supervise(session)`;
  `startTui` never did. Every detector, the whole ladder, the reviewer and the grader were
  unreachable from the default entry point, while the flags were accepted and validated. The
  dogfood session ran 33 turns with `--supervise` and produced no signal — which was read as
  "the thresholds are conservative" until the code said otherwise. `TuiOptions` did not even
  include the supervisor flags: the type was the first evidence.
  The TUI creates its sessions inside the controller, so nothing outside could attach an observer;
  `TuiControllerOptions.onSession` is that seam, called before the events are consumed — an
  observer attached late has missed the events it exists to judge. An observer that throws costs
  its own attachment and not the session.

The lesson is the one the whole exercise was for: **a flag that is parsed, validated and
documented can still be connected to nothing**, and no amount of unit testing at either end finds
it. Only running the thing did.

## The supervisor, watched doing real work (2026-08-30)

The second dogfood run — the contract watchlist, built by agentrig with `--supervise` actually
attached for the first time. Every rung fired, and each one is now observed rather than inferred:

- **`stall` → `inject_guidance` → the agent changed course.** The steer was delivered and answered
  ("I'm not blocked; I was tracing the shared run/TUI option path"), and file edits started on the
  next turn. Signal to behaviour change, live.
- **`force_replan` blocked a tool call**: `blocked: the supervisor requires a fresh plan before
  more tool calls`. The agent called `update_plan` and continued. The M6 rung works.
- **`error_burst`** fired at 5-of-10 failing calls; **`escalate`** reached the user through the
  TUI's new `onEscalate`.

Three defects the same run exposed, none of which a test would have found:

- **`stall` fires on reading.** Its first signal landed during legitimate orientation — several
  turns of `read_file`/`grep` while mapping unfamiliar code. "No file changed and no new tool
  used" describes research as well as it describes being stuck, and the agent's reply amounted to
  "I am not stalled, I am reading". It was right.
- **`escalate` asks a question nobody can answer.** The TUI prints it and moves on; there is no way
  to reply, and nothing waits for one. A rung whose purpose is to consult a human currently
  consults and ignores.
- **The same signal repeats.** Identical stall escalations at 38, 41 and 58 tool calls on an
  unchanged condition. A ladder that re-fires one rung is noise, and noise is how a supervisor
  comes to be ignored.

## A default that was load-bearing and untested

`--drift-contract` defaults to `undefined`, not `[]` — deliberately. An absent flag must leave
`DriftOptions.contract` unset so the detector's own `DEFAULT_CONTRACT` applies; passing `[]` would
reach it as "watch nothing" and switch the whole feature off for every run that did not name a
path. Changing `undefined` to `[]`, which is the obvious edit for consistency with
`--drift-scope`, broke no test when the feature was written. Both halves of the property are
pinned now: the flag's default, and the detector's fallback.

## "Green" meant Linux (from the first macOS run, 2026-08-30)

Two tests failed on a Mac. Neither was a code defect; both were **Linux assumptions in the test
scaffolding**, written by someone who only ever ran the suite on Linux and reported it green.

- **`mcp-process.test.ts` read `/proc/<pid>/stat`.** macOS has no `/proc`, so its liveness helper
  returned "gone" for every pid: the pre-condition ("the grandchild is running") failed, and the
  post-condition ("it is gone after close()") passed **for the wrong reason**. A test that cannot
  pass on a platform is bad; one that also passes vacuously there is worse. It now falls back to
  `kill(pid, 0)`, which cannot see a zombie — hence the existing poll.
- **The shell test compared `/bin/bash` against `/bin/sh`.** That only demonstrates anything where
  `/bin/sh` is dash. On macOS it is bash in POSIX mode and runs `[[ ]]` happily, so the assertion
  failed for a reason unrelated to the code. Replaced with a **stub shell script** the test writes
  itself, asserting the command arrives as `-c <command>` — deterministic on every platform, and
  a stronger claim than the original.
- **`groupIdOf` also read `/proc`,** so every assertion guarded by `if (group !== null)` was
  skipped on macOS — passing without testing. It falls back to `ps -o pgid=`.
- **CI now runs the matrix** (`ubuntu-latest`, `macos-latest`) on push and PR. There was no CI at
  all before this: every "green" in this repo's history was one person running one platform.
  Windows is follow-up **F3** — the suite's POSIX assumptions would make that job red on arrival,
  and skipping the failures to get it green would produce a job that tests nothing.

## Windows notes (from the first real desktop run, 2026-08-30)

- **CRLF was a silent edit-breaker.** `read_file` and `grep` split on `\n` only, so on a CRLF
  checkout — every clone on Windows — each line reached the model with a trailing carriage return
  (`"1\t# AgentRig\r"` in a live trajectory). The model then copies what it was shown into
  `edit_file`'s `oldText` with plain `\n`, which matches nothing in the file, and *every*
  multi-line edit fails with "oldText not found". Both tools now split on `/\r?\n/`, and
  `edit_file` retries a failed match with the line endings converted — in both directions —
  converting `newText` the same way so the file keeps the endings it had. An edit must not
  rewrite every line of a file as a side effect of matching one.
- **The `bash` tool ran `cmd.exe` on Windows (fixed — F2).** `spawn(..., { shell: true })` means
  `/bin/sh` on POSIX and `cmd.exe` on Windows, and a model writes bash — so on Windows every
  command went to a shell that does not speak it, and the model was never told which one it had.
  `resolveShell` now picks it and `--shell` overrides it:
  - **POSIX keeps `/bin/sh`.** Changing it would silently change what every existing trajectory in
    every repo means. `--shell /bin/bash` is there for anyone who wants bashisms — and `[[ ]]`
    really does fail under `/bin/sh` (dash), which is the same class of bug as `cmd.exe`, milder.
  - **Windows prefers Git Bash, then PowerShell, then `cmd.exe`** — the first speaks what the model
    writes, the second is at least a real shell, the third is the status quo.
  - **The description names the shell and the syntax**: "using bash.exe … Write POSIX shell
    syntax", or "using cmd.exe … Write cmd.exe syntax (`dir`, not `ls`; `%VAR%`, not `$VAR`)".
    Half the fix is picking a shell; the other half is telling the model which one it got.
  - The tool is still called `bash`. Permission rules and every trajectory ever recorded name it,
    and renaming it would break both to fix a label.
  - `--shell` is validated once at build time — a path that does not exist is refused by name,
    rather than failing on every command with an ENOENT that names neither the flag nor the file.
  - Caveat: `resolveShell` takes the platform as a parameter, so it must not use `node:path`'s
    `basename`/`sep`, which follow the *host*. It parses both separators itself; the first version
    did not and mis-classified every Windows path when run from POSIX.
- **Process-group kill degraded to killing one process (fixed).** Timeout and abort called
  `process.kill(-pid)`, which Windows does not support: it threw, and the fallback killed only the
  direct child — so `cmd.exe` died and whatever it started kept running, holding the stdio pipes
  past the timeout that was supposed to end it. Windows now uses `taskkill /pid <pid> /T /F`, and
  the child is **not** spawned `detached` there: on Windows that means "survive the parent, in a
  console of its own" — a flashing window per command and a child that outlives the session — with
  no process group to gain, since Windows has none.
- **The token file was not ACL-protected (fixed).** `chmod(0o600)` only toggles the read-only bit
  on Windows. `FileTokenStore` now runs `icacls <path> /inheritance:r /grant:r <user>:F` after
  writing, best-effort: a credential that could not be locked down is still a credential the user
  needs, so a failure warns once — naming the command to run by hand — rather than failing the
  login. **Unverified on real Windows**: the branch is unit-tested with an injected runner, the
  `icacls` call itself has not been observed to succeed.

## --yolo / --dangerously-skip-permissions (2026-08-30)

Asked for after a dogfood run in which the agent's first move, `git fetch origin main`, was denied
twice — standing answers (`a`) help once you are asked, but not before the first prompt of every
kind, and not at all unattended.

Implemented as the RulePolicy **fallback**, not as a switch that bypasses the policy:

```
[ ...--deny, ...--allow, ...memory tools, ...defaultRules ]   fallback: skip ? allow : ask
```

Order is the whole design. `--deny` is matched first, so it still wins under `--yolo`: skipping the
prompt is not the same as discarding a rule you asked for, and `--yolo --deny bash` has to mean
something. Skipping changes only what happens to a request nothing matched — `ask` normally,
`allow` here — so it can never overturn an earlier decision.

Notes for a future reader:

- **Two spellings, one meaning.** `--dangerously-skip-permissions` says what it does, `--yolo` is
  what people type. Both are read through `skipsPermissions()` rather than checked individually, so
  a caller cannot honour one and miss the other — a mutation that drops the alias fails five tests.
- **The warning names the working directory.** "Permissions are off" is abstract; "it may delete
  anything outside /Users/you/project" is not. It also lists any `--deny` still in force, or the
  warning would be actively misleading.
- **It stays auditable.** `permission.request` and `permission.decision` are emitted for every call
  regardless of how it was decided, so a run that asked nothing still reads back completely in
  `agentrig sessions show`. That was already true; it is what makes the flag defensible.
- **Subagents inherit it**, because parent and children share one policy object — a child that
  could do more than its parent would be a permission bypass with extra steps, and the same
  reasoning makes a child that must ask when its parent need not merely annoying.
- **No root check.** Refusing to run as root is a common guard, but every container runs as root
  and that would break the main unattended use case. The warning is the guard.

## A multi-line paste sent only its first line (2026-08-30)

Found the first time a multi-line brief was pasted into a TUI where pasting finally worked. The
handler submitted at the first newline and joined the remainder with spaces:

```
Fix three defects in the supervisor that a live dogfood run exposed.
BRANCH FIRST. Run `git fetch origin main` then ...
a turn is already running — /abort first
(1) packages/supervisor/src/detectors/stall.ts fires on legitimate reading. ...
a turn is already running — /abort first
```

The agent got one sentence as its whole task and set about searching memory and grepping the tree
to work out what the three defects were. Every following line arrived while that turn was running
and was refused.

The rule was written when an embedded newline could land in the buffer literally and corrupt a
line, and submitting at the first one was the cautious reading. It is the wrong one: a newline
*inside* a chunk is pasted text, and enter arrives as a chunk of its own — which is how every
other terminal UI tells them apart. A paste is now kept whole, line breaks and all, and enter
submits it. `\r\n` is normalised to `\n` on the way in.

This only became reachable once pasting worked at all, which is why five rounds of paste fixes
preceded it: the freeze, the frame height twice, the pty deadlock, and then this. Worth noting for
the next time a fix "completes" a feature — the bug behind it may simply never have been reachable
before.

## The paste freeze was a pty deadlock, and neither earlier fix touched it (2026-08-30)

Two merged fixes later the TUI still froze on a paste in cmux on macOS, with ctrl-c dead. A probe
that renders the real component in a real terminal and traces every stdin read and stdout write
synchronously (`packages/cli/scripts/frame-probe.mjs`) settled it. At 158x52:

```
+22939ms read#1  len=64    total=64
+22940ms write#5 len=144   total=13589
+22940ms read#2  len=1016  total=1080
+22949ms write#6 len=1166  total=14755
                      <- nothing, ever
```

`%CPU 0.0`, `STAT S+`, and the 500ms heartbeat stops dead after `write#6` is logged — and that log
line is appended *before* the write is forwarded. So the process is asleep inside a 1,166-byte
blocking write to the tty, with 1,080 of ~2,242 pasted bytes delivered and the rest never arriving.

Node's writes to a TTY are synchronous on macOS. The peer was blocked writing the rest of the paste
into the pty's input buffer — because this process had stopped reading in order to service a
render — while this process was blocked writing its output, because the peer was not draining that
side. Both sleep forever. Ctrl-c does not help: in raw mode ctrl-c is a byte on that same stalled
stdin, not a signal.

**Total output involved: 1,310 bytes, and zero full-screen clears.** The frame height was never the
cause of this one. The two earlier fixes were real — the byte counts behind them stand, and a
frame taller than the window genuinely costs a full repaint of the whole scrollback per render —
but they were fixing a different problem, and no amount of shrinking a frame avoids a deadlock that
needs about a kilobyte to trigger. Nor could any fake-TTY test have caught it: the harness has no
pty, and a fake stdout never blocks.

The fix is `packages/cli/src/tui/input-buffer.ts`: the buffer is the truth and moves synchronously,
and drawing waits for stdin to go quiet (32ms). A 31-chunk paste now draws once, at the end, and
writes nothing while the terminal is still pushing input. Submitting a line still draws
immediately, because the prompt has to clear before the reply starts.

Notes for a future reader:

- **There is deliberately no maximum wait on the coalescing.** A ceiling would guarantee a write in
  the middle of a long enough paste, which is exactly the thing being avoided. Input that never
  pauses is input nobody is reading yet.
- **The first version of this fix blinded the TUI completely.** The edit that introduced
  `InputBuffer` spliced out `useEffect(() => controller.subscribe(setState), [controller])` along
  with the code it was replacing. The App kept accepting input and the agent kept running — the
  session log showed the model planning and reaching a permission prompt — but nothing the
  controller printed ever reached the screen: no echo of the task, no status change, no permission
  prompt, no streamed reply. Pressing enter looked like it did nothing at all.

  Every existing test of this component passed. All of them count bytes — how many writes, how
  large, whether a full-screen clear appears — and a component that renders a frame nobody has
  told anything to still writes frames. `test/tui-visible.test.ts` asserts on CONTENT instead:
  that a printed line, a permission prompt and the session id actually appear in what reaches
  stdout. Removing the subscription fails all three and none of the twelve byte-counting ones.
- **The first version of it still wrote mid-paste, on the most ordinary paste shape there is.**
  Submitting drew synchronously, on the reasoning that stdin had just gone quiet. It has not: a
  newline *inside* a paste submits from the middle of an arriving burst, and a bare carriage
  return can be drained in the same batch as the text ahead of it. One newline in a 120-chunk
  paste produced 11 writes and 1,141 bytes with chunks still queued — the byte volume of the write
  that deadlocked. Both submit paths now queue their work to the same quiet point, after the draw.
- **The claim holds only at an idle prompt.** Pasting while a reply streams — queueing a follow-up,
  entirely routine — still writes, because the output is not the paste's to control. That is
  inherent to an async stream rather than a hole in this fix, but it is not "nothing is written
  while a paste is arriving" either.
- **Keystrokes must not push the deadline out.** Resetting the timer on every change starved input
  arriving faster than the window: measured at 15ms and 25ms and 30ms intervals, zero draws for as
  long as the input continued. Human typing is nowhere near that, but macOS key auto-repeat is
  15ms at the fast end of the slider — holding backspace froze the prompt until the key was
  released. A change of four characters or fewer now leaves the existing deadline alone.
- **Confirmed on the machine that had the bug.** The same ~2,500-character paste that froze cmux
  three times now lands, drawn as its tail with a `…(1,142 more)` marker, and submits in full.
- **This is a mitigation for an environment bug, not a repair of one.** A terminal that drains its
  output side while writing input does not deadlock. What agentrig controls is whether it writes at
  all mid-paste, so that is what changed. It has not been reproduced in a test, and cannot be
  without a real pty and a peer that stops reading; the end-to-end test asserts the property that
  closes the window (no writes until the chunks stop), not the deadlock itself.
- **Three wrong diagnoses preceded this one**, each plausible and each measured: bracketed paste
  (ruled out — the first 24 bytes were plain text), frame height (real, fixed, not this), and a
  stalled Node stream (ruled out by the heartbeat: `readableLength=0`, `isPaused=true` — nothing
  was waiting to be read, the reader was simply never going to run again).
- **The probe is kept.** It is the only instrument that can see any of this, and a sampling version
  of it saw nothing at all — a timer never fires on a blocked loop, which is why the first version
  logged one line and stopped.

## The paste fix was half a fix — the review found the other half (2026-08-30)

The adversarial review of the fix above found three majors. All three are now fixed; the section
above describes the mechanism, this one what it got wrong.

**The budget counted characters, and a reply is mostly line breaks.** `fitToRows` multiplied
columns by rows and compared that to `text.length`, which is the same quantity only for text with
no line breaks in it. An answer made of bullets and code — the shape almost every real reply has —
measures far more rows than characters/columns suggests. A **1,625-character** reply of short
lines measures 155 rows, drove 40 full-screen repaints and 699,389 bytes; flattening the same text
to one line: 0 repaints, 31,059 bytes. So the freeze was unfixed on the more common of the two
paths, and the one test covering it streamed `"answer ".repeat(500)` — a single long line with no
newline in it, the one reply shape a character budget happens to handle. The budget is now rendered
rows (`measureRows`), measured in display columns via `string-width` — the same measure Ink uses —
so wide characters count as two.

**`liveRows` budgeted one growable region and the frame draws two.** With a reply streaming *and*
something typed, the frame is `2 × liveRows + 3`. Every terminal from 12 to 20 rows — a tmux pane,
a split editor, VS Code's integrated terminal at its default height — still froze exactly as
before. The allowance is now halved (`(rows - 6) / 2`), and the test asserts the condition the
frame actually has to satisfy rather than restating the furniture count.

**The regression guard could not fail on CI, which is the only place it runs.** Ink checks
`is-in-ci` *before* the frame-height branch in `onRender` and returns having written only the
`<Static>` output. GitHub Actions sets `CI=true` on every step. Reverting the fix entirely and
running `CI=true pnpm test` left all four frame tests green. `test/setup-no-ci.ts` now clears those
variables before any test file imports Ink — a setup file, because `is-in-ci` computes its value at
module load and `vi.stubEnv` inside a test is too late — and one test asserts the setup ran, so the
guard is itself guarded.

Two pre-existing bugs surfaced in the same pass, both confirmed identical on the commit before any
of this work and both fixed here:

- **The TUI went silent for good at the 5,000th line.** `print` did `lines.slice(-maxLines)`, but
  Ink's `<Static>` remembers how many items it has written and renders `items.slice(thatIndex)`.
  Dropping items off the front shifts every index past what it remembers, and nothing is ever
  printed again — no error, no clue. The array is now append-only; the cap releases the *text* of
  a line that falls out of the window, which `Static` never reads again, so memory is still bound.
- **A paste ending in a newline lost a chunk.** Ink drains several stdin chunks in one `readable`
  batch and React does not update state between them, so the submit paths that read the `input`
  state variable saw a stale buffer: pasting 2,500 characters ending in `\n` submitted 2,436.
  The buffer is now a ref, which moves synchronously; `input` exists only to trigger a re-render.

Smaller things from the same review: the "(N more)" count under-reported by the marker's own width
(now derived from what was actually kept); the marker could be returned wider than a one-row
budget in a very narrow window; and `columns ?? 80` let a TTY-reported **zero** through, collapsing
the budget to one character per row so the user saw the marker and none of what they had typed —
Ink's own layout uses `||` for exactly this reason.

## The TUI froze on a pasted brief (2026-08-30)

Pasting a ~2,500-character task into the TUI hung it, twice, on a terminal that was otherwise
responsive. It is not the paste handling: it is how tall the frame is.

Ink has a cliff in its renderer. While the live frame is shorter than the window it redraws
incrementally through `log-update`. The moment `outputHeight >= stdout.rows` it gives up on that
and writes `clearTerminal + fullStaticOutput + output` instead — a full-screen clear followed by
the **entire** accumulated `<Static>` scrollback, which Ink appends to and never trims. So a tall
frame does not cost one big paint. It costs one big paint per render, and the paint grows with how
long the session has been running.

Two things in the frame grow without bound and are drawn live: the input buffer and the reply as
it streams. A 2,500-character line wraps to ~32 rows at 80 columns, which is taller than most
windows; a paste arrives at a raw-mode tty as a run of chunks, and each chunk is one `useInput`
call, one `setInput`, one render.

Measured with the real `App` against a fake 80x30 TTY, a 2,500-character paste in 64-byte chunks:

| scrollback | before | after |
| --- | --- | --- |
| 300 lines | 40 repaints, 192,596 bytes | no full-screen repaints, ~27,000 bytes |
| 2,000 lines | 40 repaints, 962,196 bytes | unchanged from the 300-line case |

An 80-character paste cost 267 bytes either way — the blow-up is entirely the cliff.

The fix is `packages/cli/src/tui/viewport.ts`: `fitToRows` draws the tail of a growable region and
says how much it is not showing, `liveRows` decides how many rows one region may claim (a small
fraction of the window, since the prompt, the status line and a permission prompt share the frame
and the cliff is a property of the frame as a whole). Nothing is truncated in the buffer — it is a
viewport, not an edit; the full text is still what gets submitted.

Notes for a future reader:

- **The streaming reply was the worse half.** A pasted brief is unusual; a multi-thousand-character
  answer is an ordinary reply, and it arrives token by token, so the tall frame was fully repainted
  once per delta for the whole turn. That is most of why the TUI felt slow before any of this was
  understood, and `--verbose` made it worse by growing the scrollback that each repaint reprints.
- **`app.tsx` is no longer untestable.** Its header used to say there was nothing in it worth
  testing. How tall it renders is a correctness property, so `packages/cli/test/tui-frame.test.ts`
  mounts the real component against a fake TTY and asserts on the bytes that reach stdout — the
  presence of a full-screen clear in a write *is* the pathology, so that is what it looks for.
- **`fitToRows` counts characters, not display columns.** A wide-character or emoji-heavy line can
  therefore wrap one row further than the budget assumed. `liveRows` leaves eight rows of headroom,
  which absorbs it; a `string-width` measure would be exact and is not worth the dependency yet.

## Next: the R-milestones (2026-08-30)

M0–M7 are done and merged. What comes next is `docs/ROADMAP.md`: fifteen R-milestones distilled
from studying six open harnesses (Codex CLI, pi, DeepSeek Harness, Hermes Agent, OpenClaw,
nanobot), ordered by dogfood leverage — context/config first, context economy (R1.5, added after the first --yolo dogfood run spent 3.3M input tokens on quadratic resends), sandbox, session
trees/checkpoints, then the compounding loop (extensions, memory→skills, scheduler), then the
serve/eval/parallel surface. The roadmap carries its own renunciation list (§4) so future
sessions don't build the gateway/web-UI/marketplace features the research argued against, and it
resolves both PLAN §8 open questions (R2 sandboxing, R4 checkpoints). A second, independent
research pass over a different corpus (OpenHands, SWE-agent, Aider, Gemini CLI, Cline, Goose,
OpenCode, the orchestration runtimes) was merged in afterwards: it validated the build order and
the memory-promotion gate from the other direction, hardened R1/R3/R5/R10 (trusted-project
boundary, doctor, side-effect-aware replay, tool-definition pinning, worktree-per-writer), and
contributed the closing trust-and-proof arc — R12 capability grants, R13 provenance labels, R14
acceptance contracts with claim→evidence grading.

## Decided

- Lore is an optional `MemoryBackend` behind the seam in PLAN.md §3.8; the wiki stays the source
  of truth and the default stays no-infra (milestone 3b).
- AgentLens is a future sink for the event stream (observability), not a memory dependency.

## Follow-ups (PLAN.md §9)

Recorded rather than built, each with a working path in the meantime:

1. ~~**F1 — PKCE + loopback login for `openai-chatgpt`.**~~ Built (2026-08-30) — see below.
2. ~~**F2 — a configurable shell for the `bash` tool.**~~ Built (2026-08-30) — see below.

## Open questions (from PLAN.md §8)

1. Sandboxing: none + allowlists for v1, Docker later
2. Git-based checkpoint rollback: opt-in or assumed
3. Dogfood repo after AgentRig itself
