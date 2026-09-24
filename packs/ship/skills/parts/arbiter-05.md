The independent conductor runs declared checks on the exact review head and must be
GREEN BEFORE launching any declared reviewer (and before a focused delta reviewer). Give declared
reviewers the named same-head receipts, not builder reasoning. Reviewers inspect code,
contracts and targeted mutation probes; reviewers do NOT run checks, bootstrap or preflight.
They may run narrow tests for a specific finding/mutant, never repeat the full declared suite.
For empty steps give reviewers the explicit none receipt. Keep all declared independent code
reviews and exact-head hosted CI requirements; local conductor proof is not hosted CI.



## Initial full review heading contract
