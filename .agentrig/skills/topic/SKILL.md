---
name: topic
description: Run one authorized roadmap band as a sequential release train - dogfood each row, review independently, repair to clean in a bounded converging loop, arbitrate deviations, land; halt only for a human.
---

## Operative declared-checks policy (issue #395)

This policy supersedes shipping policy §3's reviewer-trio rule and conflicting inherited
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
GREEN BEFORE launching the review pair (and before a focused delta reviewer). Give both
reviewers the named same-head receipts, not builder reasoning. Reviewers inspect code,
contracts and targeted mutation probes; reviewers do NOT run checks, bootstrap or preflight.
They may run narrow tests for a specific finding/mutant, never repeat the full declared suite.
For empty steps give reviewers the explicit none receipt. Keep the two independent code
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

The two initial external review comments must each start with this exact heading form:
`## External review — <reviewer> (<model>) — head <SHA> — merged with origin/main <MAIN> — full`
Substitute the actual reviewer, model, full reviewed PR head SHA and full origin/main SHA.
The conductor (or standalone dogfood author) posts one for Claude Code and one for Codex.
No alternate heading is valid for posting,
acceptance or rerun detection. Require the complete heading, not just its prefix or a SHA
elsewhere in the body. This form is for the initial full pair, not focused delta verdicts.

The Claude Code initial heading model must equal `claude-opus-5`; any other Claude model is a missing required initial review, not a receipt that satisfies the pair.

## Review scratch cleanup

Human cleanup contract (verbatim):

> After the initial review pair and after any focused delta review, the conductor removes the review output directory (`OUT`) and the reviewer temporary roots in addition to both worktrees and the `review-base-NN` branch; builders and fixers remove their own proof TMPDIR after recording its results in the PR body. Removal happens only after joining every job and verifying restored tracked/index state, and never touches the author's tree.

Operative resource mapping: initial reviews remove the pass’s recorded owned `WT`, `CODEX_WT` and `review-base-NN`; focused reviews remove the pass’s recorded owned single `WT` and unique `BASE`. Both also remove any recorded owned conductor-trio tree and conductor-trio temporary root (including extra exact-head proof trees). Both remove their recorded owned `OUT` and reviewer temporary roots only after all jobs are joined, tracked/index restoration is verified, and evidence is persisted.

Apply this sequence to successful, failed, retried, stale and interrupted passes alike, including every abbreviated cleanup instruction below:

1. Join every job and subprocess, including installs, retries and mutations.
2. Verify recorded HEADs and restored tracked/index state; an unrestored mutation or unfinished writer blocks removal and invalidates the review, never erases evidence.
3. Persist verdicts, provenance, proof results and failure receipts in the PR before deleting their only local copies.
4. Remove only this pass's recorded owned worktrees, base ref, reviewer temporary roots, any conductor-trio tree and conductor-trio temporary root, and `OUT`; never the author's tree or old unowned scratch.

For a focused pass remove its one worktree and unique `BASE` instead of the initial pair and `review-base-NN`. Also remove any recorded owned conductor-trio tree and conductor-trio temporary root. Remove temporary roots outside `OUT` explicitly; roots inside it are removed with it. Record the removed paths and cleanup result. If restoration cannot be verified, preserve the owned evidence and halt rather than force cleanup. Read/combine the verdicts before removing `OUT`.

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
4. Run the **external review pass** on the PR's current head: two reviewers that share nothing
   with the builder, in parallel with each other AND hosted CI, in separate reviewer-owned
   worktrees you prepare. Start the CI watch and reviews as soon as the PR is available; green
   hosted CI is a landing gate, not a review-start gate. First check whether it already ran:
   if the PR carries two comments with the complete initial full review heading defined above,
   naming the CURRENT head SHA in the heading, one from Claude Code and one from Codex,
   do not run the pass again —
   read those two comments as its result and continue at **Combine**.
   The recorded `<MAIN>` is historical provenance: it documents the origin/main merge base
   reviewed by that pass and need not equal current `origin/main`. A moved main uses the existing
   conflict and material-delta rules in shipping policy §3; a clean advance re-verifies exact-head CI
   under shipping policy §1’s CI-staleness rule, not a redundant initial pair.
   For older heads, recover
   the review ledger and inspect uncovered deltas under shipping policy §3 instead of restarting
   the initial pair. An incomplete initial pair still requires both reviews. Never pass the builder's report,
   reasoning, findings, or claimed evidence to either reviewer; the PR and the repository are their
   only evidence.
   - **Prepare.** One `bash` call for preparation, then one call per install. This applies to conductor
     preparation only, and only when the nonempty declaration requires bootstrap. Every value
     the preparation call uses is assigned inside it before use:
     `BRANCH=$(gh pr view NN --json headRefName --jq .headRefName)`;
     `HEAD=$(gh pr view NN --json headRefOid --jq .headRefOid)`; then
     `git fetch origin main "$BRANCH"`, `WT=$(mktemp -d)`, `echo "$WT"`, `git worktree add "$WT" "$HEAD"`,
     `git -C "$WT" branch -f review-base-NN origin/main` (create it inside the worktree so
     `git -C "$WT"` sees it); assert
     `[ "$(git -C "$WT" rev-parse HEAD)" = "$HEAD" ] || stop the pass (the worktree is not at the
     PR head)` (remove all recorded owned reviewer trees, any conductor-trio tree and conductor-trio temporary root, `review-base-NN`, reviewer temporary roots and `OUT` under **Review scratch cleanup** before stopping), and record
     `MAIN=$(git rev-parse origin/main)`. Require `git merge-base --is-ancestor "$MAIN" "$HEAD"`.
     If main integration would advance HEAD, stop: update the PR branch and re-prove its new head before review.
     Conflicts are findings for §3, never permission to review an integration-only commit as PR HEAD.
     Remove recorded owned scratch resources before returning for repair. A conflict-stopped pass
     is not complete; restart the incomplete full pair on the new PR head.
     `WT` belongs exclusively to Claude. Set `REVHEAD=$HEAD`; REVHEAD must equal the current PR HEAD.
     Create Codex's independent tree at that exact commit: `CODEX_WT=$(mktemp -d)`;
     `echo "$CODEX_WT" "$REVHEAD"`; `git worktree add --detach "$CODEX_WT" "$REVHEAD"`.
     Assert both trees have the same HEAD and are clean before launching either reviewer.
     `OUT=$(mktemp -d)`
     holds every output file; never write review artifacts inside either tree. Create independent
     temporary roots with `mkdir "$OUT/claude-tmp" "$OUT/codex-tmp"`; pass the corresponding
     command-local `TMPDIR` below. Record these paths and the actual PR review SHA BEFORE
     installing dependencies. The conductor executes bootstrap and preflight in separate calls, each with `timeoutMs` at least 600000; empty declarations execute neither. Reviewers do not bootstrap or preflight. Record all paths
     and REVHEAD before any conductor execution; keep reviewer trees read-only except
     restored targeted mutation probes. Dependency preparation belongs to the conductor.
     End preparation with `echo "$WT" "$CODEX_WT" "$OUT" "$REVHEAD"` so each path is recorded.
     `bash` has no cwd field and no shell state survives between calls: record all
     three absolute paths and REVHEAD like job ids, and substitute
     them literally into every later command. Never share mutable sources, build output or
     `node_modules` between the reviewers; worktrees are cooperative isolation, not an OS sandbox.
   - **Independent conductor checks — BEFORE reviewers.** Create a separate fresh tree
     at PR HEAD, record its path/TMPDIR, resolve the declaration and run bootstrap, optional
     preflight and ordered named steps under the operative policy. Require GREEN before
     launching either job below; for empty steps record the explicit none receipt. Record
     each name, command, exit code, UTC start/end and counts in `<OUT>/codex-trio.md` (legacy
     artifact name only). Verify restored tracked/index state and unchanged head. Require REVHEAD equals current PR HEAD; otherwise stop and re-prepare/re-prove. Supply the receipts
     to Claude's brief and Codex's review context before launch; never builder reasoning.
     Focused reviews use the same pre-launch conductor gate at NEW.
     Record conductor paths, including any retry, before executing in its tree. Before cleanup
     verify all Codex attempts and subprocesses have completed, and join conductor jobs too.
     Persist named receipts before posting; never share an executing reviewer tree.
   - **Claude job** — `bash` with `background: true`:
     ```
     cd <WT> && env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION \
         -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN -u CLAUDE_CODE_BRIDGE_SESSION_ID -u CLAUDE_PID \
       TMPDIR=<OUT>/claude-tmp claude -p --model claude-opus-5 --permission-mode dontAsk --allowedTools 'Read,Grep,Glob,Bash,Edit,Write' \
         --disallowedTools 'Bash(git push),Bash(git push *),Bash(gh pr merge),Bash(gh pr merge *)' \
         --output-format json --no-session-persistence \
         "Review PR #NN at head SHA REVHEAD. Read .agentrig/skills/review/SKILL.md and follow it. You exclusively own this isolated review worktree, at the actual PR head containing recorded origin/main, with dependencies installed: skip section 2 and verify that state yourself. Inspect the supplied named exact-head conductor receipts; do not run declared checks. Review code and run only targeted mutation probes here, restore each mutant and join every subprocess before reporting; never touch a sibling or author tree. Do not push, merge, commit, change permission settings, spawn children or invoke auxiliary models. Assume the author is wrong; verify every finding against the code before reporting it; report file:line, severity (HIGH/MEDIUM/LOW), a concrete failure scenario and a fix. Report the exact head SHA you reviewed." \
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
     on the same head halts the train (post any surviving review and persist verdicts, provenance, proof results and failure receipts in the PR; then remove both reviewer trees, any conductor-trio tree and conductor-trio temporary root, `review-base-NN`, reviewer temporary roots and `OUT` under **Review scratch cleanup**; only then halt the train). A pass with
     one surviving review is not a pass — halt with the surviving review posted (post any surviving review and persist verdicts, provenance, proof results and failure receipts in the PR; then remove both reviewer trees, any conductor-trio tree and conductor-trio temporary root, `review-base-NN`, reviewer temporary roots and `OUT` under **Review scratch cleanup**; only then halt the train); the train never lands on one reviewer.
   - **Assert the model and extract the Claude review:**
     ```
     node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const m=Object.keys(r.modelUsage??{});if(m.length!==1||m[0]!=="claude-opus-5"){console.error("claude review ran on "+(m.join(",")||"unknown")+", not claude-opus-5");process.exit(2)}require("fs").writeFileSync(process.argv[2],JSON.stringify(m));process.stdout.write(String(r.result??""))' "<OUT>/claude.json" "<OUT>/claude-models.json" > "<OUT>/claude.md"
     ```
     A non-zero exit here is a dead job under the Wait rule above (retry once, then halt if both
     are dead), never a review to use.
   - **Assert the Codex model from stderr:**
     After the Codex job exits successfully, extract its actual model from the CLI stderr header:
     ```
     node -e 'const s=require("fs").readFileSync(process.argv[1],"utf8");const m=[...s.matchAll(/^model:[ \t]*(.*)$/gm)].map(x=>x[1].trim());if(m.length!==1||!/^gpt-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(m[0])){console.error("missing, malformed or ambiguous Codex model");process.exit(2)}process.stdout.write(m[0])' "<OUT>/codex.err" > "<OUT>/codex-model.txt"
     ```
     Missing, malformed or ambiguous model provenance halts the pass; never guess or post a placeholder.
     Require exit zero before composing a comment. Retain stderr as provenance and record the
     validated model with the job receipt. Join jobs and clean owned trees before halting.
   - **Provenance.** Join both jobs and their subprocesses, then confirm both reviewer trees have
     the recorded `<REVHEAD>` (actual PR HEAD on a full pass; NEW on a delta) and clean tracked/index state. Any unrestored mutant, changed
     HEAD or unfinished writer invalidates that review; record it explicitly and use the existing
     dead-job retry rule, never clean away the evidence and count the pass. The conductor owns
     cleanup: every removal below and in retry/staleness paths follows **Review scratch cleanup**,
     including BOTH reviewer trees, any conductor-trio tree and conductor-trio temporary root, the shared `review-base-NN` ref, reviewer temporary roots and `OUT`. Before posting, re-read the PR head (`gh pr view NN --json headRefOid`): if
     it no longer equals `HEAD`, retain the verdict for the recorded SHA but do not call the new
     head reviewed. Join/clean up, then classify and cover the uncovered delta under shipping
     policy §3; never silently certify a different head or restart both reviews by default. Before initial posting, validate every reviewed SHA claim against current `HEAD`, including any stripped heading SHA. Reject stale claims and empty or heading-only verdicts; halt without posting on validation failure. Claude still must explicitly claim its own HEAD below; Codex proof cannot substitute for verdict text. Compose each comment body
     with the canonical heading as its FIRST LINE, not a prefix check. Strip leading blanks
     and duplicate leading external-review headings from the reviewer body; retain the verdict.
     Replace only the `"HEAD"` shell argument to each validator and the helper's `"HEAD"`
     and `"MAIN"` arguments with the recorded full 40-hex SHAs. Never globally replace HEAD
     inside the node validator source: it is a literal stale-placeholder detection token.
     Claim parsing ignores inline Markdown emphasis/code delimiters, consumes intervening
     SHA/commit/head labels before the claim, rejects literal HEAD placeholders separately
     from hex comparison, and accepts only matching SHA prefixes of 7–40 hex characters.
     Bounded claim grammar (case-insensitive, anywhere in verdict): after removing inline
     Markdown delimiters, recognize head, head_sha (normalized to headsha), or reviewed,
     followed by zero or more SHA/commit/head/at labels, optional colon/equal, then hex or HEAD.
     Reject 41-or-more hex tokens, stale `head_sha:` and stale `Reviewed at` claims.
     This deliberately fails closed on a prior `reviewed commit <stale>` discussion mention;
     rewrite historical discussion without that claim form before posting. It is not natural-language
     attribution: other prose is not a SHA claim; Claude still must explicitly name its reviewed HEAD.
     Invoke the repo-shipped helper verbatim below, not inline composition.
     `<WT>` is the recorded absolute reviewer-owned reviewed worktree, never the author checkout;
     the explicit `cd` makes both commands usable from an unrelated cwd. It reads the model
     only from the validated model file and asserts the exact first line with `head -1` BEFORE
     each `gh pr comment NN --body-file` call. Nonzero means stop; no manual posting fallback.
     The heading suffix `head HEAD — merged with origin/main MAIN — full` uses full SHAs,
     never literal placeholders. Keep these stale SHA/verdict gates before invoking the helper.
     ```sh
# Claude posting gate
node -e 'const fs=require("node:fs"); const s=fs.readFileSync(process.argv[1],"utf8"); const expected=process.argv[2]; const claimText=s.replace(/[`*_]/g, ""); const claims=[...claimText.matchAll(/\b(?:headsha|head|reviewed)(?:\s+(?:SHA|commit|head|at))*\s*[:=]?\s*([0-9a-f]{7,}|HEAD)\b/gi)]; if(claims.some(m=>{const c=m[1].toLowerCase(); return c==="head" || c.length<7 || !expected.toLowerCase().startsWith(c);})) process.exit(2); const body=s.replace(/^(?:[ \t]*\r?\n|## External review[^\n]*(?:\n|$))*/, ""); if(!body.trim() || body.trim().split(/\r?\n/).every(l=>!l.trim() || /^#+(?:\s|$)/.test(l))) process.exit(2); process.stdout.write(s);' "<OUT>/claude.md" "HEAD" > "<OUT>/claude-validated.md" || exit 2
node -e 'const fs=require("fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(m.length!==1||m[0]!=="claude-opus-5")process.exit(2);process.stdout.write(m[0])' "<OUT>/claude-models.json" > "<OUT>/claude-model.txt" || exit 2
cd "<WT>" && node scripts/post-review-comment.mjs NN "Claude Code" "<OUT>/claude-model.txt" "<OUT>/claude-validated.md" "HEAD" "MAIN" "<OUT>/claude-comment.md" || exit 2
     ```
     For Codex, in the posting call append conductor declared-check receipts only after verdict validation.
     Apply the same targeted substitution described above (only shell SHA arguments), never
     edit the validator source or guess the model from the verdict:
     ```sh
# Codex posting gate
node -e 'const fs=require("node:fs"); const s=fs.readFileSync(process.argv[1],"utf8"); const expected=process.argv[2]; const claimText=s.replace(/[`*_]/g, ""); const claims=[...claimText.matchAll(/\b(?:headsha|head|reviewed)(?:\s+(?:SHA|commit|head|at))*\s*[:=]?\s*([0-9a-f]{7,}|HEAD)\b/gi)]; if(claims.some(m=>{const c=m[1].toLowerCase(); return c==="head" || c.length<7 || !expected.toLowerCase().startsWith(c);})) process.exit(2); const body=s.replace(/^(?:[ \t]*\r?\n|## External review[^\n]*(?:\n|$))*/, ""); if(!body.trim() || body.trim().split(/\r?\n/).every(l=>!l.trim() || /^#+(?:\s|$)/.test(l))) process.exit(2); process.stdout.write(s);' "<OUT>/codex.md" "HEAD" > "<OUT>/codex-validated.md" || exit 2
[ -s "<OUT>/codex-trio.md" ] || exit 2
cd "<WT>" && node scripts/post-review-comment.mjs NN "Codex" "<OUT>/codex-model.txt" "<OUT>/codex-validated.md" "HEAD" "MAIN" "<OUT>/codex-comment.md" "<OUT>/codex-trio.md" || exit 2
     ```
     The conductor posts full outputs through those helper calls (not a rewritten summary), and
     record both comment URLs — they stand in for reviewer session ids. A body over 60,000
     characters is split by the helper into bounded numbered comments `(1/2)`, `(2/2)`
     below the unchanged canonical first line; concatenate payloads to recover the full output. Read/combine the verdicts and persist
     their receipts first. Then, subject to **Review scratch cleanup**,
     `git worktree remove --force <WT>`, `git worktree remove --force <CODEX_WT>` and `git branch -D review-base-NN`;
     remove any recorded owned conductor-trio tree and conductor-trio temporary root, the reviewer temporary roots and `OUT` as well.
   - **Combine.** Strip `<CODEX_WT>/` from Codex file:line locations and `<WT>/` from Claude's, if present, so findings are
     repo-relative. Tag every finding `[claude]` or `[codex]`, collapse duplicates (same file:line
     and the same scenario), and sort the union under step 5. Claude's review must also name
     `HEAD` as the SHA it reviewed; Codex echoes no SHA and needs none, because the worktree was
     asserted to be at `HEAD` (the actual reviewed PR head on a full pass).
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
  with OLD as the diff base. For Claude, brief OLD/NEW, blocker URLs, affected checks/mutations and
  direct interactions; for Codex use `codex review --base <unique-old-ref>`.
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
verify both initial canonical headings in the actual comments, including the pinned Claude model,
reviewed head and main provenance. Verify `## Review disposition` contains dispositions for every
finding from both initial reviews and every focused review, and `## Residuals` has issue links or
explicit `none`. Verify all blocker closures and delta coverage through current head. Missing
headings, comments, dispositions or residual records halt BEFORE land-child spawning; a URL alone
or a private summary is not verification. Persist edits then read back again if anything changes.

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
Pending CI and non-blocking polish are not halts by themselves; unresolved classification disagreement may halt for the human. Never waive a required check to continue.

Do not claim a train completed unless every row landed sequentially and `main` CI was green on the
last merge commit. Do not merge anything after a stop condition.
