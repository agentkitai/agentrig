## Builder pre-push guidance (#607)

Source: https://github.com/agentkitai/agentrig/issues/607 and the tested manual
`checklist-baseline.txt`. Refresh this checklist manually from recurring blocking
review-finding classes; no automated extraction, scoring, or enforcement is added.

CONDUCTOR: include the PRE-PUSH CHECKLIST block below verbatim in EVERY builder/fixer
dispatch, including initial builders, continuations, retries and repair batches.
Do not substitute a link, summary, or only the items thought relevant.

BUILDER/FIXER: before every push, check every item and record each item by number
under `## Checklist` in the PR body as addressed (with evidence) or not applicable
(with a reason). This applies to standalone dogfood authors as well as children.

This is guidance, not a landing gate. Reviewers and landers must not block on a
missing or partial `## Checklist` section. Actual acceptance failures, unsafe
behavior and missing required proof remain blocking regardless of checklist claims.
Under R19, LOW observations and wording followups are advisories, not residual
issues, unless they demonstrate a real defect under the shipping finding policy.

PRE-PUSH CHECKLIST (recurring blocking review-finding classes from earlier PRs; check your change against every item before pushing, and record in the PR body under '## Checklist' how each item was addressed or why it does not apply):
1. Docs and skills agree with the code: every doc, skill or instruction text that describes what you changed has been updated in the same PR, and no sibling doc now contradicts it.
2. Hand-rolled parsers/matchers: you tested blank lines, CRLF, quoting/escaping, prose that merely mentions the syntax, and every input shape the code it replaces used to accept; nothing the old guard caught is now missed.
3. Every new branch, guard or refusal has a test that fails if you delete or invert it (you ran that mutant and saw it fail).
4. Every consumer and sibling site of what you changed is updated (grep for all call sites, duplicate copies and other skills/tools that implement the same rule).
5. Bookkeeping is complete: docs/STATUS.md (and ROADMAP if the row completes an item) are updated, and the PR body has every section the ship skill requires, including Residuals.
6. Every acceptance criterion in the task/issue is met as written; anything narrowed or skipped is recorded as an explicit deviation with a reason, not silently dropped.
7. When fixing a problem, you fixed every instance of that class, not just the cited line.
8. Your refactor preserves existing behaviour and safety checks: diff the old and new code paths and confirm no gate, error path or edge case was lost.
9. Inputs are validated: untrusted, oversized, empty or reserved names/values are refused with a clear error rather than accepted.
10. State and gates are scoped per item, not to the whole collection, where the task is per item.
11. Unknown or malformed input fails closed (refused with a reason), never silently ignored or dropped.
12. Identities and evidence (SHAs, PR numbers, heads, attestations) are compared exactly and normalized, and every claim is bound to the specific head it was checked on.
