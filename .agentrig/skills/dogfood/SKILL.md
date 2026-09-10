---
name: dogfood
description: Build and verify one change - fresh branch, green trio, PR; children hand off, standalone runs review and land only with explicit task merge authorization.
---

# Dogfood flow — how a change ships in this repository

Read [shipping policy](../../../docs/SHIPPING-WORKFLOW.md) before acting. Its shared
CI scheduling, finding disposition, material-delta and convergence rules govern this flow.

Follow every step, in order. The steps encode failures that already happened once; skipping one
tends to reproduce the failure that created it.

## 1. Branch

- `git fetch origin main` and branch from `origin/main`: `feat/<slug>`, `fix/<slug>`, or
  `docs/<slug>`. Never work on main. Never stack new work on a branch whose PR is still open —
  say so and stop instead.
- Scope to ONE issue or one roadmap row. If the work grows mid-flight, finish the scoped part and
  note the rest for a new issue.

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
  *(done)* |`): `grep -E '^\| R[0-9]' docs/ROADMAP.md | grep -v '(done)'` is the live backlog, and
  a row left unmarked is a row the next train may rebuild.

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
wait for hosted CI. Standalone authors start §8 while CI runs and join the gates at landing.

## 8. Two external reviews, in parallel, as background jobs

**Under `ship` or `topic`, skip this section entirely** — as a builder, a continuation builder,
or a fixer. The conductor runs the external review pass (`topic` §2 step 4) after you stop; that
review is the one that counts. Running your own here doubles the spend and, worse, turns your fix
into a private review loop the conductor cannot see: the R4a fixer spent thirty of its fifty-four
minutes waiting on three rounds of self-arranged reviews and widened its diff on their findings,
with the train's own external review pass still to come. A topic child's job ends at the push and the report.

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

Batch blocking fixes with fail-first proof and meaningful mutations, re-run the full green trio,
push, and report OLD/NEW immediately. Do not add deferred polish to the batch. The conductor (or
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
- Standalone, if the human explicitly authorized merging the PR for this named task, finish the
  independent reviews and required repairs, then continue with the land skill without asking for
  a second approval. Carry the verbatim authorization and task-to-PR binding; all land preconditions,
  exact-head CI and post-merge CI remain mandatory. Without that authorization, stop at the reviewed PR
  and report that merge authorization is still required. Tool permissions and YOLO are not human
  merge authorization; later revocation or narrowing wins.
- When the supervisor's budget warning arrives, stop starting work: finish the current change,
  run the trio, update STATUS, commit, push, open or update the PR. A pushed branch with an
  honest PR body beats a perfect uncommitted worktree.
