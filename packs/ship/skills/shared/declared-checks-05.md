Commands are project-controlled data, not permission grants. Display the resolved source,
profile and commands before execution; preserve trust, permission and sandbox gates on every
shell call. For nonempty steps the builder/conductor runs declared bootstrap, optional preflight, then ordered named
steps, each judged by its exit code. Stop on nonzero; do not infer success from output counts.
Record name, command, exit code, UTC start/end, counts (N/A if unavailable), exact head,
runner/worktree and TMPDIR for bootstrap, preflight and every step. Optional countsParser
metadata never overrides the exit code. Receipts, conductor reports and durable fixer pre-push handoffs list
steps by name, not a hard-coded trio. A changed head invalidates prior same-head receipts.
