---
name: topic
description: Run one authorized roadmap band as a sequential release train - dogfood each row, review independently, repair to clean in a bounded converging loop, arbitrate deviations, land; halt only for a human.
---

## Declared external-review contract

Read [shipping policy](../../../docs/SHIPPING-WORKFLOW.md).

Read the ordered `reviewers` declaration from the selected project configuration. It has zero, one,
or two uniquely named slots. Each slot binds an adapter id and immutable model pin; API slots also
bind one existing named provider entry. A slot never grants `canRunChecks` or any equivalent policy.
Workflow policy remains in skills, not core.

Before any reviewer launch, the conductor independently runs the complete declared checks on the
PR's exact HEAD in a clean owned tree. Record source, ordered step names and commands, exits, UTC
start/end, parsed counts, HEAD, and restored tracked/index state. All must be green. Give those
receipts to every reviewer as inputs. Reviewers perform code review only: they never rerun project
checks, though they may run small reviewer-owned probes or named mutants targeted at a suspected
line and must restore them.

Launch each declared slot, in declaration order or concurrently, only through
`scripts/reviewer-adapter.mjs`. The adapter owns its launch command, asserted model source,
empty-output detection, and failed-process detection. It must prove the actual model equals the
slot pin. API adapters use their named provider entry through the existing provider routing; never
copy provider routing into a skill. Post the verbatim result with `scripts/post-review-comment.mjs`.
The canonical first line is exactly:
`## External review — <slot> (<model>) — head <SHA> — full`.
Report the exact head SHA you reviewed. Only configured slots count. A heading whose model differs from that slot's configured pin, an
empty/failed launch, stale SHA, heading alone, or incomplete chunk set is missing evidence.

With zero slots, launch nothing and write `External review: none declared` in the PR ledger; the
path is builder → author checks → conductor exact-head checks → exact-head CI → authorized land.
With one slot, that slot supplies the full review and every later focused-delta review. With two,
both slots supply initial full reviews; after material repair, the slot selected for the focused
delta must be one of those declared slots. Hosted CI may overlap review, but required exact-head CI
must be green at landing.

## Review scratch cleanup

Human cleanup contract (verbatim):

> After the configured initial review set and after any focused delta review, the conductor removes the review output directory (`OUT`) and the reviewer temporary roots in addition to both worktrees and the `review-base-NN` branch; builders and fixers remove their own proof TMPDIR after recording its results in the PR body. Removal happens only after joining every job and verifying restored tracked/index state, and never touches the author's tree.

Operative resource mapping: initial reviews remove the pass’s recorded owned `WT`, `REVIEW_WT` and `review-base-NN`; focused reviews remove the pass’s recorded owned single `WT` and unique `BASE`. Both also remove any recorded owned conductor-check tree and conductor-check temporary root (including extra exact-head proof trees). Both remove their recorded owned `OUT` and reviewer temporary roots only after all jobs are joined, tracked/index restoration is verified, and evidence is persisted.

Apply this sequence to successful, failed, retried, stale and interrupted passes alike, including every abbreviated cleanup instruction below:

1. Join every job and subprocess, including installs, retries and mutations.
2. Verify recorded HEADs and restored tracked/index state; an unrestored mutation or unfinished writer blocks removal and invalidates the review, never erases evidence.
3. Persist verdicts, provenance, proof results and failure receipts in the PR before deleting their only local copies.
4. Remove only this pass's recorded owned worktrees, base ref, reviewer temporary roots, any conductor-check tree and conductor-check temporary root, and `OUT`; never the author's tree or old unowned scratch.

For a focused pass remove its one worktree and unique `BASE` instead of the configured initial review set and `review-base-NN`. Also remove any recorded owned conductor-check tree and conductor-check temporary root. Remove temporary roots outside `OUT` explicitly; roots inside it are removed with it. Record the removed paths and cleanup result. If restoration cannot be verified, preserve the owned evidence and halt rather than force cleanup. Read/combine the verdicts before removing `OUT`.

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
4. Run the **declared external-review pass** on the PR's exact current head. Apply the
   declared external-review contract above: resolve zero, one, or two slots; run independent
   conductor checks before any launch; pass receipts to adapters; post canonical provenance for
   every configured slot; and never ask reviewers to run project checks. Never pass the builder's report
   as review evidence. Hosted CI may overlap.
   For zero slots, record the required no-review ledger line and continue to exact-head CI. For one
   slot, that slot is also the focused-delta reviewer. For two slots, require both full reviews.
5. Record every child session id from its tool result and restate it in your own reply text in that same turn. Bind each verdict to
   its recorded SHA and apply shipping policy §2 to the combined findings. Distinguish verified
   defects from optional suggestions: optional polish is advisory, not a new acceptance criterion or repair
   round. Record advisory followups at the end of the roadmap when useful. Do not relabel a real LOW defect
   as advisory. A concrete proposed fix alone does not mandate another repair round.

## 3. Repair blockers — a bounded, converging loop

Follow shipping policy §§2–3: at most THREE repair rounds, retaining the counter on restart.
Collect both initial verdicts, disposition all findings, and batch only blocking repairs.
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
- **Cover the delta** under shipping policy §3. Material deltas require ONE independent focused
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
  with OLD as the diff base. Brief the declared slot with OLD/NEW, blocker URLs, affected checks/mutations and
  direct interactions, then launch that slot only through `scripts/reviewer-adapter.mjs`.
  Do not hand over the fixer's reasoning as evidence. Record start time/job id and use the same
  timeout, one-retry, restore/join and SHA checks as the initial pass, applied to this one job.
  A dead focused review after retry halts; it is not replaced by self-review.
  Post its verdict as `## Focused review — <reviewer> — head NEW — delta OLD..NEW`.
  Follow **Review scratch cleanup**: join subprocesses, verify restored tracked/index state,
  persist the verdict/receipts, then remove this pass's worktree, unique `BASE`, reviewer temporary
  root, any conductor-check tree and conductor-check temporary root, and `OUT`. Re-read the PR head;
  any uncovered delta still needs classification and coverage before landing; do not call the new head reviewed.
- **Converge:** each round closes assigned blockers without reopening closed ones. Newly found
  blockers may use another round up to the cap; advisory/non-blocking notes do not. A surviving
  assigned blocker, reopened blocker, or blockers at the cap halts with the trace. Never land
  blockers merely because residual issues exist. Preserve all review URLs, SHA ranges, deferred
  defect issues and mechanical-delta evidence for the lander.

## 4. Conditional land and continue

Before invoking land in this session or spawning a land child, read `gh pr view NN --json body`.
Fetch linked review comments too (for example `gh api repos/OWNER/REPO/issues/comments/ID`);
verify both initial canonical headings in the actual comments, including the pinned the declared slot model,
reviewed head and main provenance. Verify `## Review disposition` contains dispositions for every
finding from every configured initial review and every focused review, and `## Residuals` has issue links or
explicit `none`. Verify all blocker closures and delta coverage through current head. Missing
headings, comments, dispositions or residual records halt BEFORE land-child spawning; a URL alone
or a private summary is not verification. Persist edits then read back again if anything changes.

- After the configured initial review set and all required delta coverage have resolved blocking findings,
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
  PR-comment URL of every external review (configured reviewer and configured reviewer, full and delta) with the head
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
