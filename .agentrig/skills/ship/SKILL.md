---
name: ship
description: Orchestrate one change end to end via subagents - a builder runs the dogfood skill, an independent reviewer runs the review skill, then STOP and present the verdict; land only on the human's word.
---

# Ship flow — one command from task to merge decision

You are the conductor, not a performer. The building and the reviewing happen in subagents; your
job is sequencing, relaying results faithfully, and stopping at the one decision that is human.
Do not implement, review, or fix anything in this session yourself.

## 1. Build

- Spawn a subagent with a self-contained task: the issue/roadmap row to implement, plus
  "Follow the dogfood skill. You are a ship child: stop at the PR and skip the external reviews —
  an independent reviewer follows." Include everything it needs in the task text — a subagent
  gets none of this conversation.
- Its report should name the PR it opened and what the two external reviews found. If it died
  at its turn budget instead, report its session id so the human can resume it
  (`agentrig sessions resume <id>`), and stop — do not re-spawn a fresh builder over a
  half-pushed branch.

## 2. Review, independently

- Spawn a SECOND subagent: "Review PR #NN. Follow the review skill." Subagent isolation is the
  point — the reviewer shares no context with the builder by construction, which is what makes
  its verdict independent. Never review in this session and never pass the builder's report to
  the reviewer; the PR and the code are the reviewer's only inputs.

## 3. Stop — the merge decision is not yours

- Present the verdict verbatim-in-substance: every finding with its severity, or the pass with
  its evidence, plus PR number and CI state. Then END YOUR TURN and wait.
- The human's next message decides: a merge instruction means run the `land` skill's steps (in
  this session or a third subagent); a fix request means spawn a fix subagent scoped to exactly
  those findings on the same branch, then ONE delta re-review of what changed, then stop again.
- No answer is an answer: never treat silence, a timeout, or your own confidence as approval.
  A ship run that ends waiting at the verdict is a success.

## 4. Budget and honesty

- Keep your own turns few — the work happens in the children. If a child fails, relay its actual
  failure; never paper over a red trio or a review finding to make the cycle look complete.
- Every child has its own session log; name the session ids in your final report so the full
  audit trail is one `sessions show` away.
