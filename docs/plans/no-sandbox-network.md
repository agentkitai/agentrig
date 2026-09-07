# One-invocation sandbox network denial override

Add `--no-sandbox-network` beside the existing positive option on shared run,
TUI and session-resume entry points (also shared by ACP, web and MCP serving), and on
`mcp login`. Explicit false overrides
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

## Verification receipt

Four parser/config-surface controls failed before registration, as did the negative
inert net-body control (the ignored flag left configured true and dispatched once).
The actual MCP argv control failed on the then-unknown option. Omitted/positive
runtime cases already passed before the fix. All106 focused tests now pass; build
and typecheck pass. The initial typecheck before building this fresh worktree failed
on missing workspace declarations; build followed by typecheck resolves those.

Required pinned real-Docker full suite:3,314 passed plus two existing skips /209
files,87.30s. Worker digest f111ef59dce766519eb2ac455b554b01793aff0e9cd1d68d29b6d314d7db52e9;
checker33443f68f312abe4f1e88e16be7c88407d7173e80d7e55dfb0a12a5541e733e5.
Actual Chromium:1 passed,2.51s. One independent Claude APPROVE/no blocking findings,
24 requested/21 reported turns;106 tests and typecheck independently run. The
informational scope note is documented, no source changes needed.
[Original review and limitations](no-sandbox-network-review.md). Hosted exact-head
and post-main gates remain required; no merge is claimed here.
