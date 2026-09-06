# R15h independent review receipt

One frozen review of `c8eb84a` against `8da49d4`. Claude session
`738e1276-1f9a-4d21-b487-4756b1e36647`, 202.194 seconds, exit 0.
Requested max 24 turns; returned metadata reports **21 turns**. Outer
timeout 600 seconds. No denied commands. No second broad review after integration.

## Original result (verbatim)

Narrow tests passed (4 files, 84 tests, maxWorkers=2). I have what I need for the verdict.

**Verdict: APPROVE** for R15h commit c8eb84a against base 8da49d4.

**What I verified in the diff and runtime**

- **Canonical bounded loading.** Discovery only reads `<trustedProjectRoot>/.agentrig/agents/*.md`, lstat-refuses symlinked state/agents directories, realpaths each file before and after reading, checks same dev/ino on the open handle, and enforces the 128-entry, 32-file, 64 KiB, 1 MiB, 8 KiB header and 32 KiB body bounds. Frontmatter is a strict flat parser with a null-prototype field map, duplicate and unknown keys refused, and non-fatal UTF-8 refused. The CLI only calls discovery when `trustedProjectRoot` is set and subagents are on. Per-file failures are refused individually, catalogue-level bound violations fail the whole build closed.
- **Unknown role refusal.** `agent` is always parsed on the input schema, and any unknown name refuses before `childConfig` is invoked, including with an empty catalogue. Role plus explicit `provider` refuses.
- **Recursive monotone limits.** `buildSubagentTool` threads `inherited` tools and turns into the nested spawn tool. The allowlist is inherited ∩ host allowlist ∩ role tools, subagent is stripped for non-delegable roles or at max depth, and turns are `min(opts, inherited, role)`. A generic grandchild call keeps inherited constraints. The filtered `childTools` plus `toolAllowlist` on the child config are both applied, and `createAgent` re-filters `sessionTools`.
- **Actual dispatch enforcement.** The allowlist check sits at the top of `executeToolInner` in packages/core/src/tool-execution.ts:206, before hooks, replan gate and permissions. The internal diagnostics checker at line 510 routes through the same `executeTool` with the same config, so `core:diagnostics` is denied unless explicitly listed. The extension-tool and unknown-tool paths are behind the guard. The `tool.denied`-without-`tool.call` shape matches the existing hook-deny path.
- **Live grant intersection.** `childView(allowlist)` intersects with the parent view's `allowedTools` and `match` denies tools outside it before any grant lookup. Views stay live and task-sealed, with no record copying. Base deny precedence, revocation and run-boundary expiry are exercised by tests.
- **Trusted model-role routing.** `modelRoles` comes from the CLI's validated `roleNames`, and `childConfig` resolves it through `providers.get`, which only accepts defined entries. Non-subagents roles with no mapping refuse. No credentials or options come from the role file.
- **Advisory source.** The body is appended as a `project_instructions` block with `authority: "data"` and `ADVISORY_CONTEXT`. External-expansion restriction is derived from run options, not prompt text, so role prose cannot clear R13c state.
- **Resume.** The same SDK config retains `toolAllowlist` on resume. CLI resume builds a fresh root with no role restrictions, matching the stated contract, and the spawn event's `role` receipt is never read back for authority.

**Optional polish, not blocking**

- packages/core/src/agent-roles.ts:172: a project whose `.agentrig` state directory is itself a symlink now hard-fails `run --subagents` with trust, rather than just refusing roles. That is fail-closed and documented, but worth a clearer message naming the directory.
- packages/core/src/tools/subagent.ts:278: a fractional `--subagent-max-turns` (accepted by `positiveNumber`) makes every role spawn without its own `max-turns` refuse with the "inherited turn limit" message. Consider flooring or rejecting at CLI parse.

**Tests executed**: `packages/core/test/agent-roles.test.ts`, `packages/cli/test/agent-roles.test.ts`, `packages/core/test/post-edit-diagnostics.test.ts`, `packages/core/test/subagent.test.ts`, all passing. I did not run the full suite.

## Author disposition

APPROVE, no material findings. Both optional notes are deferred to the END of the
roadmap: clearer canonical-directory refusal diagnostics and consistent fractional
subagent turn-flag validation. The safe integer role refusal remains deliberate;
no role bound is rounded upward. No original-review wording or line references
have been corrected or represented as a review of later integrated main.
