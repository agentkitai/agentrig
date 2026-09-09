# R17g CLI package follow-up sweep

One CLI package batch, with parallel disjoint implementation in one package
worktree. No additional milestone hierarchy or PR per cosmetic observation.

Fragment-by-fragment outcomes and test receipts:

- [Runtime, reporting, consent and compatibility](R17g-cli-runtime.md)
- [Input, display, notifications and settings](R17g-cli-ui.md)
- [Evaluation mechanics and CI workflow runtimes](R17g-cli-evaluation.md)

Each table distinguishes implementation from prior delivery and explicit declines
of conditional expansions. Declined work is not falsely marked implemented. Raw
historical evaluation records, task scores, permission defaults, sandbox/grant
boundaries and fail-closed evidence requirements are unchanged.

Builder: Codex/operator and helpers outside AgentRig, not an AgentRig conductor.
No conductor id or dogfood success is invented. The root owns one bounded
independent Claude/Codex review pair, substantive repair checks, final combined
build/typecheck/tests, exact-head CI, sequential merge and post-merge verification.
Local/helper results in the linked tables are not substitutes for those gates.

Combined local verification: build, typecheck and fixture preflight passed;
the stable full suite passed **3633 tests across 234 files**, with four existing
conditional skips. Two older diagnostic-word assertions were updated to the new
fixed safe messages; the first rerun imported one assertion before that edit,
so the final result comes from a separate stable-source rerun. Independent
reviews and hosted CI remain delivery gates, not claimed by this local receipt.
