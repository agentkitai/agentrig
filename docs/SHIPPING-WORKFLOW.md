# Shipping: parallel verification, bounded repair

This is the shared review/repair policy for `dogfood`, `ship`, `topic`, `review`, and
`land`. Read it with the selected skill. It replaces their historical per-fix dual
review loops, not their authorization, isolation, testing, or merge gates. These
are model-facing instructions, not a runtime enforcement mechanism.

## 1. CI and review are independent tracks

Builders and fixers run the local green trio, fail-first regressions, and meaningful
mutations before pushing. After opening/updating the PR, report its head and current
CI state immediately; do not wait for hosted CI or run private external reviews.
The conductor (or standalone dogfood author) starts the initial Claude Code and
Codex reviews in separate owned worktrees while hosted CI runs. Record both review
job IDs, the reviewed SHA, and the CI run IDs; monitor all three tracks together.

Reviewers report pending CI as pending and return their code verdict without waiting
for CI. A code-review pass is not permission to merge. Only the lander joins the
gates: resolved reviews AND successful required checks on the actual current head.
Missing, pending, cancelled, stale, or failed checks never count as green. Local
test failures are not excused by a green hosted run. Follow docs/TESTING.md for
environment-limited checks, explicitly preserving each reviewer's limitations.

Freeze the author branch during a review batch. If it changes anyway, retain the
old review as evidence for its SHA, inspect OLD..NEW, and apply §3; do not discard
valid reviews and restart the whole pair solely because the head moved. An aborted
initial pass is incomplete: both initial reviews must finish before landing.

## 2. Disposition every finding once

Keep a `## Review disposition` ledger in the PR body: reviewer comment/finding ID,
severity, concrete scenario, blocking or non-blocking, rationale, resolution/evidence,
and affected SHA. Distinguish verified defects from optional suggestions. A concrete
proposed fix alone does not make a suggestion a merge blocker.

Persist `Repair round: N/3` in the PR body (initially 0/3), and each round's OLD/NEW,
assigned blocker IDs and outcome. Increment before spawning each repair batch, not
after it completes. Every entry point, including ship and standalone dogfood, reads
this record on resumption; reconstruct missing counts from recorded handoffs/reviews
with evidence, never silently reset them. If the count cannot be established, halt
with that missing evidence rather than grant a fresh allowance. The lander verifies
the record against the review history before merging.

- **Blocking:** unmet task acceptance, incorrect required behavior, security or
  authority regression, data loss, failing required checks, material missing proof,
  or unapproved contract/authorization changes. Severity does not excuse these:
  even a LOW acceptance failure blocks. All HIGH findings block. Uncertain impact
  stays blocking until evidence establishes otherwise. Contract deviations still
  go through the arbiter; do not silently weaken the task to close a finding.
- **Non-blocking defect:** a verified minor defect with evidence that it affects
  neither required behavior nor the safety/verification gates above. Preserve its
  severity and scenario; record why deferral is safe. File one `review-residual`
  issue per actual deferred defect and link it under `## Residuals` in the PR body.
  Include file:line, scenario, proposed fix, PR/head, and original review URL. Do not
  spend repair rounds merely to postpone creating that same issue.
- **Advisory:** preference, cosmetic polish, or optional extension without a concrete
  failure of the task. It is advisory, not a new acceptance criterion or repair round.
  Record advisory followups at the end of the roadmap when useful; otherwise retain
  the disposition in the PR. Do not create an issue for every suggestion.

Do not relabel a real LOW defect as advisory. Do not implement non-blocking polish
inside a blocker repair batch. An alleged defect may be rebutted only with reproducible
evidence in the ledger; disagreement about contract or authority goes to the arbiter.
No finding is silently dropped, and an issue number never makes a blocker landable.

## 3. Batch fixes; review only material deltas

Collect both initial verdicts before one repair batch. Give the fixer all blocking
finding texts/URLs, not the advisory list as new requirements. Keep the same PR.
Re-run the local trio after repairs, retain fail-first and mutation evidence, push,
then return immediately so CI overlaps any necessary focused review.

Classify the complete delta since the last reviewed SHA, including CI/conflict fixes:

For conflict repairs, merge main into the branch; never rebase or force-push. Before
preparing a focused pass, verify OLD is an ancestor of NEW. If history was externally
rewritten, the old coverage chain is invalid: require the initial full pair on the
rewritten head, preserving the repair counter rather than certifying a false delta.

- **Material:** changes to executable behavior, security/authority, public interfaces,
  dependencies, task/skill workflow rules, or meaningful test expectations/coverage.
  Uncertain deltas are material. Use ONE independent reviewer over OLD..NEW and its
  direct interactions, normally the reviewer who raised the blocker. State the
  selected reviewer and reason. No fresh dual/full pass for each fix or commit.
- **Mechanical:** only spelling/formatting, broken links, or factual PR/STATUS receipts
  without changed guarantees. Record the diff, relevant checks and why it is mechanical
  as `self-verified mechanical delta; not independently re-reviewed`. A small executable
  fix is not mechanical. Prior independent reviews remain evidence for unchanged code.

A focused reviewer verifies closure of the assigned blockers, tests the changed
behavior and relevant mutations, and checks direct regressions. Do not re-audit
unchanged code or demand optional cleanup. Newly discovered real blockers still
count; non-blocking observations go to §2, not another repair batch. Initial full
reviews keep the green trio; focused reviews run the affected checks and mutations,
with the author's full trio and exact-head hosted CI still required for landing.

Per PR, at most THREE repair rounds, not a target. Normally there is one batched fix
and at most one focused review. Each round must close its assigned blockers without
reopening closed ones. A new blocker may use the next round; an unresolved assigned
blocker, reopened blocker, or blockers remaining at the cap halt with evidence.
Do not reset the counter after a push, conflict, restart, or reviewer change. Adopted
PRs recover the ledger and review history. Never land unresolved blockers to meet a cap.

## 4. Final join and receipt

The lander checks the initial review pair, every material delta's focused verdict,
mechanical-delta evidence, and each finding's disposition. Preserve explicit task
merge authorization and later revocations. Require green exact-head CI, then merge
one PR at a time and watch CI on the actual merge commit before continuing.

Report initial review URLs and SHAs, focused reviews and ranges (if any), mechanical
deltas, deferred defects/issues and advisory disposition, exact-head and post-merge
CI links, and child session IDs. Record review/CI start and finish times so overlap
and round count can be checked rather than claimed. Do not claim a workflow speedup
from instruction tests alone; a subsequent live shipment must establish that.
