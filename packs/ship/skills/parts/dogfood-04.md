Zero, one or many named steps are supported; receipts follow the resolved declaration.
Empty steps means NO local checks, including bootstrap and preflight: do not execute either.
Record `declared checks: none`; land fallback is exact-head CI plus human merge authorization,
not a fabricated local pass. Missing CI or authorization cannot be waved through.

The independent conductor runs declared checks on the exact review head and must be
GREEN BEFORE launching the declared slots (and before a focused delta reviewer). Give every declared reviewer
the named same-head receipts, not builder reasoning. Reviewers inspect code,
contracts and targeted mutation probes; reviewers do NOT run checks, bootstrap or preflight.
They may run narrow tests for a specific finding/mutant, never repeat the full declared suite.
For empty steps give reviewers the explicit none receipt. Keep the declared independent code
reviews and exact-head hosted CI requirements; local conductor proof is not hosted CI.



# Dogfood flow — how a change ships in this repository

Read [shipping policy](../../../docs/SHIPPING-WORKFLOW.md) before acting. Its shared
CI scheduling, finding disposition, material-delta and convergence rules govern this flow.

Follow every step, in order. The steps encode failures that already happened once; skipping one
tends to reproduce the failure that created it.
