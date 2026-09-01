---
name: dogfood
description: The end-to-end shipping flow for any feature, fix, or issue - fresh branch, green trio by exit codes, PR, two parallel external reviews, fix all findings fail-first, stop at the PR.
---

# Dogfood flow — how a change ships in this repository

Follow every step, in order. The steps encode failures that already happened once; skipping one
tends to reproduce the failure that created it.

## 1. Branch

- `git fetch origin main` and branch from `origin/main`: `feat/<slug>`, `fix/<slug>`, or
  `docs/<slug>`. Never work on main. Never stack new work on a branch whose PR is still open —
  say so and stop instead.
- Scope to ONE issue or one roadmap row. If the work grows mid-flight, finish the scoped part and
  note the rest for a new issue.

## 2. Implement

Repository rules that bind (each has bitten before):

- New event type ⇒ zod variant + `renderEvent` case + a test. Add fields, never repurpose them.
- `memory` and `supervisor` import core **types only**. The CLI stays thin — logic lands in a
  package behind a seam.
- `raw/` is immutable; only `SessionStore.append` writes session logs.
- zod at every process/file boundary. Anything that reaches the system prompt without a model
  decision (names, descriptions, file content) is untrusted input: sanitize and bound it.
- Error messages and tool descriptions are model-facing API: a refusal must name the exact fix.

## 3. Prove it green — real exit codes, no exceptions

```
pnpm build && pnpm test && pnpm typecheck
```

- Judge each command by its EXIT CODE, never by grepping output for a pass line: piping through
  `grep`/`tail` returns the pipe's status and has masked real failures twice. When capturing
  output, run the command first, echo `$?`, then inspect the log.
- Tests are network-free: fake `ModelProvider`, injected `fetchFn`, tmpdir fixtures wrapped in
  `realpath` (macOS `/var` is a symlink — CI has a macOS leg and this exact mismatch has failed it).
- Never skip, disable, or quarantine a test to get green.

## 4. Tests carry the proof

- **Fail-first**: every behavior change gets a test that fails with the change reverted. Verify
  that by actually reverting (copy the file aside, apply the mutant, run, restore) — do not assume.
- **Both directions**: a fix needs its constraint pinned too (the thing that must still fire, not
  just the thing that must stop firing).
- **Mutation checks on the security-relevant lines especially** — reviews have repeatedly found
  the most safety-critical condition is exactly the one no mutant targeted.

## 5. Documentation

- `docs/STATUS.md`: a section for this change — what shipped, decisions beyond the spec, rejected
  ideas, caveats a future reader would trip on. Update `docs/ROADMAP.md` if a row's contract moved.

## 6. Commit and push

- Clear message: what changed, why, anything surprising. No model identifiers in commits, PR
  titles/bodies, or code comments.
- `git push -u origin <branch>`; on network failure retry with backoff.

## 7. Open the PR — after green, not before

`gh pr create` with a body that lists: summary, **every design decision beyond the spec** (with
the reasoning), verification (test count, what the new tests pin, which mutants were killed), and
known caveats. If the implementation diverged from the issue, say where and why.

## 8. Two external reviews, in parallel, as background jobs

Start both with `bash` `background: true` and poll with `bash_job` using `waitMs` (never a sleep
loop, never a foreground command that a timeout can kill):

- `codex review` over the full diff against `origin/main`.
- A `claude` review of the same diff.

Brief each reviewer to: assume the author is wrong, verify every finding against the actual code
before reporting it, and report file:line + severity + a concrete failure scenario + a fix.
If you push more commits after starting a review, the review is stale for the new diff — extend
or re-run it over the delta before treating its verdict as covering the branch.

## 9. Fix everything both reviews found

- Fix majors AND minors, each with a fail-first regression test — reuse the reviewer's exact
  mutant as the fail-first check where one was given.
- A finding you believe is wrong is rebutted in the PR body with the reason, never silently
  skipped. Re-run the full green trio, push, and update the PR body so it describes the final
  state (a body that describes the pre-review code is stale documentation).

## 10. Stop at the PR

- **Never merge.** Report the PR number, what shipped, what the reviews found and how each
  finding was resolved, then stop. Merging is a human decision.
- When the supervisor's budget warning arrives, stop starting work: finish the current change,
  run the trio, update STATUS, commit, push, open or update the PR. A pushed branch with an
  honest PR body beats a perfect uncommitted worktree.
