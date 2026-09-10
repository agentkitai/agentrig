---
name: ship
description: Orchestrate one change end to end - build, independently review, repair, and land when the human authorized this task's merge; otherwise stop at the reviewed PR.
---

# Ship flow — one command from task to merge decision

You are the conductor, not a performer. The building happens in a subagent and the reviewing in
external CLI jobs you run; your job is sequencing and relaying results faithfully. Merge remains
a human decision, but that decision may be supplied up front, not only after the review.
Do not implement, review, or fix anything in this session yourself.

Capture any explicit upfront authorization to merge the PR for this named task as a verbatim
human-message quote, together with the task scope. Carry it through builder/fixer/lander handoffs;
once a PR exists, bind it to that PR number. Follow land's authorization checks, including later
revocation or narrowing. Do not infer authorization from YOLO or a tool allowance.

## 1. Build

- Spawn a subagent with a self-contained task: the issue/roadmap row to implement, plus
  "Follow the dogfood skill. You are a ship child: stop at the PR and skip the external reviews —
  an independent review follows." Include everything it needs in the task text — a subagent
  gets none of this conversation.
- If its report ends with `DEVIATION REQUESTED`, do not judge the proposal yourself: spawn an
  `arbiter` subagent with the proposal, the contract verbatim, and the human's invocation line;
  on APPROVE spawn a continuation builder on the same branch carrying the verdict block and the
  arbiter's session id; on REJECT spawn one carrying the rejection and "build the row as
  written", or stop for the human if the builder said the row as written is infeasible.
- Its report should name the PR it opened, the head SHA, and CI state on that head. If it died
  at its turn budget instead, report its session id so the human can resume it
  (`agentrig sessions resume <id>`), and stop — do not re-spawn a fresh builder over a
  half-pushed branch.

## 2. Review, independently

- Run the external review pass exactly as `topic` §2 step 4 prescribes: two external reviewers
  (Claude Code pinned to `claude-opus-5`, and Codex) in parallel in separate reviewer-owned worktrees you prepare, the
  model asserted from `modelUsage`, both reviews posted as PR comments, findings tagged and merged.
  Never review in this session and never pass the builder's report to either reviewer; the PR and
  the code are their only inputs.

## 3. Resolve the verdict, then honor the merge decision

- Present the verdict verbatim-in-substance: every finding with its severity, or the pass with
  its evidence, plus PR number, CI state, and the URLs of the two external review comments (four
  after a delta). This is a progress report, not an unconditional stop.
- A fixable verdict does not wait for the human: when the pass returns findings that carry concrete
  fixes, or stopped on a merge conflict, spawn the fix subagent scoped to exactly those findings on
  the same branch, then the delta re-review of what changed — the same external pass over OLD..NEW
  as `topic` §3 describes — and loop the two under `topic` §3's bounded converging rules (at most
  three rounds, each must close the last round's findings) without asking. Present the verdict and
  proceed to landing only when the review/residual requirements are satisfied; a `topic` §5 halt
  still stops the workflow even when merging was authorized.
- When scoped merge authorization is present, run the `land` skill's steps (in this session or a
  land subagent) without asking for a second approval. Pass the verbatim human quote, task scope
  and PR number; require green exact-head CI and watch post-merge CI before reporting completion.
  Otherwise report the reviewed PR and wait for explicit merge authorization.
  Severity never decides fixability: any
  finding with a concrete proposed fix is fixer work. A contract or authorization finding goes to
  an `arbiter` subagent first, exactly as `topic` §3 does, and the fixer carries the verdict.
  Residual findings after the third round are filed as GitHub issues, one per finding, in
  `topic` §3's `review-residual` format, and listed by number under `## Residuals` in the PR body.
- No answer is an answer: never treat silence, a timeout, or your own confidence as approval.
  A run awaiting missing authorization is a reviewed PR awaiting authorization, not a completed
  end-to-end shipment. An authorized run is complete only after land reports green post-merge CI.

## 4. Budget and honesty

- Keep your own turns few — the work happens in the children. If a child fails, relay its actual
  failure; never paper over a red trio or a review finding to make the cycle look complete.
- Every child has its own session log; name the session ids and the URLs of the two external
  review comments (four after a delta) in your final report so the full audit trail is one
  `sessions show` away.
