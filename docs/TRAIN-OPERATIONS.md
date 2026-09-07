# Operating a release train

The [topic skill](../.agentrig/skills/topic/SKILL.md) defines authorization,
reviews, merge gates, and halts. This document describes operator monitoring;
it does not change those requirements or permission policy.

## Stay available for child prompts

Follow the conductor's `subagent.spawn` events recursively into child session
logs under the configured session-store root (the personal-profile R17 run uses
`.agentrig/raw/sessions`). A live terminal, or a parent waiting on `subagent`,
does not prove work is progressing. Check at least every 30 seconds while
operating the train:

- Unresolved `permission.decision` asks and their `permission.request` inputs.
  Inspect the exact command/effects before approving a scoped request through
  the TUI; never auto-approve unknown effects or change policy to avoid prompts.
- `question.asked` without its matching `question.answered`. Questions have a
  bounded response window; a timed-out question is not still awaiting an answer.
- Child `session.end` and the conductor's resulting decision. Read the report;
  a terminal reason of `done` alone does not prove the roadmap row was delivered.
- Recent child activity and pending tools. A long-running test/review can be
  legitimate; inspect the job instead of treating elapsed time alone as a halt.

Use complete JSONL records only; ignore an incomplete trailing line while an
append is in flight. Do not modify canonical logs. Bind PR status and CI to the
current head and, after merging, the exact merge commit. Earlier green checks
do not validate later local edits or a new head.

An operator must remain available to service these prompts. Saving a status
script does not provide unattended monitoring or wake an assistant whose turn
has ended. An assistant operating the train must keep its monitoring turn
active until completion or an explicit handoff/blocker, rather than end its
turn with a claim that monitoring continues. If interrupted, re-check every
live child before reporting progress. Record a missed prompt honestly; do not
blame a valid permission gate for an operator's absence.

For PTY input and fixture readiness, see [TUI input protocol](TUI-SETTINGS.md#driving-the-tui-from-a-pty).
