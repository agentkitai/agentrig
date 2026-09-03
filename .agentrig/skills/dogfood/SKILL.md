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

**Deviation gate — you do not change your own contract.** If the row, issue, or task you were
given turns out to be wrong, infeasible, or worse than an alternative (a different backend, a
dropped acceptance criterion, a wider scope), you may propose a change but never decide it:

- Write the proposal: the contract verbatim, what you want instead, why (a fact you can show, not
  a preference), what is lost, alternatives, and the exact roadmap/issue text you would write.
- Standalone: spawn an `arbiter` subagent with that proposal, the contract, and the human's
  authorization sentence, and proceed only on `VERDICT: APPROVE`. Under `ship` or `topic` you
  cannot spawn (children do not nest): commit and push what you have, stop, and end your report
  with the proposal under a `DEVIATION REQUESTED` heading — the conductor arbitrates and continues.
- An approved deviation is recorded three times: the arbiter's verdict block plus its session id
  under `## Deviations` in the PR body, the roadmap/issue edit matching the verdict's RECORD line,
  and the commit message that makes that edit. Never edit the row you are implementing without
  that record; a contract change without one is a HIGH review finding.
- `VERDICT: REJECT` means build the contract as written. If you believe that is infeasible, stop
  and report — the human decides, not you and not the arbiter.

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
  ideas, caveats a future reader would trip on — and the "Current roadmap row" line at the top,
  which names the row this PR completes and the next one. Update `docs/ROADMAP.md` if a row's
  contract moved, and mark the row you are completing `*(done)*` in its table cell (`| R2b
  *(done)* |`): `grep -E '^\| R[0-9]' docs/ROADMAP.md | grep -v '(done)'` is the live backlog, and
  a row left unmarked is a row the next train may rebuild.

## 6. Commit and push

- Clear message: what changed, why, anything surprising. No model identifiers in commits, PR
  titles/bodies, or code comments.
- `git push -u origin <branch>`; on network failure retry with backoff.

## 7. Open the PR — after green, not before

`gh pr create` with a body that lists: summary, **every design decision beyond the spec** (with
the reasoning), `## Deviations` (every approved contract change with its arbiter verdict block and
session id, or "none"), verification (test count, what the new tests pin, which mutants were
killed), and known caveats. If the implementation diverged from the issue, say where and why.

## 8. Two external reviews, in parallel, as background jobs

Start both with `bash` `background: true` and poll with `bash_job` using `waitMs` (never a sleep
loop, never a foreground command that a timeout can kill):

- `codex review` over the full diff against `origin/main`.
- A `claude` review of the same diff, pinned to Opus and given the tools to VERIFY, not just read:
  `claude -p --model claude-opus-5 --permission-mode plan --allowedTools 'Read,Grep,Glob,Bash' "…"`.
  Opus is strong enough for adversarial code review at a fraction of the cost, and the pin keeps
  review spend independent of whatever model the main session happens to be running. Without
  `--allowedTools` including Bash the reviewer cannot run vitest or probe built output, and its
  first line becomes "I could not execute the test suite" — a read-only review that verifies
  nothing, which the brief below explicitly forbids.

Brief each reviewer to: assume the author is wrong, verify every finding against the actual code
before reporting it, and report file:line + severity + a concrete failure scenario + a fix.

**Under `ship` or `topic`, skip this section.** A builder spawned by either conductor stops at
the PR (§7) and does NOT run external reviews: the conductor spawns an independent reviewer
child (fresh worktree, mutants, no shared context) that IS the review, and running both was
measured at four review passes per PR — ~90 minutes for a skill file, with no extra eyes on the
code. Your task text says when you are a child. Standalone dogfood keeps both reviews because
nothing else reviews it.

Staleness, bounded: if you push more commits after a review ran, the review is stale for the
**delta only** — re-review the diff since the last reviewed commit, never the whole branch again,
and never a fresh full dual review per commit. A fix-only commit that addresses review findings
is verified by its fail-first regression tests, not by another review round. Cap the cycle at
**one delta re-review** after the findings round — ONE reviewer over the delta, never a fresh dual
round. **The cap bounds review rounds, not fixes**: whatever that delta reviewer finds is never
re-reviewed by a second agent — §9's "fix everything" applies to the findings round only. A LOW
with a concrete fix may still be fixed after the delta round when the fix carries a fail-first
test and a killed mutant: commit it separately, label it in the PR body as
**post-delta, self-verified, not re-reviewed**, and let the human see that label at merge. Anything the delta
reviewer finds that you do not fix — a MEDIUM or HIGH (which needs eyes a self-check cannot
give), or a LOW you judge inherent — becomes **one GitHub issue per finding** via
`gh issue create` (title `[review residual] <one line>`, label `review-residual`, body: severity,
file:line, scenario, proposed fix, PR number, head SHA, reviewer session id), listed by number
under `## Residuals` in the PR body. A finding that lives only in a PR body is a finding nobody
will act on. Under `topic` the loop in that skill applies instead. Per-commit full-review loops have burned
hours of budget on nits without converging: the #82 run spent two hours on a skill file because
"fix everything" and "one delta round" were read as compatible; PR #90 is the shape this rule
describes — three LOWs fixed post-delta with tests, one inherent LOW recorded.

## 9. Fix everything both reviews found

- Fix majors AND minors, each with a fail-first regression test — reuse the reviewer's exact
  mutant as the fail-first check where one was given.
- A finding you believe is wrong is rebutted in the PR body with the reason, never silently
  skipped. A finding you accept but do not fix in this PR is an issue (§8's `review-residual`
  format), never a paragraph. Re-run the full green trio, push, and update the PR body so it
  describes the final state (a body that describes the pre-review code is stale documentation).

## 10. Stop at the PR

- **Never merge.** Report the PR number, what shipped, what the reviews found and how each
  finding was resolved, then stop. Merging is a human decision.
- When the supervisor's budget warning arrives, stop starting work: finish the current change,
  run the trio, update STATUS, commit, push, open or update the PR. A pushed branch with an
  honest PR body beats a perfect uncommitted worktree.
