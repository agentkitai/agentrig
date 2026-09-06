# R5a — trusted, atomic extension activation

This contract supersedes the R5a portions and obsolete ordering of the retained [R5 draft](R5.md).
The roadmap is committed scope. H6 and R5e are delivered; R5d already owns MCP pinning. R5b
runtime disabling and R5c packages remain separate rows. R5a follows R6g PR #153, whose exact
post-merge main `714732d` passed all three platforms in CI 34023837383.

## Host boundary and discovery

Extensions are trusted ambient Node code, not a sandbox: even import can read environment,
credentials, files and network, block synchronously or terminate the host. Every selected
validated module gets a warning before import. Surface manifests constrain registration,
not arbitrary JavaScript behavior. Choose code you trust before activating it.

`--extension <path>` is repeatable and explicit authorization to load that host module.
Trusted project `.agentrig/extensions/*.mjs` is discovered automatically; no home extension
directory is scanned. `--no-extension-discovery` disables project discovery, preserving explicit
paths. Config uses `extension: ["path.mjs"]` and `extensionDiscovery: false`; arrays replace
inherited arrays, including `[]`. Paths resolve against the invocation cwd. Unsafe home config
remains excluded by the existing home-inside-repository check. `--trust` includes project code.

Any selected extension with a non-`none` sandbox refuses before importing, even under YOLO.
An extension cannot claim sandbox compatibility to bypass this startup restriction.

Discovery examines at most 128 directory entries and 32 modules; load accepts at most 32
candidates, never a partial oversized set. Project `.agentrig` and extension containers and
module/sidecar files cannot be symlinks. Canonical project roots tolerate host aliases such as
macOS `/var`. Explicit parent directories are user-selected; this is not a race-safe filesystem
isolation boundary. Concurrent external file changes, transitive imports and ESM caching remain
ordinary trusted Node semantics, not hash pinning or package integrity.

Explicit paths win over project discovery. Equal-precedence duplicate basename names reject
all definitions; repeated identical paths deduplicate. A malformed higher-precedence definition
does not fall back to another module. All selected sidecars validate before the first import.

## Versioned API and atomic registration

Each `name.mjs` requires sibling `name.json` (at most 16 KiB):

```json
{"name":"hello","version":"1","apiVersion":1,"surfaces":["hooks","tools","commands"]}
```

R5e's strict schema rejects missing/unknown/security-shaped fields and unsupported versions;
the name must match the module basename. Module files are capped at 1 MiB before import.
`activate(ctx)` is a named export; a function default export is a compatibility alias.
One activation occurs per built agent; reused TUI/resume sessions do not activate it again.

The frozen context exposes exactly `name`, `session`, `hooks`, `registerTool`,
`registerCommand` and `log`. Frozen `session` contains build cwd and provider id/model only:
no credentials, provider instance, store, environment mirror, budgets or permission callbacks.
This API omission does not prevent ambient host access.

- `hooks.on(point, handler, {timeoutMs?})`: all seven existing points; optional timeouts may only
  lower the existing runner ceiling. Registered identities are assigned by the loader. R13d
  captures the actual objects; ordinary extension hooks are advisory, never auto-delegated.
- `registerTool(tool)`: existing `AnyTool` contract. Names, description, permission, input parsing
  and advertisement are checked inside the draft. Builtin/current registry/reserved authority
  names and the `mcp__` prefix cannot be shadowed. Synchronous JavaScript handlers are normalized
  to promises before the existing core execution pipeline; no new permissions are implied.
- `registerCommand({name,args?,summary,run})`: bounded command metadata, built-in/alias and
  cross-extension collision refusal. Runtime receives arguments and a print-only IO object,
  never the controller. Builtins precede extensions, which precede skill slash invocations.

Each registration checks declared surfaces, with at most 64 registrations per extension.
Drafts commit only after successful activation; even caught registration errors poison the
draft. Contexts seal on settlement or timeout so late registration cannot change a live registry.
Import plus activation has a maximum 10-second async wait, lowerable by SDK tests/callers.
It cannot interrupt synchronous code or stop abandoned ambient effects. There is no process
isolation or generic cancellation promise.

No extension hooks, tools or commands are inherited by child agents in R5a. Inheriting tools
without their paired gates is intentionally avoided. Extension hooks are local session hooks,
not global child policy. Later inheritance must preserve ownership, hooks and failure state.

## Runtime and proof

Core emits current-build `extension.loaded` receipts after session start/resume, plus
`extension.error` for manifest/import/activation failures. Receipts describe actual registered
surfaces, not repeated activation, permission grants or replayed authorization; tools cannot
emit them. CLI renders receipts; TUI `/help` and slash dispatch use the loaded commands.
Command errors are caught and shown without disabling the extension; existing hook/tool error
handling remains. Cross-surface runtime disabling belongs to R5b.

Network-free tests use actual `.mjs` imports, pre-import sentinels, strict sidecars, reserved
names, poisoned drafts, timeout/late calls, real CLI trust/sandbox checks and a TUI fixture
combining slash command, hook-denied shell call and registered tool success. Build/typecheck,
full tests, detected/restored named mutants, one bounded review and exact-head three-platform
CI precede root-controlled merge and its post-merge gate. No live evaluation or benefit claim.
