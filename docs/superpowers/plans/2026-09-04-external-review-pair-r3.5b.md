# External Review Pair (R3.5b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `topic` and `ship` release-train skills review every PR with two external reviewers that share nothing with the builder, Claude Code (`claude -p`, pinned to `claude-opus-5`) and Codex (`codex review`), run in parallel in one conductor-made worktree on full and delta reviews, with findings merged by the conductor and posted as PR comments.

**Architecture:** The procedure lives once, in `topic` §2 step 4; `ship` refers to it. The `review` skill is unchanged in substance and becomes the brief handed to Claude, with one note about a conductor-prepared worktree. `dogfood` §8 keeps its child-skips rule with a new rationale. The core test that pins skill phrases is updated in the same tasks, so drift is caught by `pnpm test`. No source code changes.

**Tech Stack:** Markdown skill files under `.agentrig/skills/`, vitest pins in `packages/core/test/skills.test.ts`, the `bash` tool's `background: true` + `bash_job` (`id`, `action: status|kill`, `waitMs` ≤ 5 min per call), `gh`, `claude` CLI 2.1.x, `codex` CLI 0.153+.

**Spec:** `docs/superpowers/specs/2026-09-04-provider-routing-design.md` §6 (train review via the external pair), with §1's role table and §11's decisions. R3.5a (code) is PR #112.

## Global Constraints

- **Branching:** this repo never stacks PRs. Create `r3.5b-external-review` from `origin/main` only after PR #112 has merged (`git fetch origin main && git log --oneline -1 origin/main` must show the R3.5a squash). A pre-merge branch holding only this plan file is rebased onto `origin/main` first: `git rebase --onto origin/main r3.5a-provider-routing r3.5b-external-review`.
- **No source changes.** Only `.agentrig/skills/{topic,ship,dogfood,review}/SKILL.md`, `packages/core/test/skills.test.ts`, `docs/ROADMAP.md`, `docs/STATUS.md`.
- **Pinned phrases.** `packages/core/test/skills.test.ts` ("pins the topic release train's authorization and stop contract") asserts exact substrings of `topic`, `land`, `review`, `arbiter`. Every task that edits a pinned phrase updates the pin in the same commit; every new contract sentence gets a new pin. Descriptions stay ≤ 200 characters.
- **The Claude command is exactly:** `claude -p --model claude-opus-5 --permission-mode plan --allowedTools 'Read,Grep,Glob,Bash' --output-format json --no-session-persistence "<brief>" < /dev/null`, run with the Claude nesting variables unset (`env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN -u CLAUDE_CODE_BRIDGE_SESSION_ID -u CLAUDE_PID`). The result's `modelUsage` keys must be exactly `["claude-opus-5"]`; anything else is a failed job, never a substitute review.
- **The Codex command is exactly:** `codex review --base review-base "<brief>"`, where `review-base` is a local branch the conductor points at `origin/main` (full) or the previous head (delta).
- **Both reviewers, always, in parallel** — on the full review and on every delta re-review. A job is dead when killed at the 45-minute cap, exits non-zero, or produces empty output; a dead job is retried once on the same head; both reviewers dead on the same head halts the train.
- **Provenance:** every review is posted verbatim as a PR comment headed `## External review — <Claude Code (claude-opus-5) | Codex> — head <SHA> — <full | delta OLD..NEW>`; the comment URLs replace reviewer session ids in reports. Review artifacts are written under a `mktemp -d` directory, never inside the review worktree.
- **Arbiter** is spawned with the `subagent` tool's `provider` field set to the entry the field's description names as the main session's; builders, fixers and landers never name a provider.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_016p4FQNz6Bs5NgtsZLTThBG`.
- Run the pins with `pnpm exec vitest run packages/core/test/skills.test.ts`; the final gate is `pnpm build && pnpm test && pnpm typecheck`.

---

## File structure

| File | Responsibility after this plan |
|---|---|
| `.agentrig/skills/topic/SKILL.md` | Owns the external review pass (§2 step 4), the delta re-review (§3), preflight child counts, arbiter provider, report contents. |
| `.agentrig/skills/ship/SKILL.md` | Delegates review to `topic` §2 step 4 and delta re-reviews to `topic` §3. |
| `.agentrig/skills/dogfood/SKILL.md` | §8 child-skips rule with the R3.5b rationale. |
| `.agentrig/skills/review/SKILL.md` | The brief Claude follows; §2 gains the conductor-prepared-worktree note. |
| `packages/core/test/skills.test.ts` | Pins for every contract phrase above. |
| `docs/ROADMAP.md`, `docs/STATUS.md` | R3.5a and R3.5b marked done; status line advanced to R4a. |

---

### Task 1: `topic` runs the external review pass

**Files:**
- Modify: `.agentrig/skills/topic/SKILL.md:8-9` (conductor sentence), `:36-44` (preflight), `:64-73` (arbiter spawn), `:74-90` (steps 4-5), `:97-103` (arbitrate bullet), `:112-115` (delta bullet), `:123-129` (residual issue body), `:155-156` (report list)
- Test: `packages/core/test/skills.test.ts:298-326` (topic pins)

**Interfaces:**
- Produces the phrase `the external review pass (§2 step 4)` that Task 2's `ship` text refers to, and the comment heading format Task 2's dogfood/review notes mention.

- [ ] **Step 1: Write the failing pins**

In `packages/core/test/skills.test.ts`, inside the test `"pins the topic release train's authorization and stop contract"`, change the line
`expect(body).toContain("The minimum is three children per remaining");`
to
`expect(body).toContain("The minimum is two children per remaining");`
and add, directly after the `expect(body).toContain("restate it in your own reply text in that same turn");` line:

```ts
    // R3.5b: the review is two external CLIs the conductor runs, never a child and never itself
    expect(body).toContain("two reviewers that share nothing with the builder, in parallel, in one worktree you prepare");
    expect(body).toContain("--model claude-opus-5 --permission-mode plan --allowedTools 'Read,Grep,Glob,Bash'");
    expect(body).toContain("--output-format json --no-session-persistence");
    expect(body).toContain('not claude-opus-5');
    expect(body).toContain("codex review --base review-base");
    expect(body).toContain("both reviewers dead on the same head halts the train");
    expect(body).toContain("gh pr comment");
    expect(body).toContain("## External review —");
    expect(body).toContain("runs on the main entry, never the child default");
    expect(body).toContain("run the external review pass again");
    expect(body).toContain("never write review artifacts inside");
```

- [ ] **Step 2: Run the pins to verify they fail**

Run: `pnpm exec vitest run packages/core/test/skills.test.ts -t "pins the topic release train"`
Expected: FAIL on `"The minimum is two children per remaining"` (the file still says three).

- [ ] **Step 3: Edit the conductor sentence (lines 8-9)**

Replace:

```
You are the conductor, not the builder, reviewer, fixer, or merger. Use the `subagent` tool for
all of those children; do not do their work in this parent session. Keep your own turns few.
```

with:

```
You are the conductor, not the builder, fixer, or merger. Use the `subagent` tool for those
children; do not do their work in this parent session. Reviews are external CLI jobs you start and
wait on (§2 step 4), never a child and never your own reading of the diff. Keep your own turns few.
```

- [ ] **Step 4: Edit the preflight bullet (lines 36-44)**

Replace the sentence
`The minimum is three children per remaining row (builder, full reviewer, lander); repair rounds, arbitration and continuations draw on the same pool as needed — a row that exhausts the pool mid-loop halts there, so size the pool for the band (a row that goes three rounds costs nine).`
with
`The minimum is two children per remaining row (builder, lander) — reviews are external CLI jobs, not children (§2 step 4); repair-round fixers, arbitration and continuations draw on the same pool as needed — a row that exhausts the pool mid-loop halts there, so size the pool for the band (a row that goes three rounds costs five, six with an arbiter).`
Keep the rest of the bullet (`--subagent-max-turns`, token caps) verbatim.

- [ ] **Step 5: Arbiter on the main entry (lines 64-73)**

In step 3, replace
`Spawn an `arbiter` subagent with the proposal verbatim, the row text from §1, and `AUTHORIZATION`; record its id.`
with
`Spawn an `arbiter` subagent with the proposal verbatim, the row text from §1, and `AUTHORIZATION`, setting the `subagent` tool's `provider` field to the entry its description names as the main session's (omit the field when the tool offers none) — arbitration is judgment and runs on the main entry, never the child default; builders, fixers and landers never name a provider. Record its id.`

- [ ] **Step 6: Replace step 4 (lines 74-78) with the external review pass**

Replace the whole of step 4 with:

````
4. Run the **external review pass** on the PR's current head: two reviewers that share nothing
   with the builder, in parallel, in one worktree you prepare. Never pass the builder's report,
   reasoning, findings, or claimed evidence to either reviewer; the PR and the repository are their
   only evidence.
   - **Prepare.** `gh pr view NN --json headRefName,headRefOid` gives `BRANCH` and `HEAD`. Then
     `git fetch origin main "$BRANCH"`, `WT=$(mktemp -d)`, `git worktree add "$WT" "$HEAD"`, and in
     `$WT`: `git merge --no-edit origin/main` (a conflict is a finding for §3 — record which files
     and stop the pass), `git branch -f review-base origin/main`, `pnpm install`. `OUT=$(mktemp -d)`
     holds every output file; never write review artifacts inside `$WT`.
   - **Claude job** — `bash` with `background: true`, cwd `$WT`:
     ```
     env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION \
         -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN -u CLAUDE_CODE_BRIDGE_SESSION_ID -u CLAUDE_PID \
       claude -p --model claude-opus-5 --permission-mode plan --allowedTools 'Read,Grep,Glob,Bash' \
         --output-format json --no-session-persistence \
         "Review PR #NN at head SHA HEAD. Read .agentrig/skills/review/SKILL.md and follow it. You are already in an isolated worktree at that head, merged with origin/main, with dependencies installed: skip its section 2 and verify that state yourself. Assume the author is wrong; verify every finding against the code before reporting it; report file:line, severity (HIGH/MEDIUM/LOW), a concrete failure scenario and a fix. Report the exact head SHA you reviewed." \
         < /dev/null > "$OUT/claude.json"
     ```
     The `env -u` list matters when this session was itself launched from inside Claude Code
     (the nesting variables make the child report "not logged in"); `< /dev/null` keeps it from
     waiting on stdin.
   - **Codex job** — `bash` with `background: true`, cwd `$WT`:
     ```
     codex review --base review-base "Review this PR's diff against review-base. Assume the author is wrong; verify every finding against the code before reporting it; report file:line, severity (HIGH/MEDIUM/LOW), a concrete failure scenario and a fix; state the head SHA you reviewed." > "$OUT/codex.md" 2> "$OUT/codex.err"
     ```
   - **Wait** with `bash_job` (`action: status`, `waitMs` up to 5 minutes per call; never a sleep
     loop). A job still running 45 minutes after it started is dead: `bash_job` `action: kill` it.
     A dead job (killed, non-zero exit, or empty output) is retried ONCE on the same head; both
     reviewers dead on the same head halts the train.
   - **Assert the model and extract the Claude review:**
     ```
     node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const m=Object.keys(r.modelUsage??{});if(m.length!==1||m[0]!=="claude-opus-5"){console.error("claude review ran on "+(m.join(",")||"unknown")+", not claude-opus-5");process.exit(2)}process.stdout.write(String(r.result??""))' "$OUT/claude.json" > "$OUT/claude.md"
     ```
     A non-zero exit here is a dead job, never a review to use.
   - **Provenance.** Post each review verbatim as a PR comment, headed
     `## External review — Claude Code (claude-opus-5) — head HEAD — full` and
     `## External review — Codex — head HEAD — full`, with `gh pr comment NN --body-file "$OUT/…"`,
     and record both comment URLs — they stand in for reviewer session ids. Then
     `git worktree remove --force "$WT"`.
   - **Merge.** Tag every finding `[claude]` or `[codex]`, collapse duplicates (same file:line and
     the same scenario), and sort the union under step 5. Both reviews must name `HEAD` as the
     SHA they reviewed; a mismatch is a stale pass — rerun it on the current head.
````

- [ ] **Step 7: Edit step 5 (lines 79-90)**

Replace
`Bind the verdict to the head SHA the reviewer reports; a head that changes other than through §3's loop is stale — spawn a fresh reviewer on the new head rather than halting. If the reviewer dies at budget, spawn one more on the same head. Sort its findings, never by severity:`
with
`Bind the verdict to the head SHA both reviews report; a head that changes other than through §3's loop is stale — rerun the pass on the new head rather than halting. Sort its findings, never by severity:`
(the rest of step 5 is unchanged; `Sort its findings, never by severity` stays verbatim because it is pinned).

- [ ] **Step 8: Edit §3 (arbitrate, delta, residual bullets)**

In the **Arbitrate first** bullet, replace `spawn an `arbiter` subagent with the deviation exactly as the reviewer described it,` with `spawn an `arbiter` subagent (on the main entry, as in §2 step 3) with the deviation exactly as the review described it,`.

Replace the whole **Re-review the delta** bullet with:

```
- **Re-review the delta**: run the external review pass again (§2 step 4) over the delta only.
  Refresh the worktree to the new head (`git worktree add` at NEW, merge `origin/main`,
  `git branch -f review-base OLD`, `pnpm install`) and brief both reviewers with the PR number and
  the old/new head SHAs: "review only the changes OLD..NEW under the review skill's standards;
  never assume the previous review's findings — verify the code as it is now". They never see
  either author's report. Post both as PR comments headed `… — delta OLD..NEW`. A clean, fully
  verified delta verdict from both reviewers lands (§4). Findings on the delta open the next round.
```

In the **After the third round** bullet, replace `the reviewer's session id` with `the reviewer (Claude Code or Codex) and its PR-comment URL`.

- [ ] **Step 9: Edit the report list (lines 155-156)**

Replace
`- every builder, reviewer, fixer, delta-reviewer, arbiter, and lander session id, labeled by row and role;`
with
`- every builder, fixer, arbiter, and lander session id, labeled by row and role, and the PR-comment URL of every external review (Claude Code and Codex, full and delta) with the head SHA it reviewed;`

- [ ] **Step 10: Run the pins to verify they pass**

Run: `pnpm exec vitest run packages/core/test/skills.test.ts`
Expected: PASS, all tests in the file, including "the repository's own checked-in skills parse and fit the catalogue bounds".

- [ ] **Step 11: Commit**

```bash
git add .agentrig/skills/topic/SKILL.md packages/core/test/skills.test.ts
git commit -m "docs(skills): topic reviews every PR with claude -p + codex review in parallel (R3.5b)"
```

---

### Task 2: `ship`, `dogfood`, and `review` follow the pass

**Files:**
- Modify: `.agentrig/skills/ship/SKILL.md:28-33` (§2), `:39-45` (§3 fix loop sentence)
- Modify: `.agentrig/skills/dogfood/SKILL.md:109-114` (the child-skips paragraph)
- Modify: `.agentrig/skills/review/SKILL.md:20-25` (§2)
- Test: `packages/core/test/skills.test.ts` (new pins after the review pins, ~line 340)

**Interfaces:**
- Consumes: `topic` §2 step 4 and §3 wording from Task 1.

- [ ] **Step 1: Write the failing pins**

After the two `expect(review.body).toContain(...)` lines in the topic-contract test, add:

```ts
    // R3.5b: ship delegates the review pass to topic; dogfood children still skip it; review knows a prepared worktree
    expect(review.body).toContain("Skip this section when the brief says a conductor prepared the worktree");
    const shipText = await readFile(".agentrig/skills/ship/SKILL.md", "utf8");
    const ship = parseSkill(shipText, ".agentrig/skills/ship/SKILL.md");
    expect(ship.body).toContain("exactly as `topic` §2 step 4 prescribes");
    expect(ship.body).toContain("Never review in this session");
    const dogfoodText = await readFile(".agentrig/skills/dogfood/SKILL.md", "utf8");
    const dogfood = parseSkill(dogfoodText, ".agentrig/skills/dogfood/SKILL.md");
    expect(dogfood.body).toContain("the conductor runs the same two external reviews itself");
```

- [ ] **Step 2: Run the pins to verify they fail**

Run: `pnpm exec vitest run packages/core/test/skills.test.ts -t "pins the topic release train"`
Expected: FAIL on the `review.body` pin.

- [ ] **Step 3: Edit `ship` §2**

Replace the §2 bullet with:

```
- Run the external review pass exactly as `topic` §2 step 4 prescribes: two external reviewers
  (Claude Code pinned to `claude-opus-5`, and Codex) in parallel in one worktree you prepare, the
  model asserted from `modelUsage`, both reviews posted as PR comments, findings tagged and merged.
  Never review in this session and never pass the builder's report to either reviewer; the PR and
  the code are their only inputs.
```

In §3, replace `then a delta re-review of what changed, and loop the two` with `then a delta re-review of what changed — the same external pass over OLD..NEW as `topic` §3 describes — and loop the two`.

- [ ] **Step 4: Edit `dogfood` §8's child paragraph**

Replace:

```
**Under `ship` or `topic`, skip this section.** A builder spawned by either conductor stops at
the PR (§7) and does NOT run external reviews: the conductor spawns an independent reviewer
child (fresh worktree, mutants, no shared context) that IS the review, and running both was
measured at four review passes per PR — ~90 minutes for a skill file, with no extra eyes on the
code. Your task text says when you are a child. Standalone dogfood keeps both reviews because
nothing else reviews it.
```

with:

```
**Under `ship` or `topic`, skip this section.** A builder spawned by either conductor stops at
the PR (§7) and does NOT run external reviews: the conductor runs the same two external reviews
itself, in one worktree, against the PR head (`topic` §2 step 4). Children may run on a local
model and the review must never share the builder's model; a child running the pair too would
double every pass for no extra eyes. Your task text says when you are a child. Standalone
dogfood keeps both reviews because nothing else reviews it.
```

- [ ] **Step 5: Edit `review` §2**

After the `pnpm install` bullet in §2, add:

```
- Skip this section when the brief says a conductor prepared the worktree (the `topic`/`ship`
  external review pass runs you via `claude -p` inside one): it is already at the PR head merged
  with `origin/main` with dependencies installed. Do not trust that — confirm with `git log -1`,
  `git status --porcelain` (clean) and `ls node_modules` before §3, and say so in your verdict.
```

- [ ] **Step 6: Run the pins and the catalogue bounds**

Run: `pnpm exec vitest run packages/core/test/skills.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add .agentrig/skills/ship/SKILL.md .agentrig/skills/dogfood/SKILL.md .agentrig/skills/review/SKILL.md packages/core/test/skills.test.ts
git commit -m "docs(skills): ship delegates to topic's review pass; dogfood and review notes (R3.5b)"
```

---

### Task 3: Roadmap, status, dry run, final gate

**Files:**
- Modify: `docs/ROADMAP.md` (R3.5 table rows), `docs/STATUS.md:3` and the `## R3.5 notes` table

- [ ] **Step 1: ROADMAP and STATUS**

In `docs/ROADMAP.md`'s R3.5 table change `| R3.5a |` to `| R3.5a *(done)* |` and `| R3.5b |` to `| R3.5b *(done)* |`, matching the R3 rows' convention.

In `docs/STATUS.md` line 3 change `**R3.5a is complete (inserted band, see ROADMAP §R3.5); R3.5b is next, then R4a.**` to `**R3.5 is complete (R3.5a, R3.5b — inserted band, see ROADMAP §R3.5); R4a is next.**`. In the `## R3.5 notes` table change the R3.5b row's status from `next` to `done`, and append one bullet:

```
- R3.5b moves the train's review out of subagents entirely: `topic` §2 step 4 runs `claude -p`
  (pinned `claude-opus-5`, asserted from `modelUsage`) and `codex review --base review-base` in
  parallel in one conductor-made worktree, on the full review and on every delta; reviews are
  posted as PR comments and replace reviewer session ids in reports. The arbiter is spawned on
  the main entry. Preflight child counts drop from three to two per row.
```

- [ ] **Step 2: Dry run of the pass against a real PR (no comments posted)**

From the worktree root, pick an open PR (`gh pr list --limit 1 --json number,headRefName,headRefOid`) and run the Prepare, Claude job, Codex job and model-assertion steps of `topic` §2 step 4 verbatim, in the foreground with a 45-minute `timeout` each, writing to a `mktemp -d` directory. Do NOT run `gh pr comment`. Expected: `$OUT/claude.md` and `$OUT/codex.md` are non-empty, the `node -e` assertion exits 0, and both reviews name the PR's head SHA. Paste the two `head -5` excerpts and the assertion's exit code into the commit body of Step 4. If either CLI is not logged in on this machine, record that as the reason the dry run was skipped rather than silently omitting it.

- [ ] **Step 3: Final gate**

Run: `pnpm build && pnpm test && pnpm typecheck`
Expected: green (the skills pins run inside `pnpm test`).

- [ ] **Step 4: Commit and open the PR**

```bash
git add docs/ROADMAP.md docs/STATUS.md
git commit -m "docs: R3.5b done — train review via the external pair; status to R4a"
```

Open the PR from `r3.5b-external-review` to `main` titled `docs(skills): train review via claude -p + codex review in parallel (R3.5b)`, body: spec §6 path, the four skill diffs in one paragraph each, the dry-run evidence, and the note that R3.5b's own review under the new procedure is the first dogfood of it.
