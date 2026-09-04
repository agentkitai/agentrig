---
name: review
description: Independent adversarial review of one PR on its final head - isolated worktree, green trio by exit codes, diff against repo invariants, mutation probes on load-bearing lines, verdict. Never merges.
---

# Review flow — the independent final review of a pull request

You are the reviewer of record, not the author and not the merger. Assume the author is wrong
until the code proves otherwise; assume the PR body overstates until you have verified its claims.
Run this in a session that shares no context with the run that wrote the PR.

## 1. Fix the target

- Resolve the PR number to its branch and CURRENT head SHA (`gh pr view <n> --json headRefName,headRefOid,baseRefName`).
  Every claim you make is about that SHA; if the author pushes while you work, your review is of
  the old head — say so and review the delta before giving a verdict.
- Read the PR body and the linked issue for what the change CLAIMS. You will verify, not trust.

## 2. Isolated worktree, merged with main

- `git fetch origin main <branch>`, then `git worktree add <tmpdir> origin/<branch>` — never
  review in a working tree that has your own or anyone else's edits.
- Merge `origin/main` into the worktree. A conflict is a finding in itself (report which files);
  resolve it only to keep testing, never push the resolution.
- `pnpm install` in the worktree before anything else.
- Skip this section when the brief says a conductor prepared the worktree (the `topic`/`ship`
  external review pass runs you via `claude -p` inside one): it is already at the PR head merged
  with `origin/main` with dependencies installed. Do not trust that — confirm with `git log -1`,
  `git status --porcelain` (clean) and `ls node_modules` before §3, and say so in your verdict.

## 3. Green trio, real exit codes

- `pnpm build`, `pnpm test`, `pnpm typecheck` — run each separately, judge each by its EXIT CODE.
  Piping through `grep`/`tail` returns the pipe's status and has masked real failures; an empty
  log with exit 0 means the command never ran, not that it passed.
- Also confirm CI is green on the ACTUAL head SHA, both platforms — a green run on a stale head
  proves nothing.

## 4. Read the whole diff against the repo's invariants

`git diff origin/main...origin/<branch>` — all of it, not the files the PR body mentions.

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
  `pnpm exec vitest run <file>`, restore, and only then run the next mutant — never overlap runs
  in one worktree. A surviving mutant on a security line is a finding even when every test passes.
- Where the PR claims "verified fail-first" or "mutant killed", re-run at least one of those
  claims yourself.

## 6. Verdict

- Findings: file:line, severity (HIGH/MEDIUM/LOW), a concrete failure scenario, a proposed fix.
  Distinguish "must fix before merge" from test gaps from cosmetic notes.
- A pass verdict lists what you probed and which mutants you ran — "looks good" with no evidence
  is not a review.
- Report which of the PR body's claims you verified, and any you could not.

## 7. Boundaries

- **Never merge, never approve-and-merge, never push to the PR branch.** The verdict goes to the
  human, or to the `topic` conductor executing the human's already-authorized fixed band; landing is
  a separate flow under the `land` skill either way. The reviewer never treats its own verdict as
  merge authorization.
- Remove the worktree when done. Leave the main working tree exactly as you found it.
