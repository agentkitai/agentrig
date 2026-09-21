---
name: dogfood
description: Build and verify one change - fresh branch, green declared checks, PR; children hand off, standalone runs review and land only with explicit task merge authorization.
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
Only configured slots count. A heading whose model differs from that slot's configured pin, an
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

## 3. Prove declared checks green

Apply the operative policy above: run bootstrap, optional preflight and ordered named steps
with individual exit-code receipts. Never pipe away a failing exit. Run full suites in a
background job with command-local TMPDIR outside Git ancestry; join all jobs before cleanup.
Never skip, disable or quarantine tests to get green.

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

## 8. Declared external review

A child builder stops after push and draft-PR handoff when its task says to skip external review.
Otherwise, only a standalone run may apply the declared external-review contract above. Independent
conductor checks are mandatory before any launch; author-tree proof is not independent evidence.
Reviewers receive the receipts, review code only, and may use optional targeted reviewer-owned
probes. Apply the configured zero-, one-, or two-slot path exactly and let hosted CI overlap.

## 9. Disposition findings and repair blockers

Follow shipping policy §§2–3 for all standalone and child flows. Distinguish verified defects
from optional suggestions: the latter are advisory, not a new acceptance criterion or repair
round. Record advisory followups at the end of the roadmap when useful. Do not relabel a real LOW defect
as advisory. Record every finding's disposition and evidence in the PR body.

For every repair, attach the existing branch in an owned worktree per §1.
Batch blocking fixes with fail-first proof and meaningful mutations, re-run the full green declared checks,
push, record a new phase handoff in the PR body, and repeat builder worktree and proof TMPDIR cleanup
under §1 before resuming review; report OLD/NEW immediately. Do not add deferred polish to the batch. The conductor (or
standalone author) classifies the whole delta: ONE independent focused review for material
changes, self-verified evidence for mechanical changes. No per-commit full-review loop.
Use topic §3's **Cover the delta** procedure for isolated preparation, conductor proof, launch,
provenance and cleanup; the standalone author owns that procedure without becoming a topic train.
Carry the configured initial review set and subsequent delta evidence through the current head. At most three
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
  run the declared checks, update STATUS, commit, push, open or update the PR. A pushed branch with an
  honest PR body beats a perfect uncommitted worktree.
