# Ordinary-query quality check — 2026-09-10

## Decision

**Report only; no runtime change.** Five of six read-only probes answered with
correct essential facts and supporting citations. Three were overlong. One lookup
exhausted its eight-request allowance without answering despite having read the
decisive code. A small implementation probe stopped at a permission boundary:
it produced a useful test, but did not complete the requested fix.

One candidate prompt refinement was tested on three questions and rejected:
verbosity barely changed, and a single improved completion does not establish
causality. No further tuning, new model, extra session mode, weakened permission
gate, new roadmap band, or production table fix is part of this delivery.

Builder/report author: Codex/operator outside AgentRig. Independent answer checker:
`/root/eval_quality`; AgentRig session IDs below identify the actual task attempts,
not a release-train conductor. PR #300's implementation is delivered; this report
does **not** establish general live efficiency gains or successful autonomous
implementation.

## Method and limits

The [frozen protocol](query-quality-protocol.json) contains all six exact questions,
limits and decision rule. [Machine-readable results](query-quality-results.json)
retain every attempt, including the failed lookup and implementation. All initial
queries used repository/binary revision `0fc1b3eda556b0cc9269e9faa003eccf58f901cf`,
the `personal` profile, and manifests confirmed `cloud` / `openai-chatgpt` /
`gpt-6-astra` / medium. Two queries ran concurrently. Each had at most eight loop
turns, 150,000 configured tokens and three minutes. These are admission budgets,
not a hard billing ceiling. Queries used headless ask-deny, not YOLO:

```sh
node packages/cli/dist/index.js run --profile personal \
  --no-yolo --no-dangerously-skip-permissions --headless --json \
  --root <isolated-session-directory> \
  --max-turns 8 --max-tokens 150000 --max-minutes 3 '<frozen question>'
```

This is a small observational sweep, **not** a controlled benchmark: one sample
per question, no randomized ordering or matched cache state, one model/profile,
and intentionally tight probe limits. Eight turns is the probe limit, not a new
product default. The earlier user TUI session is not a matched baseline. No
percentage production saving is inferred. The narrow lookup failure is evidence
of noncompletion under this budget, not proof it could never answer with more time.

Requests count root `model.request` events, not retries or auxiliary calls. Input
is the sum of reported input/cache-read/cache-write across responses, **not unique
context size**. Every root response reported complete usage; cache-write was zero.
Seconds span `session.start` through `session.end`, not shell startup or strictly
provider latency. Words count whitespace-separated text in the final turn. Read
scope means no model-dispatched mutation; harness session/cache bookkeeping still
writes. No query dispatched plans, delegates, writes or execution tools.

The independent checker read actual answers, tool traces and cited source. The
rubric was fixed before scoring: facts 0–2 (wrong central claim / material omission /
essentials correct), citations 0–2 (wrong / partial / supporting), read scope 0–1,
and a separate qualitative length judgment. Scores concern requested essentials,
not exhaustive coverage. Missing Q4 answer scores zero for facts/citations; it is
not described as a fabricated answer.

## Initial read-only results

| Probe / session | Requests / tool calls | Input (cached subset) | Output | Seconds | Words | Facts / citations / scope | Outcome |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Q1 grants explanation / `223328bf` | 6 / 21 | 96,298 (67,072) | 2,117 | 84.662 | 802 | 2 / 2 / 1 | Correct, overlong |
| Q2 worktree checkpoints / `76bfe8bb` | 4 / 13 | 54,844 (12,544) | 1,427 | 55.583 | 569 | 2 / 2 / 1 | Correct, overlong |
| Q3 prompt locations / `021afd08` | 7 / 13 | 57,607 (40,320) | 748 | 49.484 | 129 | 2 / 2 / 1 | Correct, proportionate |
| Q4 reset/revoke/counts / `a05f9f3b` | 8 / 20 | 93,032 (64,768) | 662 | 46.542 | 0 | 0 / 0 / 1 | Budget reached, no answer |
| Q5 denied-turn counter / `a6ecf806` | 4 / 13 | 41,039 (21,376) | 970 | 46.856 | 251 | 2 / 2 / 1 | Correct, proportionate |
| Q6 table fallback / `02d7c2ee` | 7 / 16 | 82,801 (58,496) | 1,473 | 72.231 | 454 | 2 / 2 / 1 | Correct, overlong |

Q2's nested-repository caveat was slightly imprecise: the implementation actively
refuses listed nested repositories/submodules, rather than merely excluding their
contents. The checker found no central false claim. Q6 correctly distinguished
width fallback (complete ordinary cells) from structural/output safety limits.
Q4 read the controller and registry evidence needed for the answer but continued
searching. All five completed answers had supporting citations; that is not a
six-of-six quality pass.

## Rejected candidate and three confirmations

Only `defaultSystemPrompt` guidance changed for these runs. The repository being
queried remained at the same main revision; an isolated rebuilt CLI supplied this
candidate, replacing the existing final presentation sentence with:

> For read-only questions, identify the requested points and gather evidence for each.
> Once the requested points are supported, answer; investigate further only to resolve
> a relevant uncertainty, contradiction, or required check. Do not expand a narrow
> query into an implementation tour or search for extra topics to include.
>
> Lead with a concise answer and a few relevant file citations. For lookups, give the
> location and its role; for diagnoses, give the conclusion and the supporting trace;
> for explanations, start with the main mechanism and its important boundaries.
> Preserve necessary caveats and requested depth, but omit exhaustive inventories
> and repeated conclusions unless asked. Prefer prose or short lists to tables for
> long explanations, and avoid repeating a citation's filename outside its link
> label. When the task is complete, reply with a short summary and no tool calls.

Q1 was the broad correctness control; Q4 tested the incomplete lookup; Q6 tested
the overlong diagnosis. Same questions/model/effort/limits, no rerolls. All three
completed with facts/citations/scope 2/2/1, but all remained overlong:

| Probe / session | Requests / tool calls | Input (cached subset) | Output | Seconds | Words |
| --- | --- | --- | --- | --- | --- |
| Q1 / `18aa2910` | 7 / 19 | 113,685 (84,864) | 1,961 | 83.562 | 758 |
| Q4 / `171a616b` | 7 / 16 | 91,117 (65,152) | 1,523 | 76.961 | 443 |
| Q6 / `02503d40` | 6 / 12 | 63,713 (31,872) | 1,194 | 61.096 | 443 |

Q4 now answered; Q1 used more requests/input; Q1 and Q6 retained long implementation
tours. The independent checker recommended rejecting the candidate. Its assembled-
prompt assertions failed first, passed after the edit, and killed removal of the
new guidance and replacement of custom-system precedence. Build/typecheck and
3,784 tests passed on the experiment, but these establish wiring, **not model
judgment**. The candidate and its experimental assertions were removed from the
delivery diff. Production files are unchanged.

## Implementation control — incomplete, not a delivered fix

Session `858fbd48` ran in a separate worktree, seed commit
`3d791f12036a9088a2172c4f51adc2c166d31dd1` based on the same main revision. The seed
changed table exact-fit `> width` to `>= width`; main never had this regression.
The task explicitly forbade delegation, commits, PRs, documentation edits, existing
test edits and unrelated production changes. It requested fail-first reproduction,
a fix to `viewport.ts`, and a new `eval-table-boundary.test.ts` covering exact fit,
below-width fallback and complete contents. Limits: 12 turns, 180,000 configured
tokens, five minutes. Cwd writes and this literal command prefix were allowed:

```sh
pnpm exec vitest run packages/cli/test/readable-answer.test.ts packages/cli/test/eval-table-boundary.test.ts
```

The run used the same profile/model with `--trust`, isolated session/memory roots,
`--no-dream-on-end`, `--allow write` and the exact command's JSON argv in
`--allow-command`; headless ask-deny remained. A skill request was denied; later
diagnostics and the test command hit fresh `external-input-expansion` consent,
which standing command authorization does not override. No bypass was introduced.

AgentRig added a correct boundary test, accurately identified the faulty condition,
and reported that no tests ran. It left production unchanged because reproduction
was blocked. Its final engine reason was `done`, **not task success**. It used ten
root requests, eleven executed tool calls, two plan updates and three denials:
94,939 input (72,192 cached), 1,015 output, 78.633 seconds, 81 final words.
Automatic ingestion was deferred for span/call budget; no auxiliary usage was
reported. This is a constrained permission-path failure, not evidence that the
agent cannot fix this code or that the security gate should be weakened.

Operator controls, separately attributed: the original seven-test file passed
before seeding, then failed one test with the seed. After the agent stopped, both
the original test and its new test failed on the seed (two failures/six passes).
Temporarily correcting the comparison passed all eight; the operator then restored
the exact seeded tracked state. The original test retained SHA-256
`a95e6aaf57ae17d152d17232db75a49776f66d13124050844da44f7c41260f34`.
The only agent-created file was the new test. None of these fixture edits are
production changes or evidence of an agent-completed implementation.

## Receipts and disposition

All ten attempts consumed 802,165 reported root tokens including cached input and
output; the initial six accounted for 433,018. No dollar cost is inferred. Raw logs
remain untouched locally under `/var/tmp/agentrig-query-eval.DU0F37/`; only derived
non-sensitive summaries are committed. Public readers cannot independently rescore
the unpublished answers from the numeric summaries alone. The report records that
limit rather than presenting the quality judgments as a reproducible benchmark.

The bounded evaluation is complete, including its failed attempts. Consistent
brevity, evidence-based stopping, and a successful interactive implementation
control remain unproven, not additional completed features. No new implementation
queue or automatic continuation is created. Independent PR reviews and exact-head/
post-merge CI receipts belong on the delivery PR as each completes.
