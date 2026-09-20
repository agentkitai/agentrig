---
name: dogfood
description: Build and verify one change - fresh branch, green trio, PR; children hand off, standalone runs review and land only with explicit task merge authorization.
---

# Dogfood flow — how a change ships in this repository

Read [shipping policy](../../../docs/SHIPPING-WORKFLOW.md) before acting. Its shared
CI scheduling, finding disposition, material-delta and convergence rules govern this flow.

Follow every step, in order. The steps encode failures that already happened once; skipping one
tends to reproduce the failure that created it.

## Initial full review heading contract

The two initial external review comments must each start with this exact heading form:
`## External review — <reviewer> (<model>) — head <SHA> — merged with origin/main <MAIN> — full`
Substitute the actual reviewer, model, full reviewed PR head SHA and full origin/main SHA.
The conductor (or standalone dogfood author) posts one for Claude Code and one for Codex.
No alternate heading is valid for posting,
acceptance or rerun detection. Require the complete heading, not just its prefix or a SHA
elsewhere in the body. This form is for the initial full pair, not focused delta verdicts.

For acceptance or rerun detection, an initial review is present as a complete unnumbered single-comment review with the complete canonical heading, or when every numbered chunk (k/N), k=1..N, exists on the PR with the same complete canonical heading and consistent N; a heading alone or a partial set is missing review evidence. A nonzero helper exit may leave partial comments: preserve the OUT/*.receipt.json receipt, reconcile and remove all comments from that attempt before removing its receipt and retrying; never certify a partial review as complete.

## Review scratch cleanup

Human cleanup contract (verbatim):

> After the initial review pair and after any focused delta review, the conductor removes the review output directory (`OUT`) and the reviewer temporary roots in addition to both worktrees and the `review-base-NN` branch; builders and fixers remove their own proof TMPDIR after recording its results in the PR body. Removal happens only after joining every job and verifying restored tracked/index state, and never touches the author's tree.

Operative resource mapping: initial reviews remove the pass’s recorded owned `WT`, `CODEX_WT` and `review-base-NN`; focused reviews remove the pass’s recorded owned single `WT` and unique `BASE`. Both also remove any recorded owned conductor-trio tree and conductor-trio temporary root (including extra exact-head proof trees). Both remove their recorded owned `OUT` and reviewer temporary roots only after all jobs are joined, tracked/index restoration is verified, and evidence is persisted.

Use topic's **Review scratch cleanup** sequence for every initial and focused pass, including failure/retry/staleness paths. The standalone dogfood author assumes conductor cleanup duties for its reviews. Builders/fixers record command exit codes, test counts, fail-first/mutation results and times in the PR body, join every proof job, verify restored tracked/index state, then, after the branch is pushed and handoff is recorded in the PR body, remove their recorded owned worktree and proof TMPDIR under dogfood §1; do not wait for hosted CI. Keep proof TMPDIR outside Git ancestry per docs/TESTING.md.

## 1. Branch

- Builders, continuation builders and fixers work only in an owned worktree, not the
  author checkout. Run `git fetch origin main`; for new work create the owned worktree
  from `origin/main`: `git worktree add <path> -b <branch> origin/main`, using a
  `feat/<slug>`, `fix/<slug>`, or `docs/<slug>` branch. Run implementation and proof
  commands inside that worktree. Never change the author checkout's branch.
- For fixers or continuation builders preserving existing work, attach the existing branch
  with `git worktree add <path> <branch>` instead of creating/resetting it. If it is already
  attached to a recorded owned worktree, reuse that worktree only after its prior jobs have
  joined and ownership has been handed off; never detach or repurpose the author checkout.
  Never work on main. Never stack new work on a branch whose PR is still open — say so and
  stop instead; continuing or fixing that same PR is not stacking new work.
- Record the owned worktree path in the PR body. Builders and fixers remove their owned
  worktree after handoff is recorded in the PR body and the branch is pushed: join every job,
  verify restored tracked/index state (all intended edits committed, no probe changes left),
  and persist proof results before removing the worktree and their proof TMPDIR. Do not wait
  for hosted CI. The conductor removes any recorded owned leftovers after landing, after
  the same join/state checks; never remove the author checkout or an unowned worktree.
- Scope to ONE issue or one roadmap row. If the work grows mid-flight, finish the scoped part and
  note the rest for a new issue.

Standalone handoff is the recorded transition from builder to conductor, not a handoff to
another agent. At §7, after pushing and persisting proof, record this phase handoff in the
PR body; remove the owned builder worktree and proof TMPDIR under the same join/state/ownership
checks above before starting §8. Run conductor work from outside the removed tree; reviews
use fresh reviewer-owned trees. For each §9 repair, attach the existing branch in an owned
worktree per §1, push and record a new phase handoff, then repeat cleanup before resuming
review. Do not retain the builder tree while waiting for CI, merge authorization or landing.

Remove registered worktrees with `git worktree remove <path>`, then `git worktree prune`
after the recorded handoff and join/state/proof checks. Never use bare directory deletion
for a worktree; remove the owned proof TMPDIR separately.

## 2. Implement

Repository rules that bind (each has bitten before):

- New event type ⇒ zod variant + `renderEvent` case + a test. Add fields, never repurpose them.
- `memory` and `supervisor` import core **types only**. The CLI stays thin — logic lands in a
  package behind a seam.
- `raw/` is immutable; only `SessionStore.append` writes session logs.
- zod at every process/file boundary. Anything that reaches the system prompt without a model
  decision (names, descriptions, file content) is untrusted input: sanitize and bound it.
- Error messages and tool descriptions are model-facing API: a refusal must name the exact fix.

**Implementation plan — follow it when one exists.** If `docs/plans/<band>.md` exists for the
band your row belongs to (R5a → `docs/plans/R5.md`), read its section for your row before
writing code and build to it: it fixes mechanism, file-level changes, the test list and the
named mutants. The row text stays the contract and the plan is guidance under it; where they
disagree, the row wins. A departure from the plan is not a deviation, but it is recorded: list
each one with its reason under `## Plan departures` in the PR body, and the reviewer checks the
list against the plan. No plan file means no such section.

**Deviation gate — you do not change your own contract.** If the row, issue, or task you were
given turns out to be wrong, infeasible, or worse than an alternative (a different backend, a
dropped acceptance criterion, a wider scope), you may propose a change but never decide it:

- Write the proposal: the contract verbatim, what you want instead, why (a fact you can show, not
  a preference), what is lost, alternatives, and the exact roadmap/issue text you would write.
- Standalone: spawn an `arbiter` subagent with that proposal, the contract, and the human's
  authorization sentence, and proceed only on `VERDICT: APPROVE`. Under `ship` or `topic` you
  cannot spawn (children do not nest): commit and push what you have, stop, and end your report
  with the proposal under a `DEVIATION REQUESTED` heading — the conductor arbitrates and continues.
- An approved deviation is recorded three times: the arbiter's verdict block plus its session id
  under `## Deviations` in the PR body, the roadmap/issue edit matching the verdict's RECORD line,
  and the commit message that makes that edit. Never edit the row you are implementing without
  that record; a contract change without one is a HIGH review finding.
- `VERDICT: REJECT` means build the contract as written. If you believe that is infeasible, stop
  and report — the human decides, not you and not the arbiter.

## 3. Prove it green — real exit codes, no exceptions

```
pnpm build && pnpm test && pnpm typecheck
```

- Judge each command by its EXIT CODE, never by grepping output for a pass line: piping through
  `grep`/`tail` returns the pipe's status and has masked real failures twice. When capturing
  output, run the command first, echo `$?`, then inspect the log.
- Tests are network-free: fake `ModelProvider`, injected `fetchFn`, tmpdir fixtures wrapped in
  `realpath` (macOS `/var` is a symlink — CI has a macOS leg and this exact mismatch has failed it).
- Never skip, disable, or quarantine a test to get green.

## 4. Tests carry the proof

- **Fail-first**: every behavior change gets a test that fails with the change reverted. Verify
  that by actually reverting (copy the file aside, apply the mutant, run, restore) — do not assume.
- **Both directions**: a fix needs its constraint pinned too (the thing that must still fire, not
  just the thing that must stop firing).
- **Mutation checks on the security-relevant lines especially** — reviews have repeatedly found
  the most safety-critical condition is exactly the one no mutant targeted.

## 5. Documentation

- `docs/STATUS.md`: a section for this change — what shipped, decisions beyond the spec, rejected
  ideas, caveats a future reader would trip on — and the "Current roadmap row" line at the top,
  which names the row this PR completes and the next one. Update `docs/ROADMAP.md` if a row's
  contract moved, and mark the row you are completing `*(done)*` in its table cell (`| R2b
  *(done)* |`): `grep -E '^\| (H|E|R)[0-9]' docs/ROADMAP.md | grep -vE '^\| [^|]*\(done([),;]|[[:space:]])' | grep -vE '^\| [^|]*\(gate, not a PR\)'` is the actionable backlog.
  Both exclusions inspect only the row-label cell, never body references to done work or gates.
  Explicit gate-only labels are not expandable delivery rows: R17a remains open and unmarked,
  not delivered or waived. Other unmarked rows remain candidates under ROADMAP §5.

## 6. Commit and push

- Clear message: what changed, why, anything surprising. No model identifiers in commits, PR
  titles/bodies, or code comments.
- `git push -u origin <branch>`; on network failure retry with backoff.

## 7. Open the PR — after green, not before

`gh pr create` with a body that lists: summary, **every design decision beyond the spec** (with
the reasoning), `## Deviations` (every approved contract change with its arbiter verdict block and
session id, or "none"), verification (test count, what the new tests pin, which mutants were
killed), and known caveats. If the implementation diverged from the issue, say where and why.

Children return immediately after push/PR with current CI state, including pending; do not
wait for hosted CI. Standalone authors record the phase handoff in the PR body, then
remove the owned builder worktree and proof TMPDIR under §1 before starting §8
while CI runs; join the gates at landing.

## 8. Two external reviews, in parallel, as background jobs

**Under `ship` or `topic`, skip this section entirely** — as a builder, a continuation builder,
or a fixer. The conductor runs the external review pass (`topic` §2 step 4) after you stop; that
review is the one that counts. Running your own here doubles the spend and, worse, turns your fix
into a private review loop the conductor cannot see: the R4a fixer spent thirty of its fifty-four
minutes waiting on three rounds of self-arranged reviews and widened its diff on their findings,
with the train's own external review pass still to come. A topic child's job ends at the push and the report.

Follow topic §2 step 4's conductor trio and shipping policy §3: the independently run,
same-head conductor checks supply the Codex trio evidence in the initial comment provenance.

For initial posting, preserve topic's stale SHA/verdict validation gates and validated model
files, then invoke these helper commands verbatim (replace only shell arguments NN, HEAD,
MAIN, <WT> and <OUT> with the recorded values; never globally substitute validator source):
```sh
cd "<WT>" && node scripts/post-review-comment.mjs NN "Claude Code" "<OUT>/claude-model.txt" "<OUT>/claude-validated.md" "HEAD" "MAIN" "<OUT>/claude-comment.md" || exit 2
cd "<WT>" && node scripts/post-review-comment.mjs NN "Codex" "<OUT>/codex-model.txt" "<OUT>/codex-validated.md" "HEAD" "MAIN" "<OUT>/codex-comment.md" "<OUT>/codex-trio.md" || exit 2
```
<WT> is the recorded absolute reviewer-owned reviewed worktree, never the author checkout.
These commands work from an unrelated cwd. Do not compose headings inline or post manually. The helper's exact `head -1` acceptance
runs before `gh pr comment NN --body-file`; nonzero stops posting. Land gate unchanged.

The standalone dogfood author assumes the conductor role in fresh reviewer-owned trees;
its author-tree proof is not independent evidence. Preserve each reviewer environment limitation
and require the author's trio, the independent trio and exact-head CI green for landing.
Never halt solely because Codex cannot run the suite; actual failures and missing proof
still follow the shared landing gates.

After §7's persisted phase handoff and builder cleanup, conduct reviews from
outside the removed builder tree using fresh reviewer-owned worktrees.

Start both with `bash` `background: true` and poll with `bash_job` using `waitMs` (never a sleep
loop, never a foreground command that a timeout can kill):

Prepare separate reviewer-owned worktrees at the recorded PR head, with independent installs,
build outputs and command-local TMPDIRs, as in topic §2 step 4. Never run a mutation probe in
the author's tree or a tree another reviewer is reading. Keep outputs outside both trees;
join both jobs and their subprocesses and verify unchanged HEADs and restored tracked/index
state before accepting verdicts. The conductor owns removal of both trees after joining.

- `codex review` over the full diff against `origin/main`.
- A `claude` review of the same diff, pinned to Opus and given the tools to VERIFY, not just read:
  `cd <WT> && TMPDIR=<OUT>/claude-tmp claude -p --model claude-opus-5 --permission-mode dontAsk --allowedTools 'Read,Grep,Glob,Bash,Edit,Write' --disallowedTools 'Bash(git push),Bash(git push *),Bash(gh pr merge),Bash(gh pr merge *)' --output-format json --no-session-persistence "…"`.
  Opus is strong enough for adversarial code review at a fraction of the cost, and the pin keeps
  review spend independent of whatever model the main session happens to be running. Without
  `--allowedTools` including Bash the reviewer cannot run vitest or probe built output, and its
  first line becomes "I could not execute the test suite" — a read-only review that verifies
  nothing, which the brief below explicitly forbids. `dontAsk` denies unallowed requests without
  prompting; unlike plan mode it permits the authorized tests and mutations. Never use a
  permission bypass, change permission settings, or relax required checks after a denial.
  Bash is not a filesystem sandbox: confine work to the owned review tree and temporary root.
  Direct push/merge denials are defense in depth, not containment against scripts, alternate
  spellings or shared Git metadata; private-fixture Git operations remain available for tests.
  Require no children/auxiliary models and assert sole `claude-opus-5` modelUsage using topic's
  extraction command before accepting the result; record the complete reviewed SHA.

Brief each reviewer to: assume the author is wrong, verify every finding against the actual code
before reporting it, and report file:line + severity + a concrete failure scenario + a fix.

**Under `ship` or `topic`, skip this section.** A builder spawned by either conductor stops at
the PR (§7) and does NOT run external reviews:
the conductor runs the same two external reviews itself, in separate reviewer-owned worktrees, against the PR head
(`topic` §2 step 4). Children may run on a local model and the review must never share the
builder's model; a child running the pair too would double every pass for no extra eyes. Your
task text says when you are a child. Standalone dogfood keeps both reviews because nothing else
reviews it.

## 9. Disposition findings and repair blockers

Follow shipping policy §§2–3 for all standalone and child flows. Distinguish verified defects
from optional suggestions: the latter are advisory, not a new acceptance criterion or repair
round. Record advisory followups at the end of the roadmap when useful. Do not relabel a real LOW defect
as advisory. Record every finding's disposition and evidence in the PR body.

For every repair, attach the existing branch in an owned worktree per §1.
Batch blocking fixes with fail-first proof and meaningful mutations, re-run the full green trio,
push, record a new phase handoff in the PR body, and repeat builder worktree and proof TMPDIR cleanup
under §1 before resuming review; report OLD/NEW immediately. Do not add deferred polish to the batch. The conductor (or
standalone author) classifies the whole delta: ONE independent focused review for material
changes, self-verified evidence for mechanical changes. No per-commit full/dual review loop.
Use topic §3's **Cover the delta** procedure for isolated preparation, installation, launch,
provenance and cleanup; the standalone author owns that procedure without becoming a topic train.
Carry the initial pair and subsequent delta evidence through the current head. At most three
repair rounds; unresolved blockers halt, never become landable just by filing issues.
Deferred non-blocking defects require issues; advisory suggestions do not.

## 10. Handoff or authorized landing

- Builder children never merge: report the PR number/head, verification and findings to the
  `ship` or `topic` conductor. This is a builder handoff, not completion of the overall workflow;
  the conductor owns independent review and authorized landing.
- Standalone conductor/landing work runs outside the removed builder tree after §7/§9
  handoff and cleanup. Do not retain or recreate the builder tree while waiting for CI,
  merge authorization or landing; only an actual repair attaches it again under §1.
- Standalone, if the human explicitly authorized merging the PR for this named task, finish the
  independent reviews and required repairs, then continue with the land skill without asking for
  a second approval. Carry the verbatim authorization and task-to-PR binding; all land preconditions,
  exact-head CI and post-merge CI remain mandatory. Without that authorization, stop at the reviewed PR
  and report that merge authorization is still required. Tool permissions and YOLO are not human
  merge authorization; later revocation or narrowing wins.
- When the supervisor's budget warning arrives, stop starting work: finish the current change,
  run the trio, update STATUS, commit, push, open or update the PR. A pushed branch with an
  honest PR body beats a perfect uncommitted worktree.
