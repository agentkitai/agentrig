# Post-R17 delivery reconciliation and bounded real-task validation

Date: 2026-09-10. Tested source: `c04763765d59e3addb180df745f08b8bfc6802b4`.

## Scope and independent acceptance

The user approved reconciling delivery documentation and validating AgentRig on an
ordinary task before expanding the roadmap. One actual task was attempted: edit
only the current ROADMAP/STATUS summaries to record the completed #294 delivery,
preserve historical failures and the R17a gap, then inspect the diff. No runtime
implementation, new benchmark or autonomous release train was requested.

Success required actual scoped file edits, correct facts/history, and independently
verified diff/checks. A model's final message or session.end done was not sufficient.
The operator owned external reviews, tests, PR and merge, not the AgentRig session.

## Setup

Fresh worktree `/var/tmp/agentrig-delivery-validation` on updated main, branch
`docs/delivery-checkpoint-validation`; frozen offline install and full build passed.
The worktree's freshly built `packages/cli/dist/index.js` was used, not stale output
from the installed wrapper (which points to the main checkout). Plain
`agentrig doctor --profile personal` passed configuration, role credentials and Git
checks before launch; its feel numbers were explicitly historical, not new timings.

Personal profile resolved to cloud/openai-chatgpt/gpt-6-astra, medium effort.
Limits:20 turns,200000 reported main tokens,5 minutes; subagents, LLM supervisor
review and dream disabled. Ingest limited to1 call,30s total/20s per call; no
auxiliary usage was observed. These counters are not a hard remote billing cap.
Explicit read/write rules and literal Git diff/status/log prefixes were supplied;
checkpoints stayed enabled and sandbox remained none (cooperative worktree isolation,
not an OS sandbox). The corrected run explicitly overrode inherited YOLO off.
No user profile/configuration, security default or checkpoint lock was changed.

## Outcomes, including the aborted attempt

| Attempt | Session | Observed result | Reported main tokens | Time / turns |
|---|---|---|---|---|
| Initial operator setup mistake | `256d75ee` | Inherited YOLO warning; operator sent SIGINT and joined exit1. No tracked edits or checkpoint events. Not an accepted validation run. | 95743 across6 completed responses;7 requests, so the interrupted seventh call's consumption is unknown | 26.423s /7 started turns |
| Corrected permission-checked run | `0df428f3` | Exited0 / session.end done, but correctly said no edits applied. Independent diff empty: task NOT completed. | 171162 across9 responses, all usageComplete true | 49.299s /9 turns |

Totals:266905 **reported** main tokens plus the initial interrupted call's unknown
usage. The corrected run had59526 uncached input,110720 cache-read input,916 output.
The initial run had25405/70016/322 respectively. Zero child spawns and no auxiliary
usage records were observed. No success rate or general performance conclusion can
be drawn from this single task and its operator-invalid initial attempt.

The corrected run read project instructions and the relevant files. Two boundaries
prevented completion:

1. `git status --short` reached a fresh `external-input-expansion` consent boundary
   (seq68), then unattended deny (seq69). The command parsed as literal argv; this
   is not proof the supplied argv-prefix rule was broken. An attended channel is
   needed to exercise fresh consent; the operator did not silently widen permissions.
2. The first `edit_file` was denied at seq171 by the checkpoint hook:
   `checkpoint ownership uncertain: another session or retained lock exists; stop writers before manual recovery`.

`Checkpointer.lease` uses the Git common directory. The retained
`/home/amit/agentrig/.git/agentrig-checkpoint.lock` was an empty0700 directory with
birth/mtime/ctime2026-09-08 19:39:15+03:00, predating both attempts. No owner metadata
was present. No running AgentRig command was found after joining the two owned
processes, but that does not prove absence of all external writers or identify the
original lock owner. No deletion, lock stealing, automatic recovery or checkpoint
bypass was attempted. The initial aborted run is not blamed for the pre-existing lock.

## Delivery and next action

Root completed the documentation correction **outside AgentRig**. The observed
workflow blocker is [feel #295](https://github.com/agentkitai/agentrig/issues/295),
with the command, session and event details. The next bounded work is safe retained-
ownership diagnosis/recovery UX, followed by an attended edit/checkpoint lifecycle
check. This document neither authorizes a new feature train nor claims that work
is already done. R17a remains unmet for the historical operator-built rows.

R17g itself is delivered: #291–#294 merged, #294 at `c047637`, green exact-head and
post-merge platform/structure checks. #293's own post-merge run remains failed;
#294 restored green main. Optional declined follow-ups are not implemented features.
[Final #294 receipt](https://github.com/agentkitai/agentrig/pull/294#issuecomment-5608346600).

This PR changes documentation only; no new behavioral code/test or mutation claim.
Build, full tests, typecheck, independent Claude/Codex reviews and exact-head/final-main
CI are recorded on its delivery PR. Historical evidence below is not a claim those
new delivery gates have already passed.

## Retained local evidence

Raw events and task text remain under `/var/tmp/agentrig-validation-evidence.YmKOB9/`;
canonical session logs remain in the worktree's `.agentrig/raw/sessions`. They are
not edited or published wholesale: raw contexts may contain sensitive information.
Paths are local operator artifacts, not portable repository fixtures. SHA-256:

- `events.jsonl`: `f468026588bccc49517aa3f4dda6dd11838fdef5f3c78318a6378d59dafa3b10`
- `corrected-events.jsonl`: `22d4d849763920e07446407cea93ecaedf15e189d587b6dd6329bd0a9aa4db1c`
- `task.txt`: `a54d736f5dd89fddbca66dd930328d1e53750fa4ad9f875e02b6843a7458a14a`

The hashes identify retained bytes; they are not external attestation or proof of
semantic correctness. Both AgentRig processes were joined before root edited docs.
