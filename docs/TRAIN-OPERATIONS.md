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
- `question.asked` without its matching `question.answered`. The current
  `QUESTION_TIMEOUT_MS` in `packages/core/src/questions.ts` is 120,000 ms;
  timeout emits `question.answered` with `outcome: "timeout"`. The 30-second
  cadence gives time to respond, but is not permission to invent an answer.
  A timed-out question is not still awaiting an answer.
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

## `agentrig train <dir>` (R18c)

The command replaces the operator's `drain.sh`/`train.sh` queue loop. It is a
serial queue transport and independent landing-evidence gate, **not** a replacement
for ship/topic review, authorization or merge decisions. Those remain in skills.
Use a dedicated checkout on its configured base branch. Keep the train directory
outside that checkout (and use a proof TMPDIR outside Git ancestry per TESTING).
Normal provider/profile, project trust, explicit denies and sandbox policy apply;
the command never adds `--trust`, `--yolo` or permission grants. Set up the normal
headless run configuration beforehand; unavailable consent causes a row halt.

```sh
mkdir -p /absolute/train/queue
# Save the operator-authored JSON below as queue/001-task.json, then:
agentrig train /absolute/train
# After the active row, stop without consuming another row:
touch /absolute/train/STOP
# Or wait between rows until PAUSE is removed (STOP takes precedence):
touch /absolute/train/PAUSE
rm /absolute/train/PAUSE
```

Each row is a strict zod-validated object (unknown fields are refused):

```json
{
  "task": "Implement the one authorized roadmap row using ship",
  "authorization": "The human's exact scoped task/merge authorization quote",
  "scope": ["packages/core/src", "packages/core/test"],
  "environment": {
    "checkout": "/absolute/dedicated-checkout",
    "repository": "owner/repo",
    "baseBranch": "main",
    "ciWorkflows": ["CI"],
    "profile": "personal"
  }
}
```

`profile` is optional. `environment.sessionRoot` optionally selects an absolute
session store; otherwise every row uses `<dir>/logs/sessions`. Optional
`resume: {"session":"prior-session-id","pr":123}` resumes that same session
through `run --resume`; `pr` is optional, but when present pins the returned PR.
Use the same session store as the original run. Queue text is input, not proof of
consent: ship must apply the supplied authorization's actual bounds. Scope and
authorization are forwarded verbatim as data, not converted into tool permissions.

### Directory and transition contract

- `queue/`: unique, lexically sorted `[A-Za-z0-9][A-Za-z0-9_-]*.json` rows, at most
  64 KiB each. Publish rows by atomic rename, never edit one while being consumed.
- `active/`: exactly one claimed row. A directory lock rejects concurrent drains.
- `done/`: only after the child identifies a PR, GitHub reports it merged into the
  configured base, and **every configured workflow** has a completed successful
  push run on the **exact merge commit** and base branch. Empty, skipped, pending,
  failing or mismatched CI cannot pass. The command does not wait for pending CI;
  it halts, preserving evidence for reconciliation. Choose required workflow names
  explicitly; a different green workflow is not a substitute. All matching runs
  returned by the bounded GitHub query must be green (conservative on reruns).
- `halted/`: the first failed row; no subsequent row starts. Exit code 1.
- `logs/<id>.log`: commands, stdout/stderr and retry markers. The headless child is
  given a host-owned `--output-schema` and returns final assistant JSON `{"pr":123}`.
  The host captures `message.append` plus successful `output.validated` events from
  existing `run --json` stdout and atomically writes `logs/<id>.result.json`. No
  model tool writes outside the checkout, and no permission rule is widened. Missing,
  malformed or unvalidated output halts. This receipt is a PR pointer, **not** landing proof. `logs/<id>.state.json` records progress, PR/head,
  merge commit and observed session IDs. `logs/<id>.halt.json` records machine-readable
  `row`, `phase`, `reason`, `pr`, `head`, `mergeCommit`, `sessionIds`; unavailable IDs
  are null/empty, never invented. Files in logs are operational metadata, not session
  JSONL; canonical session logs remain owned by the existing run/session store.

The prompt serializes the entire row as one JSON value: only its `authorization`
field is the verbatim human quote, not a heading forged inside task text. Each
invocation supplies a fresh host-generated `agentrig-train-row:<UUID>` line for the
PR body. Unless the operator explicitly pinned that PR in `resume.pr`, the landing
gate requires this exact line and rejects merges already in the starting base.
It freshly fetches the configured base and checks merge ancestry; missing objects,
fetch failures and ancestry errors halt. Pinned resumes still require the configured
repository/base, reachable merge commit and exact-merge green CI.

All queue entries must have valid `.json` row names; an unexpected extension is an
error, never silently skipped as an empty queue. Atomic metadata writes use fresh
exclusive-create temporary names, so an interrupted stale `.tmp` cannot prevent a
recovery halt record. Stale evidence is left intact.

Before **each** row, including resumes, validate repository root, clean checkout,
base branch and exact GitHub origin; fetch, fast-forward only, and refuse a locally
advanced base. Then run `pnpm install --frozen-lockfile`, `pnpm build`,
`pnpm typecheck`, `pnpm test`. Each step gets at most one retry for narrowly
classified network infrastructure errors (ECONNRESET/EAI_AGAIN/ETIMEDOUT, DNS or
remote disconnect), not assertions/compiler failures. Never retry the row itself.
Git and pnpm must be available; landing verification uses authenticated `gh`.
Children inherit the operator's environment, without git-ai PATH injection and with
`GIT_TRACE2_EVENT=0`. The command uses argv spawning, not shell interpolation.

A JSON `train.status` queue/active/done/halted count is printed after every completed
or halted row; `train.end` reports empty, halted or stopped. STOP/PAUSE are checked
**between rows**, never kill an active child or interrupt a merge. Empty and STOP
exit successfully. Removing STOP permits another invocation. PAUSE polls once per
second and is interruptible at process level; it does not consume pending rows.

After a process crash, do not blindly remove `.lock`: reconcile live children and
landing evidence first. Once no drain is live, remove the stale lock and rerun; an
orphaned active row is moved to halted with phase `recovery`, never executed again.
To continue a halted task, retain its evidence and enqueue a **new unique row id**
with explicit resume pointers and unchanged authorization bounds. Existing done or
halted row ids and stale result receipts are never reused. Directory layout/name/
lock errors are command errors before execution, not evidence of a landed row.
