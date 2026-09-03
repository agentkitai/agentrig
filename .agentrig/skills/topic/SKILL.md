---
name: topic
description: Run one authorized roadmap band as a sequential release train - dogfood each row, review independently, repair until clean in a bounded converging loop, arbitrate deviations, land, and halt only when a human is needed.
---

# Topic flow — one authorized roadmap band, landed row by row

You are the conductor, not the builder, reviewer, fixer, or merger. Use the `subagent` tool for
all of those children; do not do their work in this parent session. Keep your own turns few.

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
- Check that no row already has a half-pushed branch or open PR from an interrupted run. Resume its
  named session instead of spawning over it; if no resumable session is known, halt for the human.
- Preflight child capacity before creating a branch. The minimum is three children per remaining
  row (builder, full reviewer, lander); repair rounds, arbitration and continuations draw on the
  same pool as needed — a row that exhausts the pool mid-loop halts there, so size the pool for
  the band (a row that goes three rounds costs nine). Set `--subagent-max-turns` to at
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
2. Spawn a builder subagent with a self-contained task containing the exact roadmap-row contract
   (the verbatim row text from §1, quoted, never summarized), `AUTHORIZATION`, and: “Follow the dogfood skill. Start from current `origin/main`. Put the quoted
   authorization verbatim in the PR description. Report the PR, current head SHA and CI. You are a
   topic child: stop at the PR and skip the external reviews — an independent reviewer follows.”
   The dogfood child stops at its PR and never merges. Record the session id
   printed by the `subagent` tool result immediately (the same id is in the parent's spawn event);
   children cannot reliably report their own ids.
3. If the builder dies at its budget or leaves a half-pushed branch, halt. Report its recorded
   session id for `agentrig sessions resume <id>`; never replace it with a fresh builder.
   The one exception is a builder that stops deliberately with `DEVIATION REQUESTED` at the end
   of its report: it has pushed its work and is asking to change its contract. Do not judge the
   proposal yourself. Spawn an `arbiter` subagent with the proposal verbatim, the row text from
   §1, and `AUTHORIZATION`; record its id. On `VERDICT: APPROVE`, spawn a continuation builder on
   the same branch carrying the verdict block, the arbiter's session id, and "record this under
   `## Deviations` in the PR body and make the roadmap edit match its RECORD line". On
   `VERDICT: REJECT`, spawn a continuation builder carrying the rejection and "build the row as
   written" — unless the builder stated the row as written is infeasible, in which case halt for
   the human with both the proposal and the rejection. One arbitration per row; a second
   `DEVIATION REQUESTED` on the same row halts.
4. Spawn a new reviewer subagent with only: “Review PR #NN on its current head. Follow the review
   skill. Report the exact head SHA you reviewed.” Never pass the builder's report, reasoning,
   findings, or claimed evidence to this
   reviewer. The PR and repository are its only evidence. Record the reviewer id from the tool
   result immediately.
5. Record every child session id from its tool result and restate it in your own reply text in that
   same turn; tool results older than five turns may be elided from context. Bind the verdict to the
   head SHA the reviewer reports; a head that changes other than through §3's loop is stale —
   spawn a fresh reviewer on the new head rather than halting. If the reviewer dies at budget,
   spawn one more on the same head. Sort its findings, never by severity: every finding that
   carries a concrete proposed fix is repair work for §3; a finding it labels contract or
   authorization (an unapproved deviation) goes to the arbiter first (§3); a claim it could not
   verify is a finding whose fix is reproducible evidence in the PR body or deletion of the claim;
   a finding with no proposed fix is repair work too — the fixer's task is "find the fix or explain
   in the PR body exactly why none exists", and only a HIGH that the fixer reports unfixable halts.
   The bound on this train is rounds and convergence (§3), never the severity of a fixable defect:
   a HIGH with a one-line fix and a test is repair work.

## 3. Repair until clean — a bounded, converging loop

The train does not stop on a finding. It stops when it has run out of rounds, when a round stops
converging, or when something needs a human. Per row, at most THREE repair rounds:

- **Arbitrate first, once per row**, if any finding is a contract or authorization one: spawn an
  `arbiter` subagent with the deviation exactly as the reviewer described it, the row text from
  §1, and `AUTHORIZATION`; record its id. On `VERDICT: APPROVE` the fixer's task carries the
  verdict block, the arbiter's session id, and "record it under `## Deviations` in the PR body and
  make the roadmap edit match its RECORD line"; on `VERDICT: REJECT` it carries "revert to the row
  as written" with the rejection; on "needs the human", halt. This shares the
  one-arbitration-per-row budget with the builder's `DEVIATION REQUESTED` path.
- **Fix**: spawn one fix subagent on the same PR branch, scoped verbatim to every open finding and
  no unrelated code changes. Tell it not to rebut or skip a finding, to add fail-first proof where
  behavior changes (reuse the reviewer's exact mutant as the fail-first check when one was given),
  run the green trio, push, update the PR description with every finding and its resolution, and
  report the old/new head SHAs. Record its id. If it dies at budget, spawn ONE continuation fixer
  from its pushed branch carrying the same findings; a second death halts. A merge conflict is the
  fixer's to resolve (merge `main` in, never rebase); red CI on the new head is a finding for the
  next round, not a halt.
- **Re-review the delta**: spawn one fresh delta-review subagent with the PR number and old/new
  head SHAs; it reviews only that delta under the review skill's standards and never sees either
  author's report. Record its id. A clean, fully verified delta verdict lands (§4). Findings on the
  delta open the next round.
- **Convergence**: a round must close every finding from the previous round. A round that reopens
  a closed finding, or that ends with as many or more open findings than it started with, is not
  converging: halt with the full trace, because a fourth round would be the #82 treadmill. New
  findings in code the fix touched are normal and go to the next round.
- **After the third round**, whatever the delta reviewer still finds is recorded in the PR body
  with severity and the fixer's assessment: LOW or MEDIUM residual lands with that record; any
  HIGH residual halts.
- The train never rebuts, downgrades, waives, or silently skips a review finding; recording a
  residual after three rounds is not skipping it, it is the bound doing its job.

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
- every builder, reviewer, fixer, delta-reviewer, arbiter, and lander session id, labeled by row
  and role;
- every deviation proposed, with the arbiter's verdict block and how the train continued;
- every finding and whether it was fixed, per repair round, with the convergence count for each
  round, plus the exact halt reason and resumable session id when a child exhausted its budget.

The only halts left are: the arbiter answers "needs the human"; a HIGH the fixer reports
unfixable or that survives three rounds; a round that does not converge; a child that dies twice;
the child pool exhausted; a red post-merge `main`. Everything else is a child's job.

Do not claim a train completed unless every row landed sequentially and `main` CI was green on the
last merge commit. Do not merge anything after a stop condition.
