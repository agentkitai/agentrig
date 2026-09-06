# R13c independent review receipt

One bounded Claude review, session `0225d5ce-58ab-4bbf-be2a-3709deccfeab`, reached its 16-turn
limit. The original written findings below are preserved verbatim, including its line references.
No second general investigation was requested. No source files were edited by the reviewer.

## Original findings

1. HIGH — restriction latches on ordinary tool output, not only external input.
   external-expansion.ts:319 treats any block not `user`/`project` as unknown; tool-execution.ts:350 gives
   bash/edit/write/grep results `tool-output`. So "edit file → run tests" requires fresh consent for the exec;
   headless (no onAsk) denies it outright. ROADMAP R13c row says "only new input is `external`"; R13c.md
   broadened it. No test covers the bash/edit→exec sequence. Decide: narrow to external/unknown/generated,
   or accept and document the headless consequence.
2. MEDIUM — injection signal (0.7) enters the shared escalating ladder (policy.ts:100-130). With
   `--supervisor-abort`, repeated benign external text (READMEs with `curl … | sh`) climbs to abort.
   Contract says advisory only.
3. LOW — children always start restricted (agent.ts:271); headless children can never exec/net/write-outside.

### Original polish

- tool-execution.ts:297 `.catch(() => "deny")` swallows host onAsk errors without an `error` event.
- Abort during fresh ask emits `tool.denied` + "permission denied" rather than an aborted result.
- `beginRequest` on a retried/duplicate request drops `requestHasUser` (conservative only).

### Original test report

vitest (maxWorkers=4): core external-expansion, permission-grants, subagent, checkpointer; cli
scoped-approval-ui, render, external-expansion; supervisor injection — all green (166 + 45 + 45). `pnpm typecheck` green.

## Resolutions

1. Recognized tool-output is neutral, never sufficient to clear a prior external restriction.
   Missing/external/generated ancestry remains conservative. Real CLI yolo file-edit→shell-command
   and external-read→same-command tests discriminate normal headless use from guarded expansion.
   Original checkpoint and shared child-grant fixtures run without new approval overrides.
2. Repeated injection can produce guidance only in the standard ladder, not forced replan,
   reviewer/grader spending, escalation or abort. The full-capability regression failed before
   this fix; it and repeated actual runtime/supervisor traces pass after it.
3. The actual runtime records current restriction on its ToolContext; the built-in subagent copies
   it through an internal WeakMap to the exact child RunOptions object. No public token/text field
   carries it. Unknown/copied/resumed state stays restricted, and child task prose never clears it.
   Actual clean-parent, external-parent and copied-options children distinguish these cases.

Optional diagnostic polish is recorded at the literal roadmap end, not as new prerequisites.
