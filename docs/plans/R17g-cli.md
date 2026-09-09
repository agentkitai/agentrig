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

Independent reviews completed on `616ab23`: Claude
`9bd19d54-3b52-4133-9a50-74f4bfb7a544` and Codex
`01a08790-1e42-70f1-bb9c-a77a3bbce590` both returned clean. Claude independently
passed private fixture preflight, typecheck and 1365 CLI tests with two existing
Docker-conditional skips, plus two restored production mutation controls.
Codex reviewed source/lifecycle/tests and diff cleanliness, but disclosed sandbox
fixture-preflight limits; no behavioral execution was claimed for that pass.

Optional notes were dispositioned without a new review cycle: fixed publication
CLI errors avoid arbitrary raw diagnostic reflection; direct APIs retain refusal
reasons. The supervisor Windows prerequisite is present after PR #291 integration.
Real checker transport already caps stdout at 4 MiB; invalid injected transports
still face explicit evidence bounds, not a fabricated BLOCKED assessment. Invalid
lone UTF-16 advisory input is not granted a new normalization guarantee. No
substantive blocker was identified. Historical evaluation data remains unchanged.

The implementation rebased unchanged onto merged supervisor/memory main `6fb3413`
(range-diff equality). Final integrated local and hosted receipts follow on the
delivery PR; metadata updates do not warrant another general review cycle.

Final integrated build, typecheck and private-fixture preflight passed. The full
suite passed **3651 tests / four existing conditional skips / 235 files** on the
combined supervisor, memory and CLI source. Hosted platform checks remain separate.
