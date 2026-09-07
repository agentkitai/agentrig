# Subagent turn-count validation follow-up

Base: green main300c5e2. Complete only the R15h END bullet's fractional
subagent-turn validation portion; role-directory diagnostics remain queued.

`subagentMaxTurns` / `--subagent-max-turns` must be a positive safe integer,
matching the existing role-runtime requirement. Preserve omitted/default15 and
integer-valued numeric spellings; reject rather than round fractions, zero,
nonfinite or unsafe values. Do not change other numeric settings or core budgets.
Validate file configuration and direct builder input before provider construction;
retain ordinary trust/config precedence and role/permission/budget enforcement.

Acceptance: actual CLI/config startup refuses fractional limits without provider
construction or dispatch; direct builder also refuses. Existing real local-provider
role spawning succeeds with default and explicit integer budgets, still enforcing
the role tool allowlist. Fail-before controls, one bounded independent Claude
review, build/typecheck, required pinned Docker full suite, Chromium and all four
exact-head CI gates. Root alone merges; no live model calls.

Before correction: eight new CLI/config/direct-builder controls fail, while all
three real local-provider role-run controls pass. After shared schema and early
builder validation:61 CLI/config tests pass. Existing role runtime is unchanged.

Final local gates: build/typecheck;95 focused CLI/config/runtime/wiring controls;
required pinned real-Docker full3,280 passed+2 existing skips across209 files
(93.36s); actual Chromium1. One independent [review](subagent-integer-turn-limits-review.md)
approved with no material findings, requested24/reported26 turns and one denied git
command disclosed. Author verified the reviewer fallback source matched the base.
No source changes after the frozen review. Invalid explicitly supplied limits also
refuse when subagents are disabled; no rounding or raw-value echo. Exact-head CI
and root-only merge/post-main gates remain required.
