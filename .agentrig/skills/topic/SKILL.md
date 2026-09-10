---
name: topic
description: Run one authorized roadmap band as a sequential release train - dogfood each row, review independently, repair to clean in a bounded converging loop, arbitrate deviations, land; halt only for a human.
---

# Topic flow — one authorized roadmap band, landed row by row

Read [shipping policy](../../../docs/SHIPPING-WORKFLOW.md) before acting. Its shared
CI scheduling, finding disposition, material-delta and convergence rules govern this flow.

You are the conductor, not the builder, fixer, or merger. Use the `subagent` tool for those
children; do not do their work in this parent session. Reviews are external CLI jobs you start and
wait on (§2 step 4), never a child and never your own reading of the diff. Keep your own turns few.
Builder, fixer, lander and arbiter are jobs/skills, not configured agent-role names. For
these generic children, omit the `agent` field entirely and put the job in `task`/`label`.
Never guess a role name after an unknown-role refusal. Provider routing remains as specified below.

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
4. Run the **external review pass** on the PR's current head: two reviewers that share nothing
   with the builder, in parallel with each other AND hosted CI, in separate reviewer-owned
   worktrees you prepare. Start the CI watch and reviews as soon as the PR is available; green
   hosted CI is a landing gate, not a review-start gate. First check whether it already ran:
   if the PR carries two comments whose heading starts with `## External review —` and whose body
   names the CURRENT head SHA, one from Claude Code and one from Codex, do not run the pass again —
   read those two comments as its result and continue at **Combine**. For older heads, recover
   the review ledger and inspect uncovered deltas under shipping policy §3 instead of restarting
   the initial pair. An incomplete initial pair still requires both reviews. Never pass the builder's report,
   reasoning, findings, or claimed evidence to either reviewer; the PR and the repository are their
   only evidence.
   - **Prepare.** One `bash` call for preparation, then one call per install. Every value
     the preparation call uses is assigned inside it before use:
     `BRANCH=$(gh pr view NN --json headRefName --jq .headRefName)`;
     `HEAD=$(gh pr view NN --json headRefOid --jq .headRefOid)`; then
     `git fetch origin main "$BRANCH"`, `WT=$(mktemp -d)`, `echo "$WT"`, `git worktree add "$WT" "$HEAD"`,
     `git -C "$WT" branch -f review-base-NN origin/main` (create it inside the worktree so
     `git -C "$WT"` sees it); assert
     `[ "$(git -C "$WT" rev-parse HEAD)" = "$HEAD" ] || stop the pass (the worktree is not at the
     PR head)` (remove the worktree and `review-base-NN` before stopping), and record
     `MAIN=$(git rev-parse origin/main)`. Then `git -C "$WT" merge --no-edit origin/main` (a
     conflict is a finding for §3 — record which files and stop the pass; remove the worktree and
     `review-base-NN` before stopping). A pass that stopped before both reviews completed is not a
     pass: the pass after a conflict-stopped one is a full pass on the new head, never a delta.
     `WT` belongs exclusively to Claude. Create Codex's independent tree at the same resulting
     commit: `REVHEAD=$(git -C "$WT" rev-parse HEAD)`; `CODEX_WT=$(mktemp -d)`;
     `echo "$CODEX_WT" "$REVHEAD"`; `git worktree add --detach "$CODEX_WT" "$REVHEAD"`.
     Assert both trees have the same HEAD and are clean before launching either reviewer.
     `OUT=$(mktemp -d)`
     holds every output file; never write review artifacts inside either tree. Create independent
     temporary roots with `mkdir "$OUT/claude-tmp" "$OUT/codex-tmp"`; pass the corresponding
     command-local `TMPDIR` below, never change the operator's global environment. Before testing,
     run fixture preflight in each reviewer environment; use a fresh temp root outside Git
     ancestry per docs/TESTING.md, or record the environment limitation without disabling checks.
     End preparation with `echo "$WT" "$CODEX_WT" "$OUT" "$REVHEAD"`. Record these paths and
     the post-merge review SHA BEFORE installing dependencies. Run `cd <WT> && pnpm install`
     and `cd <CODEX_WT> && pnpm install` in separate calls, each with `timeoutMs` at least 600000;
     require both exit codes zero before launching reviewers. A failed install cannot hide the
     recorded cleanup paths; join it before removing either tree.
     `bash` has no cwd field and no shell state survives between calls: record all
     three absolute paths and REVHEAD like job ids, and substitute
     them literally into every later command. Never share mutable sources, build output or
     `node_modules` between the reviewers; worktrees are cooperative isolation, not an OS sandbox.
   - **Claude job** — `bash` with `background: true`:
     ```
     cd <WT> && env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION \
         -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN -u CLAUDE_CODE_BRIDGE_SESSION_ID -u CLAUDE_PID \
       TMPDIR=<OUT>/claude-tmp claude -p --model claude-opus-5 --permission-mode dontAsk --allowedTools 'Read,Grep,Glob,Bash,Edit,Write' \
         --disallowedTools 'Bash(git push),Bash(git push *),Bash(gh pr merge),Bash(gh pr merge *)' \
         --output-format json --no-session-persistence \
         "Review PR #NN at head SHA HEAD. Read .agentrig/skills/review/SKILL.md and follow it. You exclusively own this isolated review worktree, merged with origin/main, with dependencies installed: skip section 2 and verify that state yourself. Run the required checks and mutation probes here, restore each mutant and join every subprocess before reporting; never touch a sibling or author tree. Do not push, merge, commit, change permission settings, spawn children or invoke auxiliary models. Assume the author is wrong; verify every finding against the code before reporting it; report file:line, severity (HIGH/MEDIUM/LOW), a concrete failure scenario and a fix. Report the exact head SHA you reviewed." \
         < /dev/null > "<OUT>/claude.json"
     ```
     The `env -u` list matters when this session was itself launched from inside Claude Code
     (the nesting variables make the child report "not logged in"); `< /dev/null` keeps it from
     waiting on stdin. `<WT>` and `<OUT>` are the literal absolute paths Prepare echoed, not shell
     variables — this is a fresh `bash` call and `$WT`/`$OUT` do not exist in it.
     `dontAsk` denies requests outside the explicit tool allowances instead of prompting; it is
     not `plan` (which forbids required mutations) or a permission bypass. Bash is already an
     execution allowance, not a filesystem sandbox. Restrict work to the reviewer-owned tree and
     temporary root; do not change AgentRig's ask/sandbox/grant defaults or relax a denied check.
     Direct `git push`/`gh pr merge` denials reinforce the existing no-push/no-merge boundary;
     they are defense in depth, not containment against alternate spellings, scripts or shared
     Git metadata. Private-fixture Git operations remain available for required tests. Treat
     cooperative confinement as a limitation, never a claim that tool patterns sandbox Bash.
   - **Codex job** — `bash` with `background: true`:
     ```
     cd <CODEX_WT> && TMPDIR=<OUT>/codex-tmp codex review --base review-base-NN > "<OUT>/codex.md" 2> "<OUT>/codex.err"
     ```
     Codex takes no custom prompt in `--base` mode (its review mode has its own); the adversarial
     standard is Claude's brief and step 5's disposition. A missing proposed fix does not waive
     a real blocker or turn an optional suggestion into repair work.
   - **Wait** with `bash_job` (`action: status`, `waitMs` up to 5 minutes per call; never a sleep
     loop). Record both job ids from the `bash` results immediately, along with each job's start
     time beside its id, and restate them in your own reply text on every turn you poll — tool
     results older than five turns may be elided from context, and a lost id is a dead job you
     cannot kill or read. A job still running 60 minutes after it started is dead: `bash_job`
     `action: kill` it. A dead job (killed, non-zero exit, or an empty `<OUT>/codex.md`, or an
     empty `<OUT>/claude.md` after the extraction step below — `bash_job` showing no output is
     normal because the jobs write to files) is retried ONCE on the same head; both reviewers dead
     on the same head halts the train (remove the worktree and `review-base-NN` first). A pass with
     one surviving review is not a pass — halt with the surviving review posted (remove the
     worktree and `review-base-NN` first); the train never lands on one reviewer.
   - **Assert the model and extract the Claude review:**
     ```
     node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const m=Object.keys(r.modelUsage??{});if(m.length!==1||m[0]!=="claude-opus-5"){console.error("claude review ran on "+(m.join(",")||"unknown")+", not claude-opus-5");process.exit(2)}process.stdout.write(String(r.result??""))' "<OUT>/claude.json" > "<OUT>/claude.md"
     ```
     A non-zero exit here is a dead job under the Wait rule above (retry once, then halt if both
     are dead), never a review to use.
   - **Provenance.** Join both jobs and their subprocesses, then confirm both reviewer trees have
     the recorded `<REVHEAD>` (post-merge on a full pass; NEW on a delta) and clean tracked/index state. Any unrestored mutant, changed
     HEAD or unfinished writer invalidates that review; record it explicitly and use the existing
     dead-job retry rule, never clean away the evidence and count the pass. The conductor owns
     cleanup: every removal below and in retry/staleness paths means BOTH reviewer trees, only
     after jobs are joined, plus the shared `review-base-NN` ref. Before posting, re-read the PR head (`gh pr view NN --json headRefOid`): if
     it no longer equals `HEAD`, retain the verdict for the recorded SHA but do not call the new
     head reviewed. Join/clean up, then classify and cover the uncovered delta under shipping
     policy §3; never silently certify a different head or restart both reviews by default. Compose each comment body
     with its heading first —
     `{ echo "## External review — Claude Code (claude-opus-5) — head HEAD — merged with origin/main MAIN — full"; echo; cat "<OUT>/claude.md"; } > "<OUT>/claude-comment.md"`
     (the same for Codex, with its own heading and `<OUT>/codex.md`) — then post each with
     `gh pr comment NN --body-file "<OUT>/claude-comment.md"` (and the Codex equivalent), and
     record both comment URLs — they stand in for reviewer session ids. A body over 60,000
     characters is split into numbered comments `(1/2)`, `(2/2)`. Then
     `git worktree remove --force <WT>`, `git worktree remove --force <CODEX_WT>` and `git branch -D review-base-NN`.
   - **Combine.** Strip `<CODEX_WT>/` from Codex file:line locations and `<WT>/` from Claude's, if present, so findings are
     repo-relative. Tag every finding `[claude]` or `[codex]`, collapse duplicates (same file:line
     and the same scenario), and sort the union under step 5. Claude's review must also name
     `HEAD` as the SHA it reviewed; Codex echoes no SHA and needs none, because the worktree was
     asserted to be at `HEAD` (before the merge on a full pass).
5. Record every child session id from its tool result and restate it in your own reply text in that same turn. Bind each verdict to
   its recorded SHA and apply shipping policy §2 to the combined findings. Distinguish verified
   defects from optional suggestions: optional polish is advisory, not a new acceptance criterion or repair
   round. Record advisory followups at the end of the roadmap when useful. Do not relabel a real LOW defect
   as advisory. A concrete proposed fix alone does not mandate another repair round.

## 3. Repair blockers — a bounded, converging loop

Follow shipping policy §§2–3: at most THREE repair rounds, retaining the counter on restart.
Collect both initial verdicts, disposition all findings, and batch only blocking repairs.
Non-blocking defects get documented issues; optional suggestions do not consume rounds.

- **Arbitrate first, once per row** for contract/authorization findings, using the proposal,
  original row, and `AUTHORIZATION`. The arbiter uses the main entry as in §2 step 3.
  Carry APPROVE's verdict/session and RECORD into PR/roadmap; REJECT means restore the contract.
  "Needs the human" halts. This shares the builder-deviation arbitration allowance.
- **Fix** with one subagent on the same PR branch, carrying verbatim blocker texts or review
  URLs/finding IDs, authorization, prior reviewed SHA and repair counter. Its brief says:
  "Follow dogfood. You are a topic child: run local proof, push, report OLD/NEW and current CI
  immediately; do not wait for hosted CI, run private external reviews, or fix advisory polish."
  Require fail-first/mutation proof, full local trio, and updated disposition ledger. Record its
  session id. A budget death permits one continuation from pushed state; a second death halts.
  CI failures and merge conflicts are repair work on the same branch, never a gate bypass.
- **Cover the delta** under shipping policy §3. Material deltas require ONE independent focused
  reviewer; mechanical deltas require explicit self-verification evidence, not another review.
  For a focused review, prepare one fresh reviewer-owned worktree at NEW and a unique base ref
  at OLD. Record paths/SHAs before install; use an independent install and preflighted TMPDIR.
  Derive BRANCH, OLD, NEW and a unique BASE inside the preparation call; fetch the PR branch.
  Then `WT=$(mktemp -d); OUT=$(mktemp -d); git worktree add --detach "$WT" "$NEW";
  git -C "$WT" branch "$BASE" "$OLD"; REVHEAD=$NEW`.
  Assert `git -C "$WT" rev-parse HEAD` equals NEW and tracked/index state is clean.
  The delta pass does not merge main. Create the selected reviewer's private TMPDIR outside Git
  ancestry. End preparation with `echo "$WT" "$OUT" "$REVHEAD" "$BASE"`, record the paths/SHA/ref
  before install, and substitute literal paths in later calls (shell state does not persist).
  Install dependencies in a separate call with timeoutMs at least 600000; require exit code zero
  before launch. On failure, join the install and retain recorded paths for cleanup.
  Use §2 step 4's selected reviewer's command/tool allowances and model assertion where applicable,
  with OLD as the diff base. For Claude, brief OLD/NEW, blocker URLs, affected checks/mutations and
  direct interactions; for Codex use `codex review --base <unique-old-ref>`.
  Do not hand over the fixer's reasoning as evidence. Record start time/job id and use the same
  timeout, one-retry, restore/join and SHA checks as the initial pass, applied to this one job.
  A dead focused review after retry halts; it is not replaced by self-review.
  Post its verdict as `## Focused review — <reviewer> — head NEW — delta OLD..NEW`.
  Join subprocesses and verify restored tracked/index state before cleanup. Re-read the PR head;
  any uncovered delta still needs classification and coverage before landing.
- **Converge:** each round closes assigned blockers without reopening closed ones. Newly found
  blockers may use another round up to the cap; advisory/non-blocking notes do not. A surviving
  assigned blocker, reopened blocker, or blockers at the cap halts with the trace. Never land
  blockers merely because residual issues exist. Preserve all review URLs, SHA ranges, deferred
  defect issues and mechanical-delta evidence for the lander.

## 4. Conditional land and continue

- After the initial pair and all required delta coverage have resolved blocking findings,
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
  PR-comment URL of every external review (Claude Code and Codex, full and delta) with the head
  SHA it reviewed;
- every deviation proposed, with the arbiter's verdict block and how the train continued;
- every finding and whether it was fixed, per repair round, with the convergence count for each
  round, plus the exact halt reason and resumable session id when a child exhausted its budget.

Halts include: missing/ambiguous or revoked authorization; arbiter needs the human; an unfixable
blocker, non-convergence or blockers at the three-round cap; an incomplete required review after
its retry; a child that dies twice; exhausted child capacity/budget; red post-merge `main`.
Pending CI and non-blocking polish are not halts. Never waive a required check to continue.

Do not claim a train completed unless every row landed sequentially and `main` CI was green on the
last merge commit. Do not merge anything after a stop condition.
