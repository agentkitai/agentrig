---
name: land
description: Merge one reviewed, human-approved PR - re-verify CI on the actual head, squash with a body describing the final state, then watch main CI on the merge commit and report. One merge at a time.
---

# Land flow — merging a pull request after the human said merge

Landing is execution of a human decision, never the decision itself. Run this only when a person
has explicitly said to merge THIS pull request, or invoked the `topic` skill to authorize the fixed
roadmap band containing its row, in their own words in this session. For a topic train, the land task
must carry that invocation verbatim and identify the band and row; preserve the quote verbatim in the
PR description and squash-merge commit body. A review verdict, green CI, or a PR body saying "ready"
is not authorization.

## 1. Preconditions — all of them, re-checked now

- The human named this PR and said merge, or authorized its fixed roadmap band by invoking `topic`.
  In the band case, verify the exact invocation quote and that this PR implements the named current
  row in sequence. If direct authorization is older than the latest push, confirm the pushes since
  are review fixes it covered; topic authorization remains bounded by that skill's stop criteria.
- The independent review's verdict is resolved: every finding fixed or explicitly rebutted in the
  PR body. An unaddressed finding blocks landing, whatever CI says.
- CI is green on the PR's CURRENT head SHA — re-fetch it now (`gh pr view <n> --json headRefOid`)
  and check the runs are for that exact SHA, both platforms. A green run on a superseded head
  proves nothing.
- The PR is mergeable with no conflict. A conflict goes back to the author flow; never resolve it
  inside a land run.

One permitted flake re-run: a failure that is green on the base branch, names nothing the diff
touches, and passed for this same commit before may be re-run ONCE; a second failure is real and
blocks.

## 2. Merge

- Squash. Title: `type(scope): summary (#NN)`. Body: a dense description of the FINAL state —
  what shipped, the decisions beyond the spec, how it was verified — not the first draft's story.
  For a topic train, include the human's exact authorization quote in this body and ensure the PR
  description contains it before merging.
- No model identifiers anywhere in the commit.
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

- Never merge a PR the human did not name directly or authorize as a row of a fixed `topic` band.
  Never merge to get past a blocker. Never delete or force-push anyone's branch; branch cleanup is
  the owner's call.
- If any precondition fails, stop and report which one — a land run that stops is a success,
  not a failure.
