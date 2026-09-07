# Abort-grace fixture readiness

Test-only repair of the existing #86 orphan-warning fixture. The original 80ms
startup timer does not prove a child exists; a controlled 150ms first-response
delay reproduces the missing warning legitimately. PR#217 macOS CI34107659557
failed this assertion; its exact remote scheduling cause is not established.

Parameterize ordinary and delayed startup. Establish actual child session.end
store-gate entry before aborting the parent. Keep the exact 100ms grace warning,
nonfatal flag and parent-before-child-terminal assertion. Release in finally and
join actual child.done before filesystem cleanup. Use a bounded readiness guard,
not a longer product grace or arbitrary cleanup sleep. No production changes.

Validation: failing-before delayed control, restored focused pair, build/typecheck,
full required pinned Docker suite, Chromium, one bounded independent Claude review
and exact-head three-platform plus scripted-structure CI. Delivery remains pending.
