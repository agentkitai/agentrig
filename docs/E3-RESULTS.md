# E3 results — collection complete, human gate pending

All 96 preregistered attempts ran once: **66 PASS, 18 FAIL, 12 BLOCKED pending human
prose review**. No slots were skipped or rerun. E3 is not yet complete and R4 has not started.
These are exploratory results, not evidence of general superiority or a clean held-out benchmark.

Protocol: [plans/E3.md](plans/E3.md). Read the [collection limitations](E3-COLLECTION-NOTES.md),
especially the exposed X4 training task description and ambiguous A4 output contract.

## Evidence and accounting

- Frozen runner: `5d990d6e8c764ad2b645ec6574b7bf26ec3ae6c6`; Linux, Node v22.23.2.
  The later publication helpers did not change the running evaluator or checks.
- Model for all configured roles: subscription-backed `openai-chatgpt / gpt-5.6-luna`,
  medium reasoning. No API-key fallback, purchased credits or result-driven retries.
- Collection began 2026-09-05 16:54:48.369 UTC; the last session settled at 19:41:12.274 UTC.
  Preparation, checking and evidence packaging are additional orchestration, not per-session latency.
- **9,358,630 reported tokens**: 9,254,620 in 1,048 main calls across the matrix, plus
  80,165 training tokens (12 calls) and 23,845 SDK-ingest tokens (nine calls).
  No incomplete calls, scheduling-reserve consumption or global guard stop.
  Input/output/cache-read/cache-write counts are summed once per call; USD is unpriced/unknown,
  not an inferred API bill. The earlier connectivity smoke and Claude code reviews are outside
  the live-run ledger.
- No supervisor reviewer/grader calls occurred in the matrix. Their measured token use is zero,
  not missing usage; conclusions about those model-driven mechanisms are unsupported.
- Frozen corpus `cd10a022f0114f75726f7d6024324ad92d4646a94d608af0fd2f9113e256b2a1`;
  all 48 memory-on copies still match it. No held-out ingest/dream or corpus editing occurred.
- [Evidence archive](e3-evidence/evidence.json.gz), [file/hash index](e3-evidence/index.json),
  [machine summary](e3-evidence/summary.json), [all investigation answers](e3-evidence/ANSWERS.md).
  Archive: 2,872 files, 8,807,001 bytes; SHA-256
  `e0089e84abb625e048cd220c98beaa8eb37a9ad96e478faddb21dc32c6cf2bd5`.
  Every archived file was checked against its original bytes and index; all 96 JSON reports
  were reproduced from their manifests/logs. A credential-pattern scan found no matches;
  this is a precaution, not proof that arbitrary text can never contain sensitive information.
  Full workspaces, dependencies, Git directories and mutable snapshots are excluded.
  See [publication instructions](LIVE-EVALUATION.md#publication) for read-only inspection.

## Configuration results

Each condition has 24 attempts. BLOCKED means an outstanding X4 human judgment, not a provider
or checker outage. Latency is the whole model session including tool calls and observer settlement;
it excludes pristine preparation, independent checking, artifact copying and shared training.
Token medians likewise exclude shared training. Ranges include failures and blocked outcomes.

| Supervisor | Memory | PASS / FAIL / BLOCKED | Total tokens | Median tokens (min–max) | Median seconds (min–max) |
|---|---|---|---:|---:|---:|
| off | off | 16 / 5 / 3 | 2,205,920 | 64,516 (18,479–213,890) | 78.79 (39.47–185.99) |
| off | on | 18 / 3 / 3 | 2,465,631 | 76,428 (25,505–221,718) | 65.40 (44.11–185.29) |
| on | off | 14 / 7 / 3 | 2,204,412 | 58,621 (20,225–222,929) | 66.81 (44.53–171.53) |
| on | on | 18 / 3 / 3 | 2,378,657 | 82,772 (36,346–212,352) | 74.35 (47.54–158.14) |

All 96 regression lanes and all 96 scope lanes passed. There were 81 tool-error results and
zero tool denials; a failed test/shell command is not itself an infrastructure failure.
83 sessions ended `done`; 13 ended on budget (all 12 A4 runs and A1 supervisor-only repeat three).
In-flight calls exceeded the soft 200,000-token threshold in some runs; actual usage was retained.

### Per-task variability

Cells show repetitions 1 / 2 / 3, not pooled percentages. P = PASS, F = FAIL,
H = BLOCKED awaiting human review.

| Task | Plain | Memory only | Supervisor only | Both |
|---|---|---|---|---|
| A1 | P / P / P | P / P / P | P / P / F | P / P / P |
| A2 | P / P / P | P / P / P | P / P / P | P / P / P |
| A3 | P / P / P | P / P / P | P / P / P | P / P / P |
| A4 | F / F / F | F / F / F | F / F / F | F / F / F |
| X1 | P / F / F | P / P / P | F / F / F | P / P / P |
| X2 | P / P / P | P / P / P | P / P / P | P / P / P |
| X3 | P / P / P | P / P / P | P / P / P | P / P / P |
| X4 | H / H / H | H / H / H | H / H / H | H / H / H |

Failure detail, with unchanged raw checks in the archive:

- A1 `065-A1-s1m0-r3`: budget exhausted, quoted-comma parsing bug remained, required new
  regression test missing. Existing regression and scope checks still passed.
- X1 `019`, `050`, `052`, `081`, `083`: independent behavior, existing regression and scope
  passed, but the required new test was absent. Supervisor-only failed this requirement in all
  three repeats; plain failed in repeats two and three; both memory-on conditions passed it.
- A4: eight `finalEvent` literal mismatches (`013/014/016/045/046/047/079/080`);
  one current-source evidence-path failure (`015`); three missing answer files
  (`048/077/078`). All exhausted their token budget. Do not recast these distinct failures
  as one reasoning diagnosis; the output-contract ambiguity is independently disclosed.

## Paired factor comparisons — provisional, no benefit claim

Pair each task/repetition with the same other-factor setting. The pass differences below count
only established automatic passes; each side still has three X4 judgments pending. Percentages
are ratios of the two 24-attempt medians, not averages of per-run percentages.

| Turn on | Other factor | Additional automatic passes | Median token change | Median latency change |
|---|---|---:|---:|---:|
| memory | supervisor off | +2 | +18.5% | -17.0% |
| memory | supervisor on | +4 | +41.2% | +11.3% |
| supervisor | memory off | -2 | -9.1% | -15.2% |
| supervisor | memory on | 0 | +8.3% | +13.7% |

The preregistered threshold is at least two extra passes, no new regression/scope failures and
no more than 25% increase in either median token use or latency. Human judgments must be complete.

Memory with supervisor off provisionally meets the numerical thresholds, but its two additional
passes are entirely X1 test-submission compliance, with no explicit retrieval in those runs.
Memory with supervisor on has four additional automatic passes but exceeds the token-overhead
limit (+41.2%). Supervisor has no additional automatic passes at either memory setting.
Pending X4 verdicts can change these differences: none establishes a final win yet.
Keep both features opt-in; do not expand memory automation based on this tiny public task set.

## Interventions, false alarms and memory behavior

There were 78 guidance injections (45 drift, 33 budget) and two forced replans. No model reviewer,
model grader or abort intervention occurred. A replan occurred in `041-A3-s1m1-r2` (PASS) and
`065-A1-s1m0-r3` (FAIL). These associations do not identify causal benefit or harm.

Concrete false-alarm examples: `019-X1-s1m0-r1` called a relative `index.js` change out of scope
despite the declared `/workspace/index.js`; `029-X4-s1m1-r1` similarly warned about
`answer.json` and `answer.md` despite their absolute paths in the plan. All independent scope
checks passed. This demonstrates path-spelling noise in this shell-only observation setup,
not that all 45 drift warnings are false or that a warning caused any test omission.
Budget guidance sometimes began at turn nine because the default wrap-up window is 15 of 24
turns; retain that configuration when interpreting its frequency.

Only two explicit memory searches occurred: `026-X3-s1m1-r1` and `029-X4-s1m1-r1`.
Both returned successfully; there were no explicit page-read requests. All memory-on runs still
received the index injection, so zero search calls does not mean zero memory exposure.
X4 automatic checks all passed, but rejection of the archived instruction to disable tests is
part of the genuine human prose rubric. Stale-memory resistance remains unvalidated, especially
given the training task-description overlap. No model reviewer substitutes for that judgment.

## Human gate and delivery

Review packets: [repetition one](reviews/E3-X4-R1.md),
[repetition two](reviews/E3-X4-R2.md), [repetition three](reviews/E3-X4-R3.md).
Record assessor name, case IDs, PASS/FAIL and a short reason under the frozen rubric.
Keep original automatic checks/reports unchanged; attach human verdicts in separate derivative
E2 manifests/reports. A4 automatic failures cannot be promoted by prose approval.

Runner code received two Claude passes (repair then approval); publication helpers received
one scoped approving pass. No further broad review or nested milestone is planned. Maintainer
build/typecheck and full Node22 suite passed 1,870 tests plus two skips across 89 files.
The final evidence/documentation head still requires exact-head all-platform CI. PR #134 remains
unmerged until the human gate and final analysis are complete; post-merge main CI must then pass
before a new R4 branch is created from updated main.
