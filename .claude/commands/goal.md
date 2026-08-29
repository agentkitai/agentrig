---
description: Work the implementation plan milestone by milestone — fresh branch from main, implement, green tests, PR, adversarial review, fix everything, merge, repeat
argument-hint: "[optional: a single milestone or task; default is to work every remaining milestone in order]"
---

Work the following goal to completion using the full flow below: **$ARGUMENTS**

**If no goal was given, work every unfinished milestone in `docs/STATUS.md`, one at a time, in
order, until they are all done.** Run the full nine-step flow for each milestone separately —
one milestone, one PR, one review, one merge — then return to step 1 for the next. Do not batch
milestones into a single branch or PR, and do not pull a later milestone's work forward into an
earlier one.

Between milestones, report in one short paragraph what landed and what is next, then keep going
without waiting to be asked. Stop early only for the reasons in step 9, or if a milestone is
genuinely blocked — in which case say so once, skip to the next milestone that is not blocked,
and note the skipped one at the end.

Read `CLAUDE.md`, `docs/PLAN.md`, and `docs/STATUS.md` first. `PLAN.md` is the spec; while
working a milestone, work only that milestone.

## The flow — every step, every time

### 1. Start from an up-to-date main
```
git fetch origin main
git checkout -B <designated-branch> origin/main
```
Never build on a stale base, and never stack new work on a branch that already has an open PR —
that balloons the PR under review. If a previous PR is still open, say so and ask how to
sequence before writing code.

### 2. Implement
Scope to one milestone row. Follow the repo rules that keep biting otherwise:
- New event type ⇒ zod variant + `renderEvent` case + a test. Add fields, never repurpose them.
- `memory`/`supervisor` import core *types* only.
- Keep the CLI thin; logic belongs in a package.
- Strict TS, ESM, `verbatimModuleSyntax`, zod at process/file boundaries.

### 3. Prove it green — no exceptions
```
pnpm build && pnpm test && pnpm typecheck
```
All three clean before you push. Tests are **network-free**: drive providers with a fake
`ModelProvider` or an injected `fetchFn`. Never skip, disable, or quarantine a test to get green.

### 4. Update the docs
`docs/STATUS.md`: mark the milestone done, point to the next, and add a notes section recording
decisions made beyond the spec and any caveat a future reader would otherwise trip on. If the
implementation changed a contract, update `docs/PLAN.md` too.

### 5. Commit and push
Clear message: what changed, why, and anything surprising. Push to the designated branch.

### 6. Open the PR
Body lists **every design decision made beyond the spec**, plus known caveats and how it was
verified. Check for a PR template first and mirror it if one exists.

### 7. Adversarial review — always
Fire a subagent to review the diff against `origin/main`. Brief it to assume the author is wrong
until the code proves otherwise, to verify each finding with probes against the built output
before reporting, and to report file:line, severity, a concrete failure scenario, and a fix.
Point it at the specific invariants this milestone can break, and at test quality (vacuous
assertions, untested paths). For credential- or security-touching code, weight leakage,
file permissions, and lifecycle correctness heavily.

### 8. Fix everything it finds
**Do not defer findings.** Fix the majors and the minors, each with a regression test that would
fail against the old code. If a finding is genuinely wrong, say why rather than silently skipping
it. Re-run the full green check and push. Update the PR body if the review invalidated anything
it claims.

### 9. Merge, then continue to the next milestone
Merge once CI (if any) is green, the review findings are resolved, and the head is mergeable.
Then go back to step 1 — restart the branch from the new main and take the next unfinished
milestone — and repeat until the plan is complete.

**Stop and ask instead of merging** if the review surfaces something architecturally significant,
if a fix would widen the milestone's scope, or if a decision is genuinely the user's to make.

## Standing preferences

- Report honestly: if something is untested, say untested. A detailed failure report beats a
  vague success claim.
- Don't suggest the user spend money to unblock work; use what is already configured, and if
  something is truly blocked, say so once and move to what *can* progress.
- Blocked on one path ⇒ keep building everything that doesn't depend on it rather than stalling.
