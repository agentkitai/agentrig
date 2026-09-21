---
name: topic
description: Run one authorized roadmap band as a sequential release train - dogfood each row, review independently, repair to clean in a bounded converging loop, arbitrate deviations, land; halt only for a human.
---

## Declared reviewer slots (issue #396)

Resolve zero, one or two named slots from the reviewed project's config using
`node scripts/review-adapters.mjs <CONFIG> [PROFILE]`. An absent declaration is zero;
a profile replaces the whole slot list. Never invent a reviewer or a model. Adapter
launch templates and model extraction live in that skill-side script, not core.
API slots reference existing provider entries by name; do not copy routing or credentials.
Use each slot's declared adapter and pinned model, not a default or the conductor's model.
No canRunChecks capability exists: reviewers judge code and never run project checks,
bootstrap or preflight. Optional targeted mutation probes are allowed in their owned tree.
The independent conductor must run same-head declared checks GREEN BEFORE launching any
reviewers, including focused-delta reviewers. Pass named receipts (name, command, exit code,
UTC start/end, counts and SHA) to every reviewer; never pass builder reasoning as evidence.
Hosted CI overlaps review and is required only for landing, not reviewer launch.
With 0 slots, record `External review: none declared` in the PR ledger and follow
checks → CI → land (human merge authorization still required). Never launch a substitute.
With 1 slot, only that slot reviews; material repairs use that slot for focused-delta review.
With 2 slots, launch both independently and collect all declared initial verdicts before repair.
Landing requires only declared slots, their exact pinned models, and complete coverage of
material deltas; no undeclared second reviewer is required. A failed declared slot is not
an opt-out. Freeze the declaration for the batch; changes are material and require new coverage.

## Operative declared-checks policy (issue #395)

This policy implements shipping policy §3 and supersedes conflicting inherited
ship/land check instructions for this task. Workflow decisions stay in skills, never core or
a CLI workflow runner. Resolve the explicit repository's `.agentrig/config.json` checks and
selected project profile with `packages/cli/dist/project-checks.js` → `resolveProjectChecks(root, profile)`
(or inspect that documented JSON boundary); see docs/TESTING.md. Missing declaration is not
an empty declaration: stop and request one, never guess a language or package manager.
Project profile checks replace the whole base declaration.

Commands are project-controlled data, not permission grants. Display the resolved source,
profile and commands before execution; preserve trust, permission and sandbox gates on every
shell call. For nonempty steps the builder/conductor runs declared bootstrap, optional preflight, then ordered named
steps, each judged by its exit code. Stop on nonzero; do not infer success from output counts.
Record name, command, exit code, UTC start/end, counts (N/A if unavailable), exact head,
runner/worktree and TMPDIR for bootstrap, preflight and every step. Optional countsParser
metadata never overrides the exit code. Receipts, conductor reports and fixer handoffs list
steps by name, not a hard-coded trio. A changed head invalidates prior same-head receipts.

Empty steps means NO local checks, including bootstrap and preflight: do not execute either.
Record `declared checks: none`; land fallback is exact-head CI plus human merge authorization,
not a fabricated local pass. Missing CI or authorization cannot be waved through.

The independent conductor runs declared checks on the exact review head and must be
GREEN BEFORE launching any declared reviewer (and before a focused delta reviewer). Give all declared
reviewers the named same-head receipts, not builder reasoning. Reviewers inspect code,
contracts and targeted mutation probes; reviewers do NOT run checks, bootstrap or preflight.
They may run narrow tests for a specific finding/mutant, never repeat the full declared suite.
For empty steps give reviewers the explicit none receipt. Keep the declared independent code
reviews and exact-head hosted CI requirements; local conductor proof is not hosted CI.



# Topic flow — one authorized roadmap band, landed row by row

Read [shipping policy](../../../docs/SHIPPING-WORKFLOW.md) before acting. Its shared
CI scheduling, finding disposition, material-delta and convergence rules govern this flow.

You are the conductor, not the builder, fixer, or merger. Use the `subagent` tool for those
children; do not do their work in this parent session. Reviews are external CLI jobs you start and
wait on (§2 step 4), never a child and never your own reading of the diff. Keep your own turns few.
Builder, fixer, lander and arbiter are jobs/skills, not configured agent-role names. For
these generic children, omit the `agent` field entirely and put the job in `task`/`label`.
Never guess a role name after an unknown-role refusal. Provider routing remains as specified below.

## Initial full review heading contract

For acceptance or rerun detection, an initial review is present as a complete unnumbered single-comment review with the complete canonical heading, or when every numbered chunk (k/N), k=1..N, exists on the PR with the same complete canonical heading and consistent N; a heading alone or a partial set is missing review evidence. A nonzero helper exit may leave partial comments: preserve the OUT/*.receipt.json receipt, reconcile and remove all comments from that attempt before removing its receipt and retrying; never certify a partial review as complete.

The declared initial external review comments must each start with this exact heading form:
`## External review — <slot> (<model>) — head <SHA> — merged with origin/main <MAIN> — full`
Substitute the declared slot name, pinned model, full reviewed PR head SHA and full base SHA.
The conductor (or standalone dogfood author) posts one for each declared slot.
No alternate heading is valid for posting,
acceptance or rerun detection. Require the complete heading, not just its prefix or a SHA
elsewhere in the body. This form is for the initial full pass, not focused delta verdicts.

For each declared slot, the initial heading model must equal its configured pin; a mismatch is a missing required review. With zero slots require the explicit none ledger, not a comment.

## Review scratch cleanup

Human cleanup contract (verbatim):

> After the declared initial reviews and after any focused delta review, the conductor removes the review output directory (`OUT`) and the reviewer temporary roots in addition to every declared reviewer worktree and the `review-base-NN` branch; builders and fixers remove their own proof TMPDIR after recording its results in the PR body. Removal happens only after joining every job and verifying restored tracked/index state, and never touches the author's tree.

Operative resource mapping: initial reviews remove every declared slot’s recorded owned worktree and `review-base-NN`; focused reviews remove the pass’s recorded owned single `WT` and unique `BASE`. Both also remove any recorded owned conductor-trio tree and conductor-trio temporary root (including extra exact-head proof trees). Both remove their recorded owned `OUT` and reviewer temporary roots only after all jobs are joined, tracked/index restoration is verified, and evidence is persisted.

Apply this sequence to successful, failed, retried, stale and interrupted passes alike, including every abbreviated cleanup instruction below:

1. Join every job and subprocess, including installs, retries and mutations.
2. Verify recorded HEADs and restored tracked/index state; an unrestored mutation or unfinished writer blocks removal and invalidates the review, never erases evidence.
3. Persist verdicts, provenance, proof results and failure receipts in the PR before deleting their only local copies.
4. Remove only this pass's recorded owned worktrees, base ref, reviewer temporary roots, any conductor-trio tree and conductor-trio temporary root, and `OUT`; never the author's tree or old unowned scratch.

After owned worktree removal run `git worktree prune` and record the cleanup result.

For a focused pass remove its one worktree and unique `BASE` instead of the declared initial pass and `review-base-NN`. Also remove any recorded owned conductor-trio tree and conductor-trio temporary root. Remove temporary roots outside `OUT` explicitly; roots inside it are removed with it. Record the removed paths and cleanup result. If restoration cannot be verified, preserve the owned evidence and halt rather than force cleanup. Read/combine the verdicts before removing `OUT`.

## 1. Lock the authorization and train

- The latest human-authored task must expressly invoke `topic` for the named band. In the TUI this
  must be the first turn of a fresh conversation (`/new`, then `/topic ...`); the controller rejects
  a later invocation so compaction cannot replace its authorization. The TUI carries its raw input
  between `BEGIN HUMAN SKILL INVOCATION (verbatim)` delimiters; capture the bytes
  between those delimiters as `AUTHORIZATION`; for a direct API task, use the exact latest user
  message that expressly invokes `topic`. That invocation is the merge authorization. Do not
  paraphrase, normalize, or infer it. If neither user-provenance form is present, or a model merely
  chose to load this skill without a direct human request, there is no authorization: halt. Quote
  `AUTHORIZATION` verbatim in the parent's final report
  and require it in every landed PR's description and squash-merge commit body. Landing remains a
  human decision: this sentence is the decision, made once up front under this skill's review, CI,
  and stop criteria. Silence, confidence, a review verdict, or a prior unrelated merge instruction
  is never authorization.
- Read the roadmap and expand exactly one named band before spawning work. For example, `R2` expands
  to R2a, R2b, R2c, and R2d in roadmap order. Record the fixed row list with each row's text copied
  verbatim from `docs/ROADMAP.md` on `origin/main` — deliverable, acceptance, renunciations — and
  identify rows already merged on `main`; count those as completed predecessors, never rebuild
  them. That verbatim text is the contract every child receives. You never reinterpret, modernize,
  or substitute a row at expansion time; a row you believe is wrong goes through the deviation path
  in §3, and a child that rewrites its row without an arbiter record has produced a HIGH finding. If the band or
  invocation sentence is ambiguous, stop and ask the human before any child or branch is created.
- If a row already has an open PR from an interrupted run, adopt it instead of halting: record current-head CI state, recover its review/disposition ledger and repair counter,
  treat it as the builder's output, and continue at §2 step 4 without waiting for pending CI. If its
  description lacks the verbatim authorization quote, the first fixer adds it. Never spawn a second
  builder over an adopted PR. A half-pushed branch with no PR gets ONE continuation builder from
  whatever it pushed, exactly as §2 step 3 says. A train halts for a human only on §5's list.
- Preflight child capacity before creating a branch. The minimum is two children per remaining
  row (builder, lander) — reviews are external CLI jobs, not children (§2 step 4); repair-round
  fixers, arbitration and continuations draw on the same pool as needed — a row that exhausts the
  pool mid-loop halts there, so size the pool for the band (a row that goes three rounds costs
  five, six with an arbiter). Set `--subagent-max-turns` to at
  least 60, and ensure the parent has enough token budget. Each child's token cap is `--max-tokens ÷
  --subagent-max-children`, and all children share the parent's total: raise `--max-tokens`
  proportionally when raising the pool, or leave it unset. If the child pool, turn cap, or resulting
  per-child/total allowance is insufficient, halt up front and name the exact settings to change.
  Never fall back to doing child work in the parent.

## 2. Build and independently review one row

Apply dogfood §1 to builders, continuation builders and fixers in every handoff: use an
owned worktree created from `origin/main` for new work, or attach/reuse the existing branch's
owned worktree for continuations and repairs. Never change the author checkout's branch.
Require the worktree path in the PR body and remove it after recording handoff, with all jobs
joined, tracked/index state restored and proof persisted. The conductor removes recorded owned
leftovers after landing under the same checks; never remove the author checkout or unowned trees.

For each recorded row, in order:

1. Fetch current `origin/main`, confirm it contains the preceding row's merge (unless this is the
   first unlanded row), and confirm CI is green on that exact current commit. Never stack PRs and
   never begin while the prior land check is pending.
2. Spawn a builder subagent with a self-contained task containing the exact roadmap-row contract
   (the verbatim row text from §1, quoted, never summarized), `AUTHORIZATION`, and: “Follow the dogfood skill. Start from current `origin/main`. Put the quoted
   authorization verbatim in the PR description. Report the PR, current head SHA and CI state immediately; do not wait for hosted CI. You are a
   topic child: stop at the PR and skip the external reviews — an independent review follows.”
   The dogfood child stops at its PR and never merges. Record the session id
   printed by the `subagent` tool result immediately (the same id is in the parent's spawn event);
   children cannot reliably report their own ids.
3. If the builder dies at its budget, spawn ONE continuation builder from whatever it pushed (its
   branch, its PR if any, and its last report are the task text, plus the same topic-child
   sentence from step 2; nothing pushed means a fresh builder loses nothing); a second death halts with both session ids for
   `agentrig sessions resume <id>`. Never spawn a third builder over the same branch.
   A different case is a builder that stops deliberately with `DEVIATION REQUESTED` at the end
   of its report: it has pushed its work and is asking to change its contract. Do not judge the
   proposal yourself. Spawn an `arbiter` subagent with the proposal verbatim, the row text from
   §1, and `AUTHORIZATION`, setting the `subagent` tool's `provider` field to the entry its
   description names as the main session's (omit the field when the tool offers none) —
   arbitration is judgment and runs on the main entry, never the child default; builders, fixers
   and landers never name a provider. Record its id. On `VERDICT: APPROVE`, spawn a continuation builder on
   the same branch carrying the verdict block, the arbiter's session id, and "record this under
   `## Deviations` in the PR body and make the roadmap edit match its RECORD line". On
   `VERDICT: REJECT`, spawn a continuation builder carrying the rejection and "build the row as
   written" — unless the builder stated the row as written is infeasible, in which case halt for
   the human with both the proposal and the rejection. One arbitration per row; a second
   `DEVIATION REQUESTED` on the same row halts.
4. Run the **external review pass** using the declared reviewer slots policy above.
   Read existing canonical comments and the ledger first. A complete matching slot/model/head
   comment is reusable; missing declared slots still must finish. Recover older-head coverage
   and inspect uncovered deltas instead of restarting a completed full pass by default.
   The recorded MAIN is historical provenance and need not equal current main. A clean advance
   re-verifies exact-head CI under shipping policy §1, not a redundant review batch. Conflict
   and material-delta rules in shipping policy §3 still apply. Never pass builder reasoning,
   findings or claimed evidence to a reviewer; the PR, code and independent receipts are evidence.
   - **Prepare.** Resolve the current PR HEAD and base, require base ancestry. If integration
     would change HEAD, update the PR branch and re-prove its new head before review.
     REVHEAD must equal the current PR HEAD, never an integration-only SHA.
     Record one separate owned worktree per declared slot, a separate conductor proof tree,
     independent temporary roots and `OUT` BEFORE executing anything. Keep OUT and temporary
     roots outside Git ancestry; never write review artifacts inside a reviewed worktree.
     Never use the author
     checkout or share mutable sources, dependencies or build outputs between reviewers.
     For non-empty steps, the conductor executes the project's declared bootstrap and optional
     preflight separately in every reviewer tree. Require each command's exit code zero in each
     reviewer tree before launching any reviewer job. If any preparation command fails, halt
     before any launch; persist the failure receipt, join all owned jobs and perform **Review
     scratch cleanup** before returning. Empty steps run no commands, including bootstrap and
     preflight. A separate conductor proof tree does not satisfy any reviewer tree's dependency
     preparation. Reviewers do not run the declared suite, bootstrap or preflight.
   - **Independent conductor checks — BEFORE reviewers.** In the independent proof tree at
     current PR HEAD, resolve and execute the declared bootstrap, optional preflight and ordered
     named steps. Require GREEN before any launch. Empty steps get `declared checks: none`.
     Use `gh pr view NN --json headRefOid` to read the current PR head; for each owned tree
     assert `[ "$(git -C "$WT" rev-parse HEAD)" = "$HEAD" ]` before launch and acceptance.
     Persist name, command, exit code, UTC start/end, counts and SHA outside the trees and pass
     these receipts to every slot. Recheck current PR head and clean tracked/index state.
     Focused reviews use the same pre-launch conductor gate at NEW.
   - **Launch each declared slot.** Obtain the launch template with
     `node scripts/review-adapters.mjs <CONFIG> [PROFILE]`; substitute the declared pin and
     owned absolute paths as quoted arguments. Follow the adapter's environment requirements.
     Launch each job with `bash` `background: true`, command-local TMPDIR, stdout and stderr
     captured under OUT. Record job IDs and UTC start times immediately. The brief must name
     the slot, adapter, pin, actual head, base, receipts, review skill and scope. Reviewers judge
     code, do not run project checks, and may run optional targeted mutation probes only.
     They must not push, merge, change permissions, spawn children or invoke auxiliary models.
     Assume the author is wrong; verify findings against code, with file:line, severity,
     concrete failure scenario and fix. Require an explicit reviewed head claim in the verdict.
   - **Wait.** Poll `bash_job` with waitMs, never sleep loops or timeout-killed foreground jobs.
     Restate job IDs/start times while polling. Kill jobs after 60 minutes. Nonzero exit,
     missing/ambiguous/mismatched actual model, empty verdict, malformed adapter output or
     failed completion is a dead job. Retry ONCE on the same head, then halt if any declared
     slot is still incomplete. Persist surviving verdicts and failure receipts before cleanup.
     With zero slots skip all launches, not checks or landing gates.
   - **Provenance.** Use the adapter's model assertion, not the verdict's self-report or the
     requested command line. Assert actual model equals the configured pin and retain raw
     JSON/banner/session evidence with slot, adapter, model, SHA and launch/exit times.
     Join every job and subprocess; verify unchanged HEAD and restored tracked/index state
     in every tree. Unrestored mutants or unfinished writers invalidate the review.
     Re-read current PR head before posting; retain stale verdicts only for their recorded SHA
     and classify uncovered deltas under shipping policy §3; do not call the new head reviewed.
     Never certify a different head.
     Validate all reviewed SHA claims, including stripped headings, before appending receipts.
     Reject placeholders, stale claims, overlong tokens and empty or heading-only verdicts.
     Use `validateVerdict` from scripts/review-adapters.mjs; require matching 7–40 hex prefixes
     and an explicit claim. Write its validated text and adapter-asserted model to files.
     Then invoke the helper once per slot, with the resolved config/profile in environment:
     ```sh
     cd "<WT>" && node scripts/post-review-comment.mjs NN "<slot>" "<OUT>/model.txt" "<OUT>/validated.md" "HEAD" "MAIN" "<OUT>/comment.md" "<OUT>/checks.md" || exit 2
     ```
     <WT> is the recorded absolute reviewer-owned reviewed worktree, never the author checkout.
     Replace only shell arguments with recorded values; do not rewrite validator source.
     The helper asserts the exact canonical first line with `head -1` before each
     `gh pr comment NN --body-file`. Nonzero stops posting; no manual fallback. Persist
     full outputs, not rewritten summaries, and each comment URL. Oversized output is split
     into numbered chunks each carrying the full heading. Retain posting receipts and never
     retry a partial/uncertain publication automatically; reconcile confirmed chunk indices.
   - **Combine.** Strip each owned worktree prefix from reviewer file:line locations, if present, so findings are
     repo-relative. Tag every finding with its declared slot name, collapse duplicates (same
     file:line and scenario), and sort the union under step 5. Every verdict must claim the
     actual reviewed PR head and retain independently asserted adapter/model provenance.
5. Record every child session id from its tool result and restate it in your own reply text in that same turn. Bind each verdict to
   its recorded SHA and apply shipping policy §2 to the combined findings. Distinguish verified
   defects from optional suggestions: optional polish is advisory, not a new acceptance criterion or repair
   round. Record advisory followups at the end of the roadmap when useful. Do not relabel a real LOW defect
   as advisory. A concrete proposed fix alone does not mandate another repair round.

## 3. Repair blockers — a bounded, converging loop

Follow shipping policy §§2–3: at most THREE repair rounds, retaining the counter on restart.
Collect all declared initial verdicts, disposition all findings, and batch only blocking repairs.
Non-blocking defects get documented issues; optional suggestions do not consume rounds.

A blocker closes only with a fixer delta plus independent focused review, an evidence-backed
ledger rebuttal quoting a reproducible command and its result, or an arbiter verdict within the
existing arbitration allowance. Explicitly prohibit re-prompting the raising reviewer under the
conductor’s contract reading as closure; that is not independent delta coverage or a rebuttal.

The human-directed classification rule is explicit: the topic skill permits one arbitration per row; a conductor that disagrees with a focused reviewer's non-blocking classification records the disagreement in the ledger and either accepts it or halts for the human, without a second arbitration.
This disagreement rule does not reclassify blocking findings: all HIGH findings, unmet acceptance, uncertain impact and unresolved blockers still block landing under shipping policy §2.

- **Arbitrate first, once per row** for contract/authorization findings, using the proposal,
  original row, and `AUTHORIZATION`. The arbiter uses the main entry as in §2 step 3.
  Carry APPROVE's verdict/session and RECORD into PR/roadmap; REJECT means restore the contract.
  "Needs the human" halts. This shares the builder-deviation arbitration allowance.
  If that allowance is already used, halt for the human; do not spawn a second arbiter.
  Focused non-blocking classification disagreement follows the ledger/accept-or-halt rule above,
  not another arbitration under shipping policy §2.
Before calling a fixer, perform this ordered persistence gate (including on resumption):

1. Persist the PR body with `gh pr edit NN --body-file <ledger-file>`: update
   `## Review disposition` with every finding, its severity and disposition; increment
   `Repair round: N/3` (at most 3, never reset on restart), recording OLD and assigned blocker IDs.
   Update `## Residuals` with deferred defect issue links or none. Require edit success before proceeding;
   a private note or an instruction for the fixer to update it later is not persistence.
2. Only then perform this read-back gate. Read back `gh pr view NN --json body` BEFORE
   spawning the fixer subagent; verify the
   persisted `Repair round: N/3` and assigned ledger blocker IDs match the intended handoff.
   Quote that persisted `Repair round: N/3` plus ledger blocker IDs verbatim in the fixer handoff.
   Dispatch only ledger-blocking findings. Nonblocking defects go to residual issues; advisory
   notes are not repairs. Record any reclassification in the ledger first with its rationale, then edit and read back
   again before dispatch. Missing or mismatched persistence halts; never delegate its creation.
3. Persist the verified read-back receipt in the GitHub PR body BEFORE dispatch:
   `Pre-dispatch read-back: Repair round: N/3; blockers <IDs>; OLD <SHA>; verified <ISO ts>`.
   Fill it from step 2's actual read-back, with its UTC timestamp; retain earlier rounds' receipts.
   Require edit success and read back the receipt with `gh pr view NN --json body`;
   verify the receipt, round, OLD and assigned IDs still match. Any mismatch halts dispatch.
   Quote this persisted receipt in the handoff alongside the round and blockers.
   Only then call the fixer described below, carrying that persisted ledger and counter.

- **Fix** with one subagent on the same PR branch, carrying verbatim blocker texts or review
  URLs/finding IDs, authorization, prior reviewed SHA and repair counter. Its brief says:
  "Follow dogfood. You are a topic child: run local proof, push, report OLD/NEW and current CI
  immediately; do not wait for hosted CI, run private external reviews, or fix advisory polish."
  Require fail-first/mutation proof, all named local declared checks, and updated disposition ledger. Record its
  session id. A budget death permits one continuation from pushed state; a second death halts.
  CI failures and merge conflicts are repair work on the same branch, never a gate bypass.
- **Cover the delta** under shipping policy §3. With zero slots, record no external delta review
  and retain checks/CI gates. The following reviewer procedure applies only when slots are declared;
  select the only slot for a one-slot project. Material deltas require ONE independent focused
  reviewer; mechanical deltas require explicit self-verification evidence, not another review.
  For a focused review, prepare one fresh reviewer-owned worktree at NEW and a unique base ref
  at OLD. Record paths/SHAs before conductor preparation; reviewers do not install or preflight.
  First resolve both endpoints to full commit IDs, then require unequal commits and OLD
  ancestor of NEW. Run this gate successfully before worktree creation or reviewer launch;
  retain the resolved OLD/NEW for preparation, review provenance and coverage records.

  ```sh
  # Focused delta gate
  OLD=$(git rev-parse --verify "$OLD^{commit}") || exit 1
  NEW=$(git rev-parse --verify "$NEW^{commit}") || exit 1
  [ "$OLD" != "$NEW" ] || exit 1
  git merge-base --is-ancestor "$OLD" "$NEW" || exit 1
  ```

  A same-head re-read is not a focused delta review and cannot close a blocker.
  Apply shipping policy §3's history-rewrite rule for non-ancestry.
  Derive BRANCH, OLD, NEW and a unique BASE inside the preparation call; fetch the PR branch.
  Then `WT=$(mktemp -d); OUT=$(mktemp -d); git worktree add --detach "$WT" "$NEW";
  git -C "$WT" branch "$BASE" "$OLD"; REVHEAD=$NEW`.
  Assert `git -C "$WT" rev-parse HEAD` equals NEW and tracked/index state is clean.
  The delta pass does not merge main. Create the selected reviewer's private TMPDIR outside Git
  ancestry. End preparation with `echo "$WT" "$OUT" "$REVHEAD" "$BASE"`, record the paths/SHA/ref
  before conductor preparation, and substitute literal paths in later calls (shell state does not persist).
  Run independent conductor declared checks at NEW before launch and give the reviewer the named receipts.
  For nonempty steps only, the conductor follows the declaration: Install dependencies in a separate call with timeoutMs at least 600000; require exit code zero before launch.
  No install is inferred when the declaration is empty. On failure, join jobs and retain recorded paths for cleanup. Reviewers do not install or preflight.
  Use §2 step 4's selected reviewer's command/tool allowances and model assertion where applicable,
  with OLD as the diff base. Brief the selected declared slot on OLD/NEW, blocker URLs,
  affected checks/mutations and direct interactions; launch through its adapter template.
  Do not hand over the fixer's reasoning as evidence. Record start time/job id and use the same
  timeout, one-retry, restore/join and SHA checks as the initial pass, applied to this one job.
  A dead focused review after retry halts; it is not replaced by self-review.
  Post its verdict as `## Focused review — <reviewer> — head NEW — delta OLD..NEW`.
  Follow **Review scratch cleanup**: join subprocesses, verify restored tracked/index state,
  persist the verdict/receipts, then remove this pass's worktree, unique `BASE`, reviewer temporary
  root, any conductor-trio tree and conductor-trio temporary root, and `OUT`. Re-read the PR head;
  any uncovered delta still needs classification and coverage before landing.
- **Converge:** each round closes assigned blockers without reopening closed ones. Newly found
  blockers may use another round up to the cap; advisory/non-blocking notes do not. A surviving
  assigned blocker, reopened blocker, or blockers at the cap halts with the trace. Never land
  blockers merely because residual issues exist. Preserve all review URLs, SHA ranges, deferred
  defect issues and mechanical-delta evidence for the lander.

## 4. Conditional land and continue

Before invoking land in this session or spawning a land child, read `gh pr view NN --json body`.
Fetch linked review comments too (for example `gh api repos/OWNER/REPO/issues/comments/ID`);
verify every declared initial canonical heading in the actual comments, comparing each model to its declared pin,
reviewed head and main provenance. Verify `## Review disposition` contains dispositions for every
finding from all declared initial reviews and every focused review, and `## Residuals` has issue links or
explicit `none`. Verify all blocker closures and delta coverage through current head. Missing
headings, comments, dispositions or residual records halt BEFORE land-child spawning; a URL alone
or a private summary is not verification. Persist edits then read back again if anything changes.

- After the declared initial pass and all required delta coverage have resolved blocking findings,
  independently confirm CI is green on
  the PR's actual current head SHA. Then spawn a land subagent with the exact band, row, predecessor
  merge SHA, PR number, and: “Land PR #NN following the land skill. The human authorized this row as
  part of BAND with the following exact invocation: `AUTHORIZATION`. Preserve that quote verbatim
  in the PR description and squash-merge commit body.” Record the lander id from the tool result.
- The land child must perform every land-skill precondition, squash, and watch `main` CI on the exact
  merge commit. A conflict or stale/red head CI returns to bounded repair before landing;
  pending CI is waited on, never bypassed. Failed authorization, exhausted repair/verification
  budgets, or red post-merge `main` halts the train. Never start the next row until that child reports the merge SHA and green `main` CI.
- Once green, start the next row from the newly merged `origin/main` without pausing for another
  merge word. The original invocation already supplied the bounded human decision for every row.

## 5. Halt and final report

A halted train is a successful safe outcome: stop all forward progress and wait for the human.
Always report:

- `AUTHORIZATION` as a verbatim quote;
- the fixed band and row list, rows landed with PR/head/merge SHAs and main-CI results, the current
  halted row, and untouched rows;
- every builder, fixer, arbiter, and lander session id, labeled by row and role, and the
  PR-comment URL of every external review (declared reviewer and declared reviewer, full and delta) with the head
  SHA it reviewed;
- every deviation proposed, with the arbiter's verdict block and how the train continued;
- every finding and whether it was fixed, per repair round, with the convergence count for each
  round, plus the exact halt reason and resumable session id when a child exhausted its budget.

Halts include: missing/ambiguous or revoked authorization; arbiter needs the human; an unfixable
blocker, non-convergence or blockers at the three-round cap; an incomplete required review after
its retry; a child that dies twice; exhausted child capacity/budget; red post-merge `main`.
Pending CI and non-blocking polish are not halts by themselves; unresolved classification disagreement may halt for the human. Never waive a required check to continue.

Do not claim a train completed unless every row landed sequentially and `main` CI was green on the
last merge commit. Do not merge anything after a stop condition.
