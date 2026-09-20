# Shipping: parallel verification, bounded repair

This is the shared review/repair policy for `dogfood`, `ship`, `topic`, `review`, and
`land`. Read it with the selected skill. It replaces their historical per-fix dual
review loops, not their authorization, isolation, testing, or merge gates. These
are model-facing instructions, not a runtime enforcement mechanism.

## 1. CI and review are independent tracks

Builders and fixers run the local green declared checks, fail-first regressions, and meaningful
mutations before pushing. After opening/updating the PR, report its head and current
CI state immediately; do not wait for hosted CI or run private external reviews.
The conductor (or standalone dogfood author) first proves independent same-head declared checks green, then launches each declared reviewer
slot in a separate owned worktree while hosted CI runs. Record all declared review job IDs,
the reviewed SHA and CI run IDs; monitor these independent tracks together. Zero slots skip
external review only, recording `External review: none declared`.

Reviewers report pending CI as pending and return their code verdict without waiting
for CI. A code-review pass is not permission to merge. Only the lander joins the
gates: resolved reviews AND successful required checks on the actual current head.
Missing, pending, cancelled, stale, or failed checks never count as green. Local
test failures are not excused by a green hosted run. Follow docs/TESTING.md for
environment-limited checks, preserving environment evidence for conductor checks.

Freeze the author branch during a review batch. If it changes anyway, retain the
old review as evidence for its SHA, inspect OLD..NEW, and apply §3; do not discard
valid reviews and restart the whole pair solely because the head moved. An aborted
initial pass is incomplete: all declared initial reviews must finish before landing.

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

A blocker closes only with a fixer delta plus independent focused review, an evidence-backed
ledger rebuttal quoting a reproducible command and its result, or an arbiter verdict within the
existing arbitration allowance. Explicitly prohibit re-prompting the raising reviewer under the
conductor’s contract reading as closure; that is not independent delta coverage or a rebuttal.
Before launching a focused reviewer, resolve OLD and NEW to full commit IDs and require
strict forward ancestry using this executable gate. Retain the resolved IDs for preparation,
review provenance and coverage records; textual ref/abbreviation inequality is not a delta.

```sh
# Focused delta gate
OLD=$(git rev-parse --verify "$OLD^{commit}") || exit 1
NEW=$(git rev-parse --verify "$NEW^{commit}") || exit 1
[ "$OLD" != "$NEW" ] || exit 1
git merge-base --is-ancestor "$OLD" "$NEW" || exit 1
```
A same-head re-read is not delta coverage and cannot close a blocker.

Before fixer dispatch, ship/topic must persist the verified PR-body read-back receipt in the
GitHub PR body: `Pre-dispatch read-back: Repair round: N/3; blockers <IDs>; OLD <SHA>; verified <ISO ts>`.
Require successful edit and read-back of that receipt before dispatch and quote it in the handoff.
Land checks the same persisted receipt against the handoff and requires its timestamp before
dispatch; private notes or retroactive receipt creation do not satisfy the gate.

Collect all declared initial verdicts before one repair batch. Give the fixer all blocking
finding texts/URLs, not the advisory list as new requirements. Keep the same PR.
Re-run the declared checks after repairs, retain fail-first and mutation evidence, push,
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
  fix is not mechanical. This exemption covers non-blocker bookkeeping only; it cannot replace
  independent focused review to close a blocker. Prior independent reviews remain evidence for unchanged code.

A focused reviewer verifies closure of the assigned blockers, tests the changed
behavior and relevant mutations, and checks direct regressions. Do not re-audit
unchanged code or demand optional cleanup. Newly discovered real blockers still
count; non-blocking observations go to §2, not another repair batch. Initial and focused reviewers judge code using conductor receipts; optional reviewer-owned probes
may support findings. The author and conductor run declared checks; exact-head hosted CI remains
required for landing.

### Declared reviewer slots and check ordering

The repository's `.agentrig/config.json` may declare `reviewers`: 0, 1 or 2 named slots.
Missing `reviewers` or `{}` means none; profile/home values do not silently supply reviewers.
Each slot declares only `adapter` and pinned `model`. CLI adapter definitions and launch commands
live in `scripts/reviewer-adapters.mjs`; `api:<name>` binds an existing named `providers` entry
whose model equals the slot pin. API entries retain their existing provider, endpoint, credential
and routing behavior; do not duplicate that configuration in reviewer slots.

Ordering is mandatory:
1. The author runs the declared checks green before push.
2. The conductor independently runs the same declared checks in its own tree at actual PR head:
   GREEN BEFORE launching any reviewer, including focused-delta review. Record bootstrap,
   preflight and named step commands, exit codes, UTC start/end, counts, head, worktree and TMPDIR.
   Empty steps mean no bootstrap/preflight and an explicit `declared checks: none` receipt.
3. Launch the declared reviewer slots with these receipts as inputs, never author reasoning.
   Reviewers judge code only; reviewers do NOT run checks. Optional reviewer-owned probes
   are evidence for findings, not a substitute for conductor proof. Dependency preparation in
   reviewer trees belongs to the conductor and must finish successfully before launch.
4. Hosted CI overlaps review and is required only at landing on the exact current head.
   Missing independent proof, failed checks, blockers or non-green exact-head CI prevent landing.

Zero slots skip external review entirely: ledger `External review: none declared`, flow
builder → declared checks → exact-head CI → land, using author check receipts without conductor-review
preparation. One slot is also the focused-delta reviewer.
Two slots run independently, sharing no builder context, preferably a different vendor or model.
Land requires only declared headings; never halt for an undeclared second slot. An incomplete
required slot gets one retry then halts. A missing/pin-mismatched required review is not a pass.

Canonical initial heading:
`## External review — <slot> (<model>) — head <SHA> — merged with origin/main <MAIN> — full`
Keep full head/main provenance, asserted model source, adapter launch/provider entry, times,
exit and worktree in each linked review receipt. Land compares the model with the slot's pinned
model at the reviewed head; declaration changes are material and require newly declared slot
coverage, not retroactive relabeling. API adapter model provenance is the constructed provider's
model field, not a claim of wire-response attestation. Supply API reviewers the complete relevant
source/diff bundle with receipts; insufficient context is an incomplete review, never a clean verdict.

Pair and focused-review references mean only the declared slots; with zero slots skip external
reviewers, not check receipts, delta self-verification, CI or human authorization.

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

## Reviewer adapter and finding identity details

The conductor owns shared review-base refs and removes them only after all consuming jobs join
and restored state and publication are verified. Reviewers never create or delete shared refs;
a standalone reviewer owns only its unique private ref. CLI slots use the declared adapter
templates. The codex-cli adapter intentionally uses `codex exec`, not the dedicated `codex review`
subcommand: exec accepts the full skill prompt, exact model pin, explicit sandbox and last-message
output contract. This is not permission to change tool allowances or run project checks.
API review entries with dailyCap are rejected before construction because the adapter has no
spend ledger; select an explicitly uncapped entry or CLI slot, never strip the configured cap.

Finding identity is the verbatim Markdown finding heading plus source comment URL/anchor. Run
`node <REPO>/scripts/review-finding-index.mjs <comment-URL>` on each posted review to produce a
small index from the live GitHub body (not a conductor summary). The ledger, pre-dispatch receipt
and fixer task retain that exact pair for every assigned finding. Conductor rationale stays
separate. Before dispatch, before fixer edits and before landing fetch the live comments and
compare all three copies; absent/edited/mismatched identity halts, never silently relabels a fix.
