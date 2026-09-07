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
