---
name: topic
description: Run one authorized roadmap band as a sequential release train - dogfood each row, independently review, fix LOWs once, conditionally land, and halt on unsafe or unverifiable state.
---

# Topic flow — one authorized roadmap band, landed row by row

You are the conductor, not the builder, reviewer, fixer, or merger. Use the `subagent` tool for
all of those children; do not do their work in this parent session. Keep your own turns few.

## 1. Lock the authorization and train

- The latest human-authored task must expressly invoke `topic` for the named band. The TUI carries
  its raw input between `BEGIN HUMAN SKILL INVOCATION (verbatim)` delimiters; capture the bytes
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
  to R2a, R2b, R2c, and R2d in roadmap order. Record the fixed row list and identify rows already
  merged on `main`; count those as completed predecessors, never rebuild them. If the band or
  invocation sentence is ambiguous, stop and ask the human before any child or branch is created.
- Check that no row already has a half-pushed branch or open PR from an interrupted run. Resume its
  named session instead of spawning over it; if no resumable session is known, halt for the human.
- Preflight child capacity before creating a branch. Reserve five children per row (builder, full
  reviewer, possible LOW fixer, possible delta reviewer, lander), set `--subagent-max-turns` to at
  least 60, and ensure the parent has enough token budget. Each child's token cap is `--max-tokens ÷
  --subagent-max-children`, and all children share the parent's total: raise `--max-tokens`
  proportionally when raising the pool, or leave it unset. If the child pool, turn cap, or resulting
  per-child/total allowance is insufficient, halt up front and name the exact settings to change.
  Never fall back to doing child work in the parent.

## 2. Build and independently review one row

For each recorded row, in order:

1. Fetch current `origin/main`, confirm it contains the preceding row's merge (unless this is the
   first unlanded row), and confirm CI is green on that exact current commit. Never stack PRs and
   never begin while the prior land check is pending.
2. Spawn a builder subagent with a self-contained task containing the exact roadmap-row contract,
   `AUTHORIZATION`, and: “Follow the dogfood skill. Start from current `origin/main`. Put the quoted
   authorization verbatim in the PR description. Report the PR, current head SHA and CI, and both
   external reviews.” The dogfood child stops at its PR and never merges. Record the session id
   printed by the `subagent` tool result immediately (the same id is in the parent's spawn event);
   children cannot reliably report their own ids.
3. If the builder dies at its budget or leaves a half-pushed branch, halt. Report its recorded
   session id for `agentrig sessions resume <id>`; never replace it with a fresh builder.
4. Spawn a new reviewer subagent with only: “Review PR #NN on its current head. Follow the review
   skill. Report the exact head SHA you reviewed.” Never pass the builder's report, reasoning,
   findings, or claimed evidence to this
   reviewer. The PR and repository are its only evidence. Record the reviewer id from the tool
   result immediately.
5. Record every child session id from its tool result and restate it in your own reply text in that
   same turn; tool results older than five turns may be elided from context. Bind the verdict to the
   head SHA the reviewer
   reports; if the PR head changes after review except through the LOW repair path below, halt as
   stale. If the reviewer dies at budget, cannot verify any claim, sees a merge conflict, finds red
   CI on the actual head, or reports a MEDIUM or HIGH finding, halt without rebutting or fixing it.

## 3. One LOW-only repair round

- A clean verdict proceeds to landing. A verdict containing only LOW findings gets exactly one
  repair round: spawn one fix subagent on the same PR branch, scoped verbatim to those findings and
  no unrelated code changes. Tell it not to rebut or skip a finding, to add fail-first proof where
  behavior changes, run the green trio, push, update the PR description with every independent
  finding and its resolution, and report the old/new head SHAs. Record its id from the tool result.
- If that child cannot close every LOW, dies at budget, encounters a conflict, or leaves CI red on
  the new actual head, halt. Never spawn a replacement over its branch.
- Otherwise spawn one fresh delta-review subagent. Give it the PR number and old/new head SHAs, ask
  it to review only that delta under the review skill's standards, and do not pass either author's
  report. Record its id from the tool result. Land only on a clean, fully verified delta verdict.
  Any finding of any severity, or any
  claim it cannot verify, halts the train for the human. There is no second fix or review round.
- The train never rebuts, downgrades, waives, or silently skips a review finding.

## 4. Conditional land and continue

- After a clean full review, or a clean one-time delta review, independently confirm CI is green on
  the PR's actual current head SHA. Then spawn a land subagent with the exact band, row, predecessor
  merge SHA, PR number, and: “Land PR #NN following the land skill. The human authorized this row as
  part of BAND with the following exact invocation: `AUTHORIZATION`. Preserve that quote verbatim
  in the PR description and squash-merge commit body.” Record the lander id from the tool result.
- The land child must perform every land-skill precondition, squash, and watch `main` CI on the exact
  merge commit. A conflict, stale/red head CI, failed precondition, or red post-merge `main` halts the
  train. Never start the next row until that child reports the merge SHA and green `main` CI.
- Once green, start the next row from the newly merged `origin/main` without pausing for another
  merge word. The original invocation already supplied the bounded human decision for every row.

## 5. Halt and final report

A halted train is a successful safe outcome: stop all forward progress and wait for the human.
Always report:

- `AUTHORIZATION` as a verbatim quote;
- the fixed band and row list, rows landed with PR/head/merge SHAs and main-CI results, the current
  halted row, and untouched rows;
- every builder, reviewer, fixer, delta-reviewer, and lander session id, labeled by row and role;
- every finding and whether it was fixed, plus the exact halt reason and resumable session id when
  a child exhausted its budget.

Do not claim a train completed unless every row landed sequentially and `main` CI was green on the
last merge commit. Do not merge anything after a stop condition.
