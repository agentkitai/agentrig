## 0. Residuals are issues, not prose

Before anything else: if the PR body has a `## Residuals` section, every entry must name an
open GitHub issue number, and each issue must exist. A residual described in prose without an
issue is not recorded — refuse to land and say which entry needs its issue. Only non-blocking defects with an explicit safe-deferral rationale qualify. An issue number
never waives a blocker. Advisory roadmap notes, `## Deviations` (arbiter records) and
evidence-backed rebuttals are not residuals.

Use the conductor's recorded base-pinned skills, schema and helper scripts, never copies
from the PR under review. Reassemble each live review body from its confirmed receipt chunks, then run base
`node <REPO>/scripts/review-finding-index.mjs --validate FILE REVIEWED_HEAD SLOT MODEL TRUSTED_ADAPTER_RECEIPT`.
Validate schema/binding against that review's coverage SHA (initial or focused), then check
coverage through current head and ledger dispositions. FAIL findings may be resolved by
subsequent covered repairs; PASS cannot conceal blocking findings. Missing/invalid structured
verdicts cannot authorize land. Logged nonfatal prose fallback is historical display/indexing
only, not a substitute for schema validation. Use schema headings for live-source comparison,
not Markdown grammar. For chunked reviews index only the intact schema-bearing comment; retain
all other chunk URLs as evidence, not duplicate fallback findings. Completion-marker timing is canonical in shipping policy; the existing
land marker gate below is unchanged.

## 1. Preconditions — all of them, re-checked now

The minimal merge guard owns three mechanical checks: exact host authorization on the
bound PR, required green exact-current-head CI, and a named lander child bound to its
successful dispatch/spawn record. It does not judge review resolution. Use a literal
`gh pr merge NN --squash --match-head-commit FULL_HEAD`; a denial is not a waiver.
See the pack's `docs/MERGE-GUARD.md` for the bounded parser and restart limitations.

- Verify all declared initial external reviews, focused verdicts for every material delta, and recorded
  evidence for mechanical deltas through the CURRENT head, per shipping policy §§2–4.
  Every finding must be fixed, evidence-rebutted, or explicitly dispositioned as non-blocking
  with its required issue/roadmap record. Unresolved blockers always prevent landing.
  Do not demand another full pair solely because a covered repair changed the head.
- The PR is mergeable with no conflict. A conflict goes back to the author flow; never resolve it
  inside a land run.
- A PR that completes a roadmap row marks that row `*(done)*` in `docs/ROADMAP.md` on its head
  (dogfood §5). An unmarked row is a row the next train rebuilds: stop and report which row needs
  its marker — the author flow adds it, never the lander.

For nonzero slots under shipping policy §3, verify independent conductor same-head named check receipts were
GREEN BEFORE launching any reviewer, and that each declared slot received them. Reviewers judge
code only; reviewers do NOT run checks. Optional reviewer-owned probes do not replace these receipts.
For zero slots require `External review: none declared` and author check receipts, not missing headings; declared checks,
exact-head hosted CI and scoped human authorization remain mandatory. Empty check declarations
require the explicit none receipt, not invented proof. Missing/failed proof blocks landing.

One permitted flake re-run: a failure that is green on the base branch, names nothing the diff
touches, and passed for this same commit before may be re-run ONCE; a second failure is real and
blocks.

For every dispatched fixer, require a conductor `gh pr view NN --json body` read-back receipt BEFORE the subagent call.
Reject a missing read-back receipt or advisory-only dispatch as a contract violation; a counter repaired by the fixer afterwards cannot retroactively satisfy it.
Require the same receipt in the GitHub PR body BEFORE dispatch:
`Pre-dispatch read-back: Repair round: N/3; blockers <IDs>; OLD <SHA>; verified <ISO ts>`.
Read the PR body and match that line against the round, OLD and assigned blockers in the persisted fixer task; verify its timestamp precedes the dispatch. Private session notes do not
substitute for this GitHub-visible receipt. Missing or mismatched evidence blocks landing;
a receipt added after dispatch cannot retroactively authorize that dispatch.
Before making a landing-gate claim that attributes a comment ID, comment URL or SHA to the PR body or a comment, fetch the live PR body and comments, then quote the exact fetched body or comment text containing that identifier.
For a landing-gate claim sourced from a fetched GitHub API response, including a `headRefOid` or CI SHA, quote the exact response field and value from that fetched response.
For a landing-gate SHA claim sourced from local command output, including `git rev-parse` or a SHA-producing `git merge-base`, record the exact command, require exit 0, and quote the exact stdout containing the claimed full SHA.
A local-command quotation cannot establish a fetched `headRefOid` or CI SHA and does not replace the exact fetched body or comment quotation required for an attributed provenance claim; a failed command or stdout that does not contain the claimed full SHA halts.
An API-response quotation does not replace the exact fetched body or comment quotation required for an attributed provenance claim.
Only cite a comment ID present in the session-fetched comment listing; never supply one from memory or inference.
Write the fetched live PR comment listing to a session-owned `comments.json` and retain it through the landing gate; only cite a comment ID that is present in that artifact.
For every cited comment ID, quote the exact corresponding fetched `body` field from that same `comments.json` artifact.
A comment ID the lander introduces that is absent from that listing, or a 404 for such an ID that cannot be traced to the fetched data, is a lander error and never a PR defect.
A PR-supplied finding source URL or anchor that is absent, edited or mismatched remains subject to the existing halt gate above; never recast it as a lander-introduced citation error.
Dispatch posting, pre-edit comparison and resume association are pack-hook responsibilities,
not a second handwritten landing comparison. Review coverage, dispositions and receipt-before-
dispatch ordering above remain land judgments; a mechanical allow never resolves a blocker.

A missing durable fixer pre-push handoff alone is not a halt when the hook has recorded
the authoritative dispatch. Do not fabricate replacement provenance.

## 2. Merge

- Squash. Title: `type(scope): summary (#NN)`. Body: a dense description of the FINAL state —
  what shipped, the decisions beyond the spec, how it was verified — not the first draft's story.
  For a topic train or upfront task authorization, include the human's exact authorization quote in this body and ensure the PR
  description contains it before merging.
- No model or agent authorship identifiers anywhere in the commit.
  The single sanctioned exception is a verbatim human authorization quote that itself contains such an identifier: preserve the quote unchanged, but never add model or agent authorship attribution.
- One merge at a time: never start a second land while this one's post-merge check is pending.

## 3. After the merge — the part that is not optional

- Watch main CI on the MERGE COMMIT until it completes (poll with `bash` background + `bash_job`
  `waitMs`, judging the run's conclusion — never assume from the PR's pre-merge green).
- Red main is an emergency, not a queue item: report it immediately with the failing job's log
  tail, and do not land anything else until main is green again.
- Confirm the linked issues closed; report the merge SHA and the main CI result.
- Other open PRs now have a moved base: list them and note which touch the same files (they will
  need a rebase before their own landing).

## 4. Boundaries

- Never merge a PR outside the human's direct PR, named-task, or fixed `topic` band authorization.
  Never merge to get past a blocker. Never delete or force-push anyone's branch; branch cleanup is
  the owner's call.
- If any precondition fails, stop and report which one — a land run that stops is a success,
  not a failure.
