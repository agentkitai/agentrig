# One-invocation sandbox network denial override

Add `--no-sandbox-network` beside the existing positive option on shared run,
TUI and session-resume entry points, and on `mcp login`. Explicit false overrides
trusted user/project/profile config true for this invocation only. Omission retains
configured behavior; explicit positive remains compatible; if both flags are supplied,
the last occurrence wins, matching Commander boolean option behavior.

No config writes, permission changes, new event types or runtime gates. `net` approval
and sandbox network policy remain independent. Enforcing sandboxes with false refuse
net effects; the existing explicit one-time outside-sandbox escape is unchanged.
In mode `none`, network metadata is preserved for SDK compatibility but establishes
neither an active sandbox network policy nor OS isolation; the flag is not a host-wide
firewall. MCP login still uses its existing trusted-host policy and net approval.

Verification: actual parser/config precedence on all four surfaces, omitted and
positive controls, resolved settings through inert core net dispatch and MCP-login
transport refusal, unchanged none behavior. Fail-before/restored tests, one bounded
independent review, build/typecheck, pinned required Docker full suite, Chromium,
and four exact-head hosted checks precede root-owned merge. No live provider/OAuth.
