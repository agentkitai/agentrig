# R17f results — measured defaults, verification pending

All 96 corrected matrix slots have outcomes across **two separately preserved segments**, not
one uninterrupted run: **67 PASS, 17 FAIL, 12 BLOCKED**. The unchanged primary comparison does
not demonstrate a benefit for either factor. This does not disprove their value.

The implementation decision is recommended `memoryIndexInjection: false`, while ingestion and
explicit retrieval remain on. Explicit config/profile `true` restores injection; direct SDK
construction with the option unspecified retains legacy injection. Free supervision heuristics
stay on; LLM review stays opt-in and automatic abort stays off. Security defaults do not move.
Implementation and evidence are being finalized in [PR #290](https://github.com/agentkitai/agentrig/pull/290);
final-head verification, merge and post-merge CI are pending. R17f is not marked delivered yet.

## Collection and accounting

Both corrected segments used frozen evaluator `4d41826a0ba064e67dead46125aa6a64e34426b6`,
Linux/Node v24.12.0, subscription-only `openai-chatgpt / gpt-5.6-luna`, medium reasoning.
No API-key fallback, new training/ingest, failed-slot retry or rubric adjustment occurred.

| Segment | Slots | UTC start → last provider settlement, 2026-09-09 | Reported tokens | Unknown calls | Owned exit |
|---|---|---|---:|---:|---:|
| Corrected first segment | 001–051 | 05:01:27.615 → 06:56:25.205 | 6,312,295 | 1 | 2 |
| Authorized continuation | 052–096 | 16:33:24.415 → 17:57:01.017 | 4,057,591 | 0 | 0 |
| Combined corrected observations | 96 | Interrupted chronology preserved | 10,369,886 | 1 | — |

The first segment stopped on incomplete provider usage after a generic terminated/error event;
the evidence does not establish its upstream cause. The operator failed to act on the halt for
about 9.5 hours. This was a monitoring failure, not productive benchmark execution. The user
had raised the corrected-run allowance from a fresh 12M to 20M reported tokens and then
explicitly authorized continuation of only unattempted slots. The continuation retained the same evaluator,
images, model, corpus, treatment and order. Earlier failures and the incomplete call were not retried.

There were 1,220 main calls: 1,219 complete and one incomplete. All 10,369,886 reported tokens
are main-call usage; no supervisor reviewer/grader calls occurred. Unknown consumption is not
zero, and the 1,178,000-token scheduling reserve is not measured usage or a billing guarantee.
USD remains unpriced/unknown. Session ends were 85 done, 10 budget and one error.

An **earlier protocol-invalid pilot** at `04072b1` is separate: two attempts started, one
finished; **306,143 reported tokens plus one unknown interrupted call**. Its missing original
test-filename instruction caused a hidden-rule rejection. The operator stopped and joined it
at exit143. No canonical final results/calls were fabricated; its interruption receipt and raw
partial evidence remain in the separate invalid-pilot archive. Those outcomes never enter the
corrected comparisons. Known reported consumption across pilot and corrected segments is
10,676,029, with two unknown calls; this is not a complete consumption total.

## Outcomes and fixed paired comparison

The full three-block balanced prefix is 96 slots; no unattempted or partial-block slots remain.
Each condition has 24 observations. Token and latency medians below include all outcomes;
latency is session plus joined observer settlement, excluding preparation/checking/capture.

| Supervisor | Memory | PASS / FAIL / BLOCKED | Median reported tokens | Median session seconds |
|---|---|---:|---:|---:|
| off | off | 17 / 4 / 3 | 88,574 | 96.804 |
| off | on | 17 / 4 / 3 | 93,271 | 90.820 |
| on | off | 16 / 5 / 3 | 78,792 | 89.294 |
| on | on | 17 / 4 / 3 | 84,266 | 86.949 |

Primary utility uses A1/A2/A3/X1/X2/X3, 18 matched task/repetition pairs per comparison.
Required: at least two additional passes, both median ratios ≤1.25, known independent
regression/scope lanes, no new failures on any task, and no unknown usage.

| Factor switched on | Other factor | Additional primary passes | Token ratio | Session-latency ratio | Threshold met |
|---|---|---:|---:|---:|---|
| Supervisor | memory off | −1 | 0.890 | 0.909 | no |
| Supervisor | memory on | 0 | 0.867 | 0.832 | no |
| Memory | supervisor off | 0 | 1.053 | 0.936 | no |
| Memory | supervisor on | +1 | 1.027 | 0.856 | no |

No pass delta reaches two. Independently, the inherited unknown call blocks a numerical win.
The scope failures leave five regression lanes BLOCKED (91 PASS), so all comparisons also
have `lanesKnown: false`; supervisor-on introduces new scope failures in both memory settings.
These are actual unchanged gates, not an assessment of human prose or statistical superiority.

Per-task variability: A1/A2/A3/X1 pass all 12 times each. X2 fails first-repeat plain,
memory-only and supervisor-only slots 021/022/024 for out-of-scope `eval-*.js` test files
instead of the disclosed `eval-test-*.js` pattern; its other nine attempts pass. X3 fails
supervisor-only/both third-repeat slots 091/092 for `eval-classify.js`; its other ten pass.
These five scope failures remain FAIL; downstream checks remain BLOCKED.

All 12 A4 attempts fail automatic behavior checks: five final-event contract mismatches,
four missing current-implementation citations, three missing answer.json files. The frozen
A4 output-contract ambiguity remains a limitation. All 12 X4 attempts remain BLOCKED on
their human-only prose gate. No human verdict or replacement AI judgment has been supplied.

## Mechanisms actually exercised

Recorded events contain 79 supervisor signals, 75 interventions and 75 outcome records;
these counts are not evidence that the interventions helped. The optional LLM rungs made
zero calls, so this run provides no measured benefit for enabling them by default.
There were five `memory_search` calls and no `memory_read` calls. Memory-on included the frozen
index and retrieval tools together; this is not an isolated injection-versus-retrieval test.
Permission receipts record 1,006 actual approval prompts and 119 grants under the frozen
scoped-grant-or-allow-once policy, not blanket allow. Raw permission-request events are not
the prompt count because covered requests do not all reach the approval controller.

## Evidence and limits

- [Derived aggregate and continuation provenance](r17f-evidence/aggregate-summary.json),
  [publication/hash receipt](r17f-evidence/publication.json).
- [Segment 1 archive](r17f-evidence/segment-1/evidence.json.gz) and
  [index](r17f-evidence/segment-1/index.json): 1,712 files, 7,766,580 archive bytes,
  SHA-256 `4ff8b680b149f2581413b3933a54a81ec50a52ab8f8ce85b9362e6eb993b4029`.
- [Segment 2 archive](r17f-evidence/segment-2/evidence.json.gz) and
  [index](r17f-evidence/segment-2/index.json): 1,472 files, 5,743,750 archive bytes,
  SHA-256 `dcc6398d0267f29b2224775a0f1b834eb0de0e06902551c43cf2a65fd0d75e9f`.
- [Invalid pilot archive](r17f-evidence/invalid-pilot/evidence.json.gz) and
  [index](r17f-evidence/invalid-pilot/index.json): 52 files, 311,949 archive bytes,
  SHA-256 `a3d2bbaea15a491bbad639b409569d00d676d489ef438482237a4011b3915ce8`.

Archive/index hashes and every included file were checked against closed originals. Separate
raw segment results remain authoritative; aggregate analysis does not fabricate a canonical
runner results.json. The compatible packer's per-segment summaries/answer-packet headings still
use E3 terminology; they are not the combined R17f primary analysis.
A precautionary scan of 3,245 decoded/generated files found no matches to private-key,
provider-key, Bearer-token or JWT patterns. This is not proof that arbitrary text cannot contain
sensitive information. Workspaces, dependencies and mutable snapshots are excluded.

Both protocols pin worker `sha256:c995261c83a33afebec75396ee4ac9260cc224d16bf2da11d9b2c41e0d2f05d8`,
checker `sha256:33443f68f312abe4f1e88e16be7c88407d7173e80d7e55dfb0a12a5541e733e5`, and
corpus `cd10a022f0114f75726f7d6024324ad92d4646a94d608af0fd2f9113e256b2a1`.
Current checker attestations differ from original E3; task behavior checks were not retuned.
The public synthetic tasks, three repetitions, original X4 training overlap and interruption
limit generalization. Supervisor-on combines heuristics with optional LLM rungs, not an isolated
comparison with heuristics-only. The minimal shell evaluator does not install diagnostic,
checkpoint or session-end ingestion hooks and is not an interactive TUI usability comparison.

Builder: **Claude/operator outside AgentRig**; no conductor session or dogfood success is
claimed. The benchmark itself used zero children. Builder/reviewer identities and bounded
verification are in [the review record](reviews/R17f-PREPARATION.md). R17g follows delivery;
these results do not create another benchmark or review loop.
