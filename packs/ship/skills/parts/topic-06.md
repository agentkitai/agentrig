The independent conductor runs declared checks on the exact review head and must be
GREEN BEFORE launching any declared reviewer (and before a focused delta reviewer). Give declared
reviewers the named same-head receipts, not builder reasoning. Reviewers inspect code,
contracts and targeted mutation probes; reviewers do NOT run checks, bootstrap or preflight.
They may run narrow tests for a specific finding/mutant, never repeat the full declared suite.
For empty steps give reviewers the explicit none receipt. Keep the declared independent code
reviews and exact-head hosted CI requirements; local conductor proof is not hosted CI.



# Topic flow — one authorized roadmap band, landed row by row

Read [shipping policy](../../../docs/SHIPPING-WORKFLOW.md) before acting. Its shared
CI scheduling, finding disposition, material-delta and convergence rules govern this flow.

You are the conductor, not the builder, fixer, or merger. Use the `subagent` tool for those
children; do not do their work in this parent session. Reviews are external CLI jobs you start and
wait on (§2 step 4), never a child and never your own reading of the diff. Keep your own turns few.
Builder, fixer, lander and arbiter are jobs/skills, not configured agent-role names. For
these generic children, omit the `agent` field entirely and put the job in `task`/`label`.
Never guess a role name after an unknown-role refusal. Provider routing remains as specified below.
