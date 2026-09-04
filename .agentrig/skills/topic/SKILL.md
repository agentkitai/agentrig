---
name: topic
description: Run one authorized roadmap band as a sequential release train - dogfood each row, review independently, repair to clean in a bounded converging loop, arbitrate deviations, land; halt only for a human.
---

# Topic flow — one authorized roadmap band, landed row by row

You are the conductor, not the builder, fixer, or merger. Use the `subagent` tool for those
children; do not do their work in this parent session. Reviews are external CLI jobs you start and
wait on (§2 step 4), never a child and never your own reading of the diff. Keep your own turns few.

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

For each recorded row, in order:

1. Fetch current `origin/main`, confirm it contains the preceding row's merge (unless this is the
   first unlanded row), and confirm CI is green on that exact current commit. Never stack PRs and
   never begin while the prior land check is pending.
2. Spawn a builder subagent with a self-contained task containing the exact roadmap-row contract
   (the verbatim row text from §1, quoted, never summarized), `AUTHORIZATION`, and: “Follow the dogfood skill. Start from current `origin/main`. Put the quoted
   authorization verbatim in the PR description. Report the PR, current head SHA and CI. You are a
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
4. Run the **external review pass** on the PR's current head: two reviewers that share nothing
   with the builder, in parallel, in one worktree you prepare. Never pass the builder's report,
   reasoning, findings, or claimed evidence to either reviewer; the PR and the repository are their
   only evidence.
   - **Prepare.** `gh pr view NN --json headRefName,headRefOid` gives `BRANCH` and `HEAD`. Then
     `git fetch origin main "$BRANCH"`, `WT=$(mktemp -d)`, `git worktree add "$WT" "$HEAD"`, and in
     `$WT`: `git merge --no-edit origin/main` (a conflict is a finding for §3 — record which files
     and stop the pass), `git branch -f review-base origin/main`, `pnpm install`. `OUT=$(mktemp -d)`
     holds every output file; never write review artifacts inside `$WT`.
   - **Claude job** — `bash` with `background: true`, cwd `$WT`:
     ```
     env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION \
         -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN -u CLAUDE_CODE_BRIDGE_SESSION_ID -u CLAUDE_PID \
       claude -p --model claude-opus-5 --permission-mode plan --allowedTools 'Read,Grep,Glob,Bash' \
         --output-format json --no-session-persistence \
         "Review PR #NN at head SHA HEAD. Read .agentrig/skills/review/SKILL.md and follow it. You are already in an isolated worktree at that head, merged with origin/main, with dependencies installed: skip its section 2 and verify that state yourself. Assume the author is wrong; verify every finding against the code before reporting it; report file:line, severity (HIGH/MEDIUM/LOW), a concrete failure scenario and a fix. Report the exact head SHA you reviewed." \
         < /dev/null > "$OUT/claude.json"
     ```
     The `env -u` list matters when this session was itself launched from inside Claude Code
     (the nesting variables make the child report "not logged in"); `< /dev/null` keeps it from
     waiting on stdin.
   - **Codex job** — `bash` with `background: true`, cwd `$WT`:
     ```
     codex review --base review-base "Review this PR's diff against review-base. Assume the author is wrong; verify every finding against the code before reporting it; report file:line, severity (HIGH/MEDIUM/LOW), a concrete failure scenario and a fix; state the head SHA you reviewed." > "$OUT/codex.md" 2> "$OUT/codex.err"
     ```
   - **Wait** with `bash_job` (`action: status`, `waitMs` up to 5 minutes per call; never a sleep
     loop). Record both job ids from the `bash` results immediately and restate them in your own
     reply text on every turn you poll — tool results older than five turns may be elided from
     context, and a lost id is a dead job you cannot kill or read. A job still running 45 minutes
     after it started is dead: `bash_job` `action: kill` it. A dead job (killed, non-zero exit, or
     empty output) is retried ONCE on the same head; both reviewers dead on the same head halts
     the train.
   - **Assert the model and extract the Claude review:**
     ```
     node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const m=Object.keys(r.modelUsage??{});if(m.length!==1||m[0]!=="claude-opus-5"){console.error("claude review ran on "+(m.join(",")||"unknown")+", not claude-opus-5");process.exit(2)}process.stdout.write(String(r.result??""))' "$OUT/claude.json" > "$OUT/claude.md"
     ```
     A non-zero exit here is a dead job under the Wait rule above (retry once, then halt if both
     are dead), never a review to use.
   - **Provenance.** Post each review verbatim as a PR comment, headed
     `## External review — Claude Code (claude-opus-5) — head HEAD — full` and
     `## External review — Codex — head HEAD — full`, with `gh pr comment NN --body-file "$OUT/…"`,
     and record both comment URLs — they stand in for reviewer session ids. Then
     `git worktree remove --force "$WT"`.
   - **Combine.** Tag every finding `[claude]` or `[codex]`, collapse duplicates (same file:line and
     the same scenario), and sort the union under step 5. Both reviews must name `HEAD` as the
     SHA they reviewed; a mismatch is a stale pass — rerun it on the current head.
5. Record every child session id from its tool result and restate it in your own reply text in that
   same turn; tool results older than five turns may be elided from context. Bind the verdict to the
   head SHA both reviews report; a head that changes other than through §3's loop is stale —
   rerun the pass on the new head rather than halting. Sort its findings, never by severity:
   every finding that carries a concrete proposed fix is repair work for §3; a finding it labels contract or
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
  `arbiter` subagent (on the main entry, as in §2 step 3) with the deviation exactly as the review
  described it, the row text from §1, and `AUTHORIZATION`; record its id. On `VERDICT: APPROVE` the fixer's task carries the
  verdict block, the arbiter's session id, and "record it under `## Deviations` in the PR body and
  make the roadmap edit match its RECORD line"; on `VERDICT: REJECT` it carries "revert to the row
  as written" with the rejection; on "needs the human", halt. This shares the
  one-arbitration-per-row budget with the builder's `DEVIATION REQUESTED` path.
- **Fix**: spawn one fix subagent on the same PR branch, scoped verbatim to every open finding and
  no unrelated code changes. Its brief carries the same sentence the builder's does — “You are a
  topic child: stop at the push and skip the external reviews — an independent delta review
  follows” — because the dogfood skill's §8 otherwise tells it to arrange its own reviews and wait
  on them. Tell it not to rebut or skip a finding, to add fail-first proof where
  behavior changes (reuse the reviewer's exact mutant as the fail-first check when one was given),
  run the green trio, push, update the PR description with every finding and its resolution, and
  report the old/new head SHAs. Record its id. If it dies at budget, spawn ONE continuation fixer
  from its pushed branch carrying the same findings; a second death halts. A merge conflict is the
  fixer's to resolve (merge `main` in, never rebase); red CI on the new head is a finding for the
  next round, not a halt.
- **Re-review the delta**: run the external review pass again (§2 step 4) over the delta only.
  Refresh the worktree to the new head (`git worktree add` at NEW, merge `origin/main`,
  `git branch -f review-base OLD`, `pnpm install`) and brief both reviewers with the PR number and
  the old/new head SHAs: "review only the changes OLD..NEW under the review skill's standards;
  never assume the previous review's findings — verify the code as it is now". They never see
  either author's report. Post both as PR comments headed
  `## External review — Claude Code (claude-opus-5) — head NEW — delta OLD..NEW` and
  `## External review — Codex — head NEW — delta OLD..NEW`. A clean, fully verified delta verdict
  from both reviewers lands (§4). Findings on the delta open the next round.
- **Convergence** is measured on the findings a round was given, never by counting: a round
  converges when every finding it started with is closed and no previously closed finding is
  reopened. A NEW finding the delta review raises in code the fix touched is progress, not
  regression — it goes to the next round, however many there are, until the round cap. The only
  non-converging round is one that leaves a given finding open or reopens a closed one: that halts
  with the full trace, because repeating it would be the #82 treadmill. The R3a train halted on
  "started with one, ended with one" when the one it ended with was new; that reading is wrong.
- **After the third round**, whatever the delta review still finds becomes **one GitHub issue
  per finding**, never a note in the PR body: the last fixer files each with `gh issue create`
  (title `[review residual] <one line>`, label `review-residual`, body: severity, file:line, the
  concrete scenario, the reviewer's proposed fix, the PR number, the head SHA, the reviewer
  (Claude Code or Codex) and its PR-comment URL), then lists the issue numbers under `## Residuals` in the PR body. A LOW or MEDIUM
  residual lands once its issue exists; a HIGH residual halts. The lander refuses a PR whose
  `## Residuals` names a finding without an issue number.
- The train never rebuts, downgrades, waives, or silently skips a review finding; filing a
  residual as an issue after three rounds is not skipping it, it is the bound doing its job with
  a place the finding can be picked up from.

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
- every builder, fixer, arbiter, and lander session id, labeled by row and role, and the
  PR-comment URL of every external review (Claude Code and Codex, full and delta) with the head
  SHA it reviewed;
- every deviation proposed, with the arbiter's verdict block and how the train continued;
- every finding and whether it was fixed, per repair round, with the convergence count for each
  round, plus the exact halt reason and resumable session id when a child exhausted its budget.

The only halts left are: the arbiter answers "needs the human"; a HIGH the fixer reports
unfixable or that survives three rounds; a round that does not converge; a child that dies twice;
the child pool exhausted; a red post-merge `main`. Everything else is a child's job.

Do not claim a train completed unless every row landed sequentially and `main` CI was green on the
last merge commit. Do not merge anything after a stop condition.
