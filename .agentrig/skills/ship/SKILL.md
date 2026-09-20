---
name: ship
description: Orchestrate one change end to end - build, independently review, repair, and land when the human authorized this task's merge; otherwise stop at the reviewed PR.
---

# Ship flow — one command from task to merge decision

Read [shipping policy](../../../docs/SHIPPING-WORKFLOW.md) before acting. Its shared
CI scheduling, finding disposition, material-delta and convergence rules govern this flow.

You are the conductor, not a performer. The building happens in a subagent and the reviewing in
external CLI jobs you run; your job is sequencing and relaying results faithfully. Merge remains
a human decision, but that decision may be supplied up front, not only after the review.
Do not implement, review, or fix anything in this session yourself.

Capture any explicit upfront authorization to merge the PR for this named task as a verbatim
human-message quote, together with the task scope. Carry it through builder/fixer/lander handoffs;
once a PR exists, bind it to that PR number. Follow land's authorization checks, including later
revocation or narrowing. Do not infer authorization from YOLO or a tool allowance.

## Initial full review heading contract

Resolve the project's declared reviewer slots from `.agentrig/config.json` at the PR head,
not home config or runtime provider defaults. Missing `reviewers` or `{}` means zero slots.
Config declares 0, 1 or 2 named slots, each with an adapter id and a pinned model; no check capability flag.
Validate config before dispatch with `parseConfigText`; never replace project pins from local preferences.
Use `scripts/reviewer-adapters.mjs` for CLI command templates, model extraction and failed/empty-run detection.
An `api:<name>` adapter references the existing `providers.<name>` entry, whose model must equal
the slot's pinned model; it duplicates no endpoints, credentials or routing. See shipping policy §3.

Each declared slot's initial comment must start with:
`## External review — <slot> (<model>) — head <SHA> — merged with origin/main <MAIN> — full`
Substitute the slot name, asserted model, full reviewed PR head SHA and full origin/main SHA.
The initial heading model must equal the slot's pinned model. A different model makes this a
missing required initial review, not a receipt. Require the complete heading, not just a prefix
or SHA in the body. Post with `scripts/post-review-comment.mjs` using the slot name and the
reviewed config path; never compose an alternate heading inline. Persist per-adapter provenance
(launch/provider entry, model assertion source, start/end, exit, head/main and worktree) with the verdict.
Never infer the asserted model from reviewer prose. Truncation, failed runs, ambiguous assertion,
empty output or pin mismatch are not completed reviews. Retry once with fresh artifacts, then halt.

For acceptance or rerun detection, an initial review is present as a complete unnumbered single-comment review with the complete canonical heading, or when every numbered chunk (k/N), k=1..N, exists on the PR with the same complete canonical heading and consistent N; a heading alone or a partial set is missing review evidence. A nonzero helper exit may leave partial comments: preserve the OUT/*.receipt.json receipt, reconcile and remove all comments from that attempt before removing its receipt and retrying; never certify a partial review as complete.

With zero slots skip external reviews and record `External review: none declared` in the ledger:
builder → declared checks → exact-head CI → land, subject to authorization and all other gates.
With zero slots use the author’s named check receipts; no conductor-review preparation is required.
With one slot launch only it; that same slot is the focused-delta reviewer. With two slots launch
both independently and use one independent focused-delta reviewer for material repairs.
Land requires only declared headings, and compares each asserted model against that slot's pin.
Reviewers share no context with the builder and should differ by vendor or at least model.
The independent conductor's same-head declared checks must be GREEN BEFORE launching any reviewer;
pass named receipts as inputs, never builder reasoning. For empty steps pass the explicit none receipt.
Reviewers judge code only; reviewers do NOT run checks, bootstrap or preflight. Optional reviewer-owned
probes are evidence for a finding, not a substitute for conductor proof. Hosted CI overlaps reviews
and is required only at landing. Changed heads invalidate prior same-head check receipts.

## Review scratch cleanup

Human cleanup contract (generalized to declared slots):

> After the initial declared review pass and after any focused delta review, the conductor removes the review output directory (`OUT`) and the reviewer temporary roots in addition to all owned worktrees and the `review-base-NN` branch; builders and fixers remove their own proof TMPDIR after recording its results in the PR body. Removal happens only after joining every job and verifying restored tracked/index state, and never touches the author's tree.

Operative resource mapping: initial reviews remove one recorded owned tree per declared slot and `review-base-NN`; focused reviews remove the pass’s recorded owned single `WT` and unique `BASE`. Both also remove any recorded owned conductor-proof tree and conductor-proof temporary root (including extra exact-head proof trees). Both remove their recorded owned `OUT` and reviewer temporary roots only after all jobs are joined, tracked/index restoration is verified, and evidence is persisted.

Use topic's **Review scratch cleanup** sequence for every initial and focused pass, including failure/retry/staleness paths. The standalone dogfood author assumes conductor cleanup duties for its reviews. Builders/fixers record command exit codes, test counts, fail-first/mutation results and times in the PR body, join every proof job, verify restored tracked/index state, then, after the branch is pushed and handoff is recorded in the PR body, remove their recorded owned worktree and proof TMPDIR under dogfood §1; do not wait for hosted CI. Keep proof TMPDIR outside Git ancestry per docs/TESTING.md.

## 1. Build

Apply dogfood §1 to builders, continuation builders and fixers in every handoff: use an
owned worktree created from `origin/main` for new work, or attach/reuse the existing branch's
owned worktree for continuations and repairs. Never change the author checkout's branch.
Require the worktree path in the PR body and remove it after recording handoff, with all jobs
joined, tracked/index state restored and proof persisted. The conductor removes recorded owned
leftovers after landing under the same checks; never remove the author checkout or unowned trees.

- Spawn a subagent with a self-contained task: the issue/roadmap row to implement, plus
  "Follow the dogfood skill. You are a ship child: stop at the PR and skip the external reviews —
  an independent review follows." Include everything it needs in the task text — a subagent
  gets none of this conversation.
- If its report ends with `DEVIATION REQUESTED`, do not judge the proposal yourself: spawn an
  `arbiter` subagent with the proposal, the contract verbatim, and the human's invocation line;
  on APPROVE spawn a continuation builder on the same branch carrying the verdict block and the
  arbiter's session id; on REJECT spawn one carrying the rejection and "build the row as
  written", or stop for the human if the builder said the row as written is infeasible.
- Its report should name the PR it opened, the head SHA, and CI state on that head.
  Explicitly tell builders and fixers: return immediately after push/PR, without waiting for
  hosted CI; the conductor starts review and CI monitoring concurrently. If it died
  at its turn budget instead, report its session id so the human can resume it
  (`agentrig sessions resume <id>`), and stop — do not re-spawn a fresh builder over a
  half-pushed branch.

Remove registered worktrees with `git worktree remove <path>`, then `git worktree prune`
after the recorded handoff and join/state/proof checks. Never use bare directory deletion
for a worktree; remove the owned proof TMPDIR separately.

## 2. Review, independently

Never review in this session. Prepare exactly as `topic` §2 step 4 prescribes.
Resolve declared reviewer slots at the actual PR head and follow topic §2 step 4's preparation,
independent conductor proof, adapter launch, validation, posting and cleanup sequence exactly.
Before any reviewer, create an independent conductor tree at current PR HEAD and run the resolved
bootstrap, optional preflight and ordered declared checks; require GREEN BEFORE launching any reviewer.
Do not review an integration-only SHA: update the PR and re-prove first. In each reviewer-owned tree
conduct dependency preparation and gate on exit zero separately; empty steps run no commands.
Pass named receipts with head/commands/exits/counts/times as inputs. Reviewers judge code only;
reviewers do NOT run checks. Optional reviewer-owned probes may support findings.
Zero slots: record `External review: none declared`, skip review worktrees and jobs, and follow
builder → declared checks → exact-head CI → land. One slot: only it runs and it also owns focused
material-delta review. Two slots launch in parallel in separate reviewer-owned worktrees you prepare; both launch independently through `scripts/reviewer-adapters.mjs`. Hosted CI
monitoring starts immediately and overlaps reviews; green hosted CI is required only at landing.
Never pass builder context. API reviewers receive the relevant source/diff bundle and receipts.

Use the configured slot name with `scripts/post-review-comment.mjs`, the adapter's asserted-model
file, verdict file, full reviewed HEAD and MAIN, and check receipts. Do not compose headings inline.
Read back all canonical comments and durable chunk receipts before accepting them; use `head -1`
for the heading, not a complete chunk check. Compare each model to the slot's pinned model.
Reuse a complete current-head pass only for the declared slots; never demand an undeclared second
heading. Preserve older full reviews and focused delta coverage through the current head. A clean
main advance re-verifies CI, not a redundant initial pass. Never duplicate a completed review just
to improve its verdict. Failure/staleness/retry cleanup follows topic's Review scratch cleanup.

## 3. Resolve the verdict, then honor the merge decision

- Present the verdict verbatim-in-substance: every finding with its severity, or the pass with
  its evidence, plus PR number, CI state, and the initial review URLs and any focused delta review URL. This is a progress report, not an unconditional stop.
- Apply shipping policy §2 to every finding. Batch blocking repairs only; defer non-blocking
  defects with issue links and advisory polish to the roadmap when useful. Contract or
  authorization findings still go to an arbiter before the fixer.
  A fixable verdict does not wait for the human: perform authorized blocking repairs unasked.
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

- Spawn the fixer on the same branch with exact blocker texts/URLs. After its local proof and
  push, classify OLD..NEW under shipping policy §3: ONE independent focused reviewer for a
  material delta, evidence-only for a mechanical delta. Use topic §3's **Cover the delta** procedure
  for isolated preparation, installation, launch, provenance and cleanup. Never repeat the initial external pair
  for each fix. At most three repair rounds, preserving the counter on resumption; unresolved
  blockers or non-convergence halt, while new advisory notes do not open another round.

Before invoking land in this session or spawning a land child, read `gh pr view NN --json body`.
Fetch linked review comments too (for example `gh api repos/OWNER/REPO/issues/comments/ID`);
verify all declared initial canonical headings in the actual comments, including each slot's pinned model,
reviewed head and main provenance. Verify `## Review disposition` contains dispositions for every
finding from all declared initial reviews and every focused review, and `## Residuals` has issue links or
explicit `none`. Verify all blocker closures and delta coverage through current head. Missing
headings, comments, dispositions or residual records halt BEFORE land-child spawning; a URL alone
or a private summary is not verification. Persist edits then read back again if anything changes.

- When scoped merge authorization is present, run the `land` skill's steps (in this session or a
  land subagent) without asking for a second approval. Pass the verbatim human quote, task scope
  and PR number; require green exact-head CI and watch post-merge CI before reporting completion.
  Otherwise report the reviewed PR and wait for explicit merge authorization.
- No answer is an answer: never treat silence, a timeout, or your own confidence as approval.
  A run awaiting missing authorization is a reviewed PR awaiting authorization, not a completed
  end-to-end shipment. An authorized run is complete only after land reports green post-merge CI.

## 4. Budget and honesty

- Keep your own turns few — the work happens in the children. If a child fails, relay its actual
  failure; never paper over red declared checks or a review finding to make the cycle look complete.
- Every child has its own session log; name the session ids and the URLs of the declared external
  initial review comments and any focused delta review in your final report so the full audit trail is one
  `sessions show` away.
