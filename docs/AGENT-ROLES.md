# Local agent roles

With subagents enabled, a trusted project may define `.agentrig/agents/reader.md`:

```markdown
---
schema: 1
tools: ["read_file", "grep", "glob"]
model-role: subagents
max-turns: 8
delegable: false
---
Inspect the assigned code and report findings. Do not make changes.
```

The model selects it through `subagent({ agent: "reader", task: "..." })`.
Use exact registered tool names; unavailable names refuse the spawn. Definitions
are snapshotted at build time. Editing a file requires a new agent build. Unknown
roles never fall back to unrestricted generic children. A call without `agent`
keeps the existing generic behavior, including inherited role restrictions.

The strict flat frontmatter supports JSON arrays for tools, JSON booleans and
integer max-turns; unknown/duplicate keys and general YAML nesting are refused.
Tools are required, even if empty. The optional schema is version 1. Model-role
defaults to subagents and can only select existing main/supervisor/memory/subagents
configuration. It cannot supply credentials or provider options; explicit provider
and agent selections cannot be combined.

Roles restrict rather than grant. Tool lists intersect through grandchildren and
with live delegable permission views; base denies, revocation, expiry, sandbox,
depth and shared spend caps still apply. Max-turns can only lower the inherited
cap. Delegable defaults false: no further subagent spawn. True merely preserves
already-allowed spawning; it cannot delegate a non-delegable permission grant.
The role body is project/advisory context, not fresh human consent.

There are no implicit tools: include read_output if overflow recovery is needed.
Allowing write_file/edit_file does not implicitly allow core:diagnostics. When
that internal exec tool is excluded, the edit can succeed while configured
diagnostics report unavailable. Adding it still requires normal exec permission.

Same-agent SDK resume retains live role restrictions. Explicit operator CLI resume
constructs a new root using current trusted configuration, not the historical
child actor. Stored role receipts never recreate authority. Existing conservative
external-input state is not cleared by role text or historical receipts.

Automatic discovery searches only the trusted project directory: no implicit home,
package or remote roles. An explicitly trusted configuration may additionally set
`agentRoleRoots` to at most 32 absolute role directories. Those roots load only
when subagents and project trust are enabled, use the same bounded role parser,
and cannot shadow a project role: duplicate names refuse the combined catalogue.
The ship source-install activation uses this generic seam for its lander without
copying role files into a foreign project (see `packs/ship/README.md`).
Bounds: 32 roles, 128 directory entries, 64 KiB per file, 1 MiB aggregate, 8 KiB
header, 32 KiB body, 64-character lowercase names and 64 tool names of up to 128
characters. Max-turns is 1–1000. Symlink/junction role directories and linked files
are refused. Canonical checks and hashes identify observed local snapshots; they
do not attest authorship or defeat hostile concurrent filesystem writers.
