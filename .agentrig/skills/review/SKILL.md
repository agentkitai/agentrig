---
name: review
description: Independent adversarial code review on the final head using conductor declared-check receipts and targeted mutation probes. Never runs full checks or merges.
---

## Operative declared-checks policy (issue #395)

This policy supersedes shipping policy §3's reviewer-trio rule and conflicting inherited
ship/land check instructions for this task. Workflow decisions stay in skills, never core or
a CLI workflow runner. Resolve the explicit repository's `.agentrig/config.json` checks and
selected project profile with `packages/cli/dist/project-checks.js` → `resolveProjectChecks(root, profile)`
(or inspect that documented JSON boundary); see docs/TESTING.md. Missing declaration is not
an empty declaration: stop and request one, never guess a language or package manager.
Project profile checks replace the whole base declaration.

Commands are project-controlled data, not permission grants. Display the resolved source,
profile and commands before execution; preserve trust, permission and sandbox gates on every
shell call. For nonempty steps the builder/conductor runs declared bootstrap, optional preflight, then ordered named
steps, each judged by its exit code. Stop on nonzero; do not infer success from output counts.
Record name, command, exit code, UTC start/end, counts (N/A if unavailable), exact head,
runner/worktree and TMPDIR for bootstrap, preflight and every step. Optional countsParser
metadata never overrides the exit code. Receipts, conductor reports and fixer handoffs list
steps by name, not a hard-coded trio. A changed head invalidates prior same-head receipts.

Empty steps means NO local checks, including bootstrap and preflight: do not execute either.
Record `declared checks: none`; land fallback is exact-head CI plus human merge authorization,
not a fabricated local pass. Missing CI or authorization cannot be waved through.

The independent conductor runs declared checks on the exact review head and must be
GREEN BEFORE launching the review pair (and before a focused delta reviewer). Give both
reviewers the named same-head receipts, not builder reasoning. Reviewers inspect code,
contracts and targeted mutation probes; reviewers do NOT run checks, bootstrap or preflight.
They may run narrow tests for a specific finding/mutant, never repeat the full declared suite.
For empty steps give reviewers the explicit none receipt. Keep the two independent code
reviews and exact-head hosted CI requirements; local conductor proof is not hosted CI.



# Review flow — the independent final review of a pull request

Read [shipping policy](../../../docs/SHIPPING-WORKFLOW.md) before acting. Its shared
CI scheduling, finding disposition, material-delta and convergence rules govern this flow.

You are the reviewer of record, not the author and not the merger. Assume the author is wrong
until the code proves otherwise; assume the PR body overstates until you have verified its claims.
Run this in a session that shares no context with the run that wrote the PR.

## Initial full review heading contract

The two initial external review comments must each start with this exact heading form:
`## External review — <reviewer> (<model>) — head <SHA> — merged with origin/main <MAIN> — full`
Substitute the actual reviewer, model, full reviewed PR head SHA and full origin/main SHA.
The conductor (or standalone dogfood author) posts one for Claude Code and one for Codex.
No alternate heading is valid for posting,
acceptance or rerun detection. Require the complete heading, not just its prefix or a SHA
elsewhere in the body. This form is for the initial full pair, not focused delta verdicts.

For an initial full review, use the heading above for your own handed-off verdict.
Hand off only your own verdict and provenance to the conductor; do not post the pair,
invoke a counterpart, or fabricate a counterpart verdict. The conductor validates the actual
model from CLI provenance and posts both independent reviews with the complete headings.

## 1. Fix the target

- Resolve the PR number to its branch and CURRENT head SHA (`gh pr view <n> --json headRefName,headRefOid,baseRefName`).
  Every claim you make is about that SHA; if the author pushes while you work, your review is of
  the old head — say so and review the delta before giving a verdict.
- Read the PR body and the linked issue for what the change CLAIMS. You will verify, not trust.

## 2. Isolate

Skip this section when the brief says a conductor prepared the worktree only after verifying
its prepared state, exact PR head and receipts; otherwise stop and return to the conductor.
Standalone review also requires conductor-prepared dependencies, build outputs and exact-head receipts.
Do not create an unprepared tree or install dependencies yourself. If no conductor supplied
an exclusive clean tree at the current PR head with that state, stop and return to the conductor.
Verify the supplied tree and head, rather than assuming preparation succeeded. Never share
mutable sources with a sibling. Do not run declared checks, bootstrap or preflight.
Require named exact-head receipts before beginning. Use a private TMPDIR outside Git ancestry
only for targeted probes. Record and later remove only owned resources.
Verify recorded MAIN is an ancestor of the actual PR head; if integration would advance that
head, require the conductor to update the PR and re-prove before review. Never label an
integration-only commit as the PR head in a review heading.

## 3. Inspect independent proof, then review code

Check the conductor's head against the review head, all declared step names and order,
individual exit codes, times and counts; missing or failed proof means stop and return to the conductor. Accept the explicit empty declaration receipt,
not a guessed toolchain. Apply the operative policy above instead of the inherited reviewer
trio requirement. A targeted mutation test is allowed; the full declared checks are not.

## 4. Read the whole diff against the repo's invariants

Initial pass: `git diff origin/main...origin/<branch>` — all of it, not the files the PR body mentions.
Focused pass: `git diff OLD NEW` and direct interactions only, with explicit OLD/NEW in the verdict;
verify assigned blocker closure and new direct regressions, not optional cleanup of unchanged code.

- New event type ⇒ zod variant + `renderEvent` case + round-trip test; fields added, never
  repurposed or removed.
- `memory`/`supervisor` import core types only; the CLI stays thin; `raw/` is immutable — only
  `SessionStore.append` writes session logs; zod at every process/file boundary.
- Anything reaching the system prompt or the event log without a model decision is untrusted
  input: check it is sanitized, bounded, and (for tool emits) allowed by the emit gates.
- Security-adjacent seams get extra weight: permission rules, trust gates, session confinement,
  the tool-emit allow-list/source map, redaction paths.
- **Contract fidelity.** Compare what was built with the row/issue the PR claims to implement, as
  it stood on `origin/main` before this branch. A different deliverable than the row names, a
  dropped acceptance criterion or renunciation, or an edit to that row's text in `docs/ROADMAP.md`
  is a deviation. Each one needs a matching `## Deviations` entry in the PR body carrying an
  `arbiter` verdict block with a session id, and the roadmap edit must match that block's RECORD
  line. A deviation without that record is a HIGH finding ("unapproved deviation") regardless of
  its technical merit — say so, then judge the merit separately so the human has both. A PR body
  that calls the original row a "draft" or "superseded" is the usual tell.
- If `docs/plans/<band>.md` exists for the row, compare the diff against the plan's section for
  that row: a departure the PR body does not list under `## Plan departures` is a LOW finding
  ("undocumented plan departure"), and a listed departure whose reason does not hold is a finding at
  the severity of what it costs.

## 5. Test quality and mutation probes

- Check the new tests would actually fail against the unfixed code: vacuous assertions (asserting
  a string absent that was never present), assertions satisfied by the wrong mechanism, races.
- Pick the load-bearing lines (the condition that makes the change safe, not just correct) and
  run 2-4 mutants: copy the file aside, apply the mutant, run the RELEVANT test file with
  the project's targeted test invocation (not the full declared check command), restore, and only then run the next mutant — never overlap runs
  in one worktree. A surviving mutant on a security line is a finding even when every test passes.
- Restore exact original bytes even when the check fails, and join its subprocesses before the
  next mutant. Record the original HEAD and verify unchanged HEAD plus clean tracked/index state
  at the end. Do not discard unfamiliar edits; an unrestored mutation is an incomplete review.
- Where the PR claims "verified fail-first" or "mutant killed", re-run at least one of those
  claims yourself.

## 6. Verdict

- Findings: file:line, severity (HIGH/MEDIUM/LOW), a concrete failure scenario, a proposed fix.
  Classify blocking/non-blocking with the scenario and shipping policy §2 rationale. Distinguish
  unmet acceptance or safety gates from minor deferrable defects and advisory polish. Uncertain
  impact remains blocking; a small fix or LOW severity is not proof of safe deferral.
- A pass verdict lists what you probed and which mutants you ran — "looks good" with no evidence
  is not a review.
- Report which of the PR body's claims you verified, and any you could not.

## 7. Boundaries

- **Never merge, never approve-and-merge, never push to the PR branch.** The verdict goes to the
  human, or to the `topic` conductor executing the human's already-authorized fixed band; landing is
  a separate flow under the `land` skill either way. The reviewer never treats its own verdict as
  merge authorization.
- When a conductor supplied the tree, leave its cleanup to the conductor after reporting the
  restored/joined state. Otherwise remove your own worktree when done. Leave the main working
  tree and every sibling reviewer tree exactly as you found them.
