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

Test fixture guidance: keep new tests network-free. Use a fake `ModelProvider` for provider
behavior and an injected `fetchFn` for HTTP boundaries; never require live provider credentials
or network access. On macOS, canonicalize `tmpdir()` fixtures with `realpath` before comparing
paths or asserting containment (`/var` and `/private/var` may name the same directory). Follow
`docs/TESTING.md` and keep check scratch outside the worktree under an external `TMPDIR`.

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

The pre_spawn hook owns dispatch provenance and the pre-edit source comparison;
fixers do not post a second manual pre-push dispatch handoff. Carry the
persisted receipt, exact finding identities and counter in the fixer task.
Hook refusals remain binding; do not manufacture replacement provenance.

- Before every push, builders and fixers must rerun all touched instruction-contract and skill-text test files against a CRLF copy of the entire `.agentrig/skills` tree (normalize LF before converting to CRLF), point `AGENTRIG_TEST_SKILLS_ROOT` at that copy under the proof `TMPDIR` outside Git ancestry, and record start/end times, exact commands, exits and test counts next to the declared check receipts in the PR.

- Clear message: what changed, why, anything surprising. No model identifiers in commits, PR
  titles/bodies, or code comments. The single sanctioned PR-body exception is a verbatim human authorization quote that itself contains such an identifier: preserve the quote unchanged, but never add model or agent authorship attribution.
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

## 8. Independent reviews — standalone only

If this is a child run, **skip this step** and hand off to the conductor at step 10;
the conductor runs every declared reviewer slot itself.
After §7's persisted phase handoff and builder cleanup, the standalone conductor runs
this pass outside the removed builder tree; a later repair reattaches the branch under §1.
Standalone runs use the **declared reviewer slots** in `.agentrig/config.json` as the
sole selection authority; never infer reviewers from CLI names or credentials.
Zero slots: record the no-review outcome and launch/post/clean no reviewer artifacts.
One slot: run exactly that slot. Two slots: run exactly those slots concurrently.
Run every declared slot independently, including
custom API slots. Resolve each slot's adapter and pinned model; unknown adapters fail
closed. No undeclared fallback reviewer may be substituted.

Follow **topic §2 step 4** verbatim for the whole per-slot lifecycle: freeze HEAD/MAIN,
create a detached worktree per slot, build its fresh-context prompt with the exact-head
receipt, launch through `scripts/reviewer-adapters.mjs`, wait for all declared jobs,
validate each verdict into `<PREFIX>.validated.md`, then post **that validated file**
through `scripts/post-review-comment.mjs` with provenance and receipt attachments.
Every validation or posting failure exits 2 before any success or merge gate.
The canonical helper must execute its `head -1` assertion before posting.
Use each returned slot-specific comment URL; never fabricate a fixed pair of URLs.
Apply the shared **Review scratch cleanup** contract to all declared slots only,
including API jobs and scratch artifacts. For zero slots record cleanup as not applicable.

Reviewers never run full declared checks or edit the author's worktree. A reviewer that
finds a missing proof returns to the author for a new receipt. If any declared review
finds a genuine bug, repair it, refresh the exact-head receipt, and refresh those reviews;
all declared reviews must be resolved before the next step.

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
changes, self-verified evidence for mechanical changes. No per-commit full/dual review loop.
Use topic §3's **Cover the delta** procedure for isolated preparation, conductor proof, launch,
provenance and cleanup; the standalone author owns that procedure without becoming a topic train.
Carry the initial declared slots and subsequent delta evidence through the current head. At most three
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
