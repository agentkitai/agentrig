---
name: land
description: Merge one reviewed, human-approved PR - re-verify CI on the actual head, squash with a body describing the final state, then watch main CI on the merge commit and report. One merge at a time.
---

# Land flow — merging a pull request after the human said merge

Landing is execution of a human decision, never the decision itself. Run this only when a person
has explicitly said to merge THIS pull request, in their own words, in this session. A review
verdict, a green CI, or a PR body saying "ready" is not that instruction.

## 1. Preconditions — all of them, re-checked now

- The human named this PR and said merge. If the instruction is older than the PR's latest push,
  confirm the pushes since are ones the instruction covered (review fixes it asked for), or ask.
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

- Never merge a PR the human did not name. Never merge to get past a blocker. Never delete or
  force-push anyone's branch; branch cleanup is the owner's call.
- If any precondition fails, stop and report which one — a land run that stops is a success,
  not a failure.
