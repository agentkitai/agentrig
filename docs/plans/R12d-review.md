# R12d independent review and resolution

One Claude review of `a10b08b`, session `3f3727cc-edbb-4d19-8b1f-9d1d235abd77`.
The process took 223 seconds; a 24-turn maximum was requested, but the CLI reported 31 turns.
It independently passed 40 focused tests. Attempts outside the read-only allowlist were denied;
no reviewer source edits occurred. No second general review was requested.

## Original material finding — verbatim

**Verdict: CHANGES REQUESTED.** One high-severity finding in the real TUI wiring. The core registry, runtime binding, and the tests themselves hold up.

**High: the production TUI drops the same-call context, so child prompts fall back to the root registry.**

- `packages/cli/src/tui/start.tsx:91` builds the agent with `onAsk: (req) => controller.ask(req)`. That one-argument wrapper discards the second argument.
- That same wrapper is what `subagentOptions` hands to every child in `packages/cli/src/agent-builder.ts:388`. Core calls it with the child view in `packages/core/src/tool-execution.ts:313`, the wrapper throws the context away, and `controller.ask` at `packages/cli/src/tui/controller.ts:342` sees `context === undefined` and selects `this.permissionGrants`, the root registry.
- Consequences in the actual `agentrig` TUI, not the test harness. A root nondelegable allow or deny is applied to a child's prompt through `root.decide`. A standing or scoped answer given on a child's prompt installs a root-owned, delegable, session-duration record via `remember`/`grant` on the root subject. That record survives task end, is visible to the root and every later child, and the TUI prints "for the rest of this session" rather than the child lifetime. This is precisely the "TUI-root-fallback" mutant the plan says was caught. It was caught only because both child-grants-ui tests wire `onAsk: c.ask` directly, bypassing the start.tsx wrapper. `start.tsx` is unchanged on this branch (last touched in 7f01c4c) and no test exercises its wiring.
- Fix is one line: `onAsk: controller.ask` or `(req, ctx) => controller.ask(req, ctx)`. Add a control that goes through `start.tsx`-equivalent wiring, or at minimum a type-level guard, since `AgentExtras.onAsk` now accepts a one-argument lambda silently. The plan text "the built-in forwarding path retains the context" should be corrected until it does.

## Resolution

Accepted and fixed in this row. `startTui` now passes `controller.ask` directly. The new
`child-grants-startup.test.ts` calls actual `startTui`, actual `buildAgent`/`subagentOptions`,
actual subagent/runtime/controller and real inert shell/storage. Only terminal mounting and
provider responses are substituted; the existing Ink tests retain both real keyboard paths.
Before the production fix, both startup controls failed because the child never prompted.
Afterward, one explicitly denies without dispatch and the other creates a child-owned standing
record, executes the inert shell and verifies that record expires rather than leaking to root.

A bounded scan found no other production same-call context-dropping wrapper. MCP definition
change consent still calls the asker separately, without grant context; that reserved origin
cannot be remembered or scoped and does not confer standing authority.

## Original optional polish — verbatim

- `child-permissions.ts:11-14`: when the parent has no registry but `childConfig` supplies one, the child silently gets no registry. Previously it would have received the configured one. Intentional per the plan, but worth a one-line comment or a notice since it's a quiet capability drop.
- The TUI's `revision` guard is now shared across all views, so any sibling's revoke voids an open prompt. Conservative and safe, just noting the behavior change.

These remain non-blocking notes at ROADMAP's end. The documented view contract, not an implicit
configured child registry or a second review round, defines this item's scope.
