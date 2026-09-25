Every ledger row, including nonblocking deferred and advisory findings, must quote the live verbatim finding heading and source comment URL/anchor.
Fetch every ledger source comment live at landing, including nonblocking deferred and
advisory findings, even when no fixer is dispatched. Compare its exact verbatim finding
heading and comment URL/anchor against the ledger, not the conductor's paraphrase.
For assigned blockers, also compare against the pre-dispatch receipt and persisted fixer
task, and require the hook-recorded `Pre-edit comparison: PASS` before the child starts.
Deferred/advisory rows need no fixer task. A missing, edited or mismatched heading/anchor
blocks landing even when the local finding ID matches; preserve conflicting texts and
halt, never retroactively rewrite the assignment. Source changes after ledger writes are
not covered by the write-time hook or the minimal merge guard; retain this land-time judgment.
