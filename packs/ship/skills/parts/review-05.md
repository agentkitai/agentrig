The independent conductor runs declared checks on the exact review head and must be
GREEN BEFORE launching any declared reviewer (and before a focused delta reviewer). Give declared
reviewers the named same-head receipts, not builder reasoning. Reviewers inspect code,
contracts and targeted mutation probes; reviewers do NOT run checks, bootstrap or preflight.
They may run narrow tests for a specific finding/mutant, never repeat the full declared suite.
For empty steps give reviewers the explicit none receipt. Keep the declared independent code
reviews and exact-head hosted CI requirements; local conductor proof is not hosted CI.



# Review flow — the independent final review of a pull request

Read [shipping policy](../../../docs/SHIPPING-WORKFLOW.md) before acting. Its shared
CI scheduling, finding disposition, material-delta and convergence rules govern this flow.

You are the reviewer of record, not the author and not the merger. Assume the author is wrong
until the code proves otherwise; assume the PR body overstates until you have verified its claims.
Run this in a session that shares no context with the run that wrote the PR.
