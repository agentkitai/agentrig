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

Local results: delayed150ms control failed before (ordinary control passed); both
restored controls pass. All45 subagent tests pass. Build/typecheck pass, required
Docker full suite3318 passed+2 skipped/209 files88.83s with worker
`sha256:f111ef59dce766519eb2ac455b554b01793aff0e9cd1d68d29b6d314d7db52e9`
and checker `sha256:33443f68f312abe4f1e88e16be7c88407d7173e80d7e55dfb0a12a5541e733e5`.
Real Chromium1passed3.23s. [Single review](abort-grace-readiness-review.md):
APPROVE,15reported/24requested turns, no material findings; limitations retained.
