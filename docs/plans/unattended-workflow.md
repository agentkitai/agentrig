# Unattended workflow correction — 2026-09-10

User-directed corrective work, not another roadmap band. The request is to fix the
entire unattended workflow rather than repeatedly repair the next visible prompt.
Builder: Codex/operator and helper agents outside AgentRig. The active AgentRig
session `86ce6bc6` and its independent `--version` task are left intact.

## Observed causes

- The personal profile already enables YOLO, but R13c forced fresh consent after
  reading external content. Even `attempt_log`, with unknown declared paths,
  triggered the outside-write category. Blanket permission and no-prompt behavior
  were contradictory. No bookkeeping allowlist is added to hide that contradiction.
- Child agents, sandbox escalation, MCP definition changes, startup project trust
  and clarification callbacks had separate ways to reach human UI.
- Default diagnostics launched bare `tsc`; the installed local compiler was not on
  the running agent's PATH. The live session repeatedly reported ENOENT.
- Shipping instructions demanded a new merge message even when the user had
  expressly authorized end-to-end delivery of that task.

## Contract

CLI YOLO/skip-permissions selects trusted SDK `approvalMode: "unattended"` in
addition to the existing blanket base policy. The SDK mode alone does not authorize
anything. In this mode existing policy allows remain valid after external input;
unresolved asks become denials without calling human handlers. Actual child
dispatch inherits the parent's live mode, not a value in a model-authored brief.
No authority is restored from logs. Permission/expansion receipts and external
source labels remain intact. Interactive sessions keep R13c's fresh-consent guard.

| Stage | Unattended behavior | Boundary retained |
| --- | --- | --- |
| Startup | No project-trust dialog using trusted user/profile/argv state | Untrusted project config/instructions skipped unless separately trusted |
| Read/edit/exec/network | Existing operator policy evaluated without fresh human consent | Explicit base/live denials, audit failures, tool allowlist |
| Children | Live parent mode carried to actual built-in children | Child grant scope/lifetime and tool restrictions |
| Sandbox | Denied effects return refusal, no escape dialog | No automatic unsandboxed retry |
| MCP | Changed pinned definitions refused without a dialog | Definition pinning and startup policy |
| Questions | No human callback; configured noninteractive policy only | No fabricated answer or task success when required information is missing |
| Diagnostics | Trusted installed TypeScript entrypoint preferred over PATH | Ordinary exec/sandbox checks, honest unavailable/incomplete results |
| Memory | Ordinary authorized tool dispatch, existing bounded maintenance | No implicit grants or false success for failed bookkeeping |
| Review/delivery | Reuse explicit upfront authorization for matching task | Required independent reviews, tests, exact-head and post-merge CI, revocation |

This is broader authority, not prompt-injection protection. File contents, remote
tasks and tool output remain external; a malicious input can influence a YOLO
agent that already has broad tool authority. Scoped/default interactive policies
remain available and unchanged. In particular, do not offer blanket-authority MCP
serving to untrusted clients. Sandbox/MCP refusal is an actionable failure rather
than an indefinite question; the agent must not silently work around it.

Optional questions/maintenance must not become delivery gates. Model instructions
express this and preserve required checks; they are guidance, not an enforcement
claim. Human task authorization is separate from tool authority. No instruction
grants merging unrelated work or converting every advisory review suggestion into
a new acceptance condition.

## Verification and limits

Core/CLI tests pair interactive fresh-consent behavior with explicit unattended
operation, including live denials, no callback, sandbox refusal, MCP definition
pinning and project trust. The combined scripted-provider fixture exercises real
file edits, background Node command plus job collection, child external read and
exec, memory attempt ledger writes, and a parent/child explicit-deny counterpart.
These are real tools/processes, not live-model quality or hosted delivery evidence.

Diagnostics tests execute the resolved compiler with an empty PATH and cover
untrusted roots, nearest-parent selection, explicit config and outside symlinks.
Shipping prose tests are contract regressions, not proof of a real GitHub merge.
Meaningful mutation controls and independent Claude/Codex findings, exact-head CI
and post-merge receipts are recorded on the delivery PR. No future check is claimed
passed here. Existing session-end maintenance remains bounded, not instantaneous;
missing credentials, exhausted budgets and genuinely required answers still stop
work with an honest reason rather than waiting for an invisible approval.
