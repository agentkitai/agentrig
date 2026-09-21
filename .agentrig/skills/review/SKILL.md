---
name: review
description: Independent adversarial code review on the final head using conductor declared-check receipts and targeted mutation probes. Never runs full checks or merges.
---

## Declared external-review contract

Read [shipping policy](../../../docs/SHIPPING-WORKFLOW.md).

Read the ordered `reviewers` declaration from the selected project configuration. It has zero, one,
or two uniquely named slots. Each slot binds an adapter id and immutable model pin; API slots also
bind one existing named provider entry. A slot never grants `canRunChecks` or any equivalent policy.
Workflow policy remains in skills, not core.

Before any reviewer launch, the conductor independently runs the complete declared checks on the
PR's exact HEAD in a clean owned tree. Record source, ordered step names and commands, exits, UTC
start/end, parsed counts, HEAD, and restored tracked/index state. All must be green. Give those
receipts to every reviewer as inputs. Reviewers perform code review only: they never rerun project
checks, though they may run small reviewer-owned probes or named mutants targeted at a suspected
line and must restore them.

Launch each declared slot, in declaration order or concurrently, only through
`scripts/reviewer-adapter.mjs`. The adapter owns its launch command, asserted model source,
empty-output detection, and failed-process detection. It must prove the actual model equals the
slot pin. API adapters use their named provider entry through the existing provider routing; never
copy provider routing into a skill. Post the verbatim result with `scripts/post-review-comment.mjs`.
The canonical first line is exactly:
`## External review — <slot> (<model>) — head <SHA> — full`.
Only configured slots count. A heading whose model differs from that slot's configured pin, an
empty/failed launch, stale SHA, heading alone, or incomplete chunk set is missing evidence.

With zero slots, launch nothing and write `External review: none declared` in the PR ledger; the
path is builder → author checks → conductor exact-head checks → exact-head CI → authorized land.
With one slot, that slot supplies the full review and every later focused-delta review. With two,
both slots supply initial full reviews; after material repair, the slot selected for the focused
delta must be one of those declared slots. Hosted CI may overlap review, but required exact-head CI
must be green at landing.

## 1. Fix the target

Review only the supplied exact PR head. Confirm the conductor receipts name that same SHA, include
all declared checks in order, are green, and record restored state. Missing or stale receipts block
the launch rather than asking a reviewer to run the suite.

## 2. Review the code

Read the complete diff and affected invariants. Look for correctness, security, boundary validation,
compatibility, and tests that prove the behavior rather than merely execute it. Treat author claims
and hosted CI as leads, not substitutes for inspection. You may run a tiny reviewer-owned probe or
named mutant for a concrete hypothesis; record it and restore all changes. Never run the project's
bootstrap, preflight, build, test, typecheck, lint, or other declared checks.

## 3. Verdict and provenance

Return a verbatim review with an explicit PASS or blocking findings ordered by severity and precise
`file:line` locations. Include the reviewed HEAD, configured slot name, adapter id, asserted model,
and receipt identifiers. Do not edit code, merge, file issues, or silently turn a finding into a
residual. The conductor posts it through the comment helper under the canonical configured heading.
