# R6e — effect-based promotion guardrails

Fresh branch from main `762aa0c` after R6d PR #139 exact-head CI 34012625855 and post-merge
CI 34012808696 passed all three platforms. This is the last currently activated hardening row;
R6f was already delivered by H5. Generated skills and other backlog still require their gates.

Keep H4's runtime evidence gate, but distinguish evidence eligibility from promotion approval.
A bounded model assessment evaluates every candidate claim's future effects: weaken verification,
discourage scrutiny, hide failures, bypass review, normalize a workaround as policy, or misrepresent
results. Any weakening, uncertain, omitted or malformed assessment refuses the whole candidate.
No rewrite field or softer substitute is accepted. Harmless use of risky words and euphemistic
harm are judged by effect; this is not a keyword denylist.

Bind successful runtime assessment receipts to the exact publication artifact and evidence;
serialized/forged/stale receipts cannot authorize another candidate. Model assessment is not
semantic proof and does not replace human confirmation. The assessor can misjudge adversarial
content; defaults are fail-closed when assessment is unavailable, not a claim of perfect detection.

Offline CLI preview remains available. Confirmed publication additionally runs the bounded
memory-role guardrail pass and then requires both gates. Structural-only dream makes no calls
and cannot produce an approved promotion without assessment. Full dream uses at most one added
batch call for evidence-eligible candidates with a global destination; usage/cancellation share
its maintenance lifetime and its default call ceiling increases from one to two.

Tests use scripted assessors, not live paid calls: every deny effect, euphemistic harm vs safe
verification language, unknown/missing/invalid outcomes, artifact binding, evidence non-bypass,
actual dream/CLI refusal and unchanged local/global originals. Build/typecheck/full suite,
bounded independent review, negative controls, exact-head and post-merge CI before completion.

Implementation: the CLI re-reads page versions and reloads runtime evidence after model review,
refusing changes before publication. Assessment/validation failure does not imply a backend write
was attempted. Evidence tests now explicitly call the evidence-only API; actual guarded selection
has separate tests for all six deny effects, positive approval, unknown/forged/stale receipts,
malformed or incomplete output, cancellation/caps, unchanged originals and dream/CLI integration.
Build/typecheck and full Node22 suite pass 1,968 plus two skips (95 files). No live model calls
were made for these tests; they verify gating mechanics, not empirical semantic accuracy.

## Validation receipt

One bounded independent Claude review `f33ca5e4-14b4-4fd3-9468-4fccc2a9f2f6` approved without
material findings and independently passed build/typecheck plus the full 1,968-pass/two-skip
suite. Allowing deny verdicts fails the real CLI no-publication assertion (mock backend only).
Accepting the first receipt regardless of its artifact fails the stale-receipt test. Both
negative mutations are restored. Optional review notes are at ROADMAP's end.

Configured `dreamLimits.maxCalls: 1` still binds: consolidation consumes it and any promotion
assessment is refused with a call-limit reason. Increase that explicit cap only when the extra
bounded batch is desired. The new default of two never overrides an explicit cap.
The closing PR's receipt comments record exact-head and post-merge CI outcomes; both must be
green before delivery is complete. No later implementation is automatically authorized.
