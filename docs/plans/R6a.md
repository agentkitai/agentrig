# R6a — evidence-backed procedure candidates

R6a is pulled forward independently after H3–H5/R6d–R6f and R5e (PR #142, main `26e78ec`)
completed. Those supply bounded maintenance, runtime claim evidence, effect review and manifest
boundaries. Detection is report-only and does not depend on unfinished scoped permission grants
or content provenance UI. This parallel sequencing follows the user's committed-vision direction;
R6b/R6c still wait for R6a. No live evaluation spend or benefit claim is authorized by this work.

## Surface and conservative input format

SDK `runDream({ procedureCandidates: true })`; CLI `agentrig dream --skill-candidates`.
The default remains off. `--structural-only` is zero-call, without credentials. Initial detection
supports a single complete procedure page; identical complete procedures on multiple pages are
deduplicated. It does not synthesize cross-page missing steps or infer missing constraints.

Use only tagged fact lines with these literal prefixes, backed by actual immutable observations:

```markdown
- [observed] Scope: Local release validation only (session:s1, session:s2)
- [observed] Step 1: Inspect the changed files (session:s1, session:s2)
- [observed] Step 2: Run the applicable tests (session:s1, session:s2)
- [observed] Step 3: Request review of the tested revision (session:s1, session:s2)
- [observed] Limitation: Not a substitute for deployment approval (session:s1, session:s2)
```

The references are examples, not evidence. Never invent a scope/limitation or relabel a guess
to satisfy this shape. Other wiki prose remains valid but is not eligible for this conservative
first detector. The shape is also documented in the generated wiki SCHEMA; existing human-edited
SCHEMA files are not overwritten. Detection accepts 3–16 consecutive ordered steps, 1–4 scope
claims and 1–4 limitations, with no uncategorized claims/prose. Every field passes H4 exact-line,
runtime-loaded claim evidence. The same two independent lineage families must support every
field; copied payloads, missing/fabricated logs, self-authored tool inputs and dependent forks
cannot establish eligibility. Existing H4 limits apply: textual observation is not proof that a
procedure executed successfully, is true, generalizes or helps. Confidence remains advisory.

## Model refinement, effects and budgets

The structural detector runs on final dream pages, after existing consolidation. Classification
can only mark entire candidates repeatable/non-repeatable; indices must cover the batch exactly
once. No model-provided replacement prose, steps, sources or constraints is accepted. Uncertain
repeatability is rejected. Remaining complete artifacts pass the existing R6e six-effect gate;
any adverse/unknown effect refuses the whole candidate without a softer replacement.

All calls share the existing maintenance deadline, cancellation, per-call/input/output/event and
accounting limits. The default call cap is **not raised**. For model refinement without global
promotion, explicitly budget consolidation + classification + effects:

```sh
agentrig dream --skill-candidates --structural-only
agentrig dream --skill-candidates --dream-limits '{"maxCalls":3}'
```

Existing global promotion can use one further call; cap four permits both workflows. A smaller
cap, malformed model reply or call timeout retains only unchanged structural/unassessed
candidates, with an explicit `refinementError`; already rejected candidates stay rejected.
Cancellation/whole-run deadlines abort and clean up as before. Ordinary/default dreams add no
calls. Incomplete raw scans or failed consolidation disable refinement. Structural batches cap
at 16 distinct candidates/128 total claims; over-limit batches fail whole, never truncate a
procedure. Files, pages and raw log reads retain existing scan caps.

## Report and authority

`report.procedures` is optional for backward compatibility. It contains `candidates`, `rejected`
and optional `refinementError`. Each `kind: skill-candidate` has pages, witnessed steps/scope/
limitations, its checked publication artifact and a status: `structural-unassessed` or
`model-and-effect-reviewed`. Renderer shows the exact claims and located/hash-backed witnesses.
The latter status is a fallible model assessment, **not emission approval**. Serialized reports
carry no durable authorization. R6b must reload evidence and recheck the fresh exact artifact
and effects before its separate human-reviewed emission gate.

No SKILL files are emitted, skills loaded, permissions granted, global wiki written or raw
history changed. Wiki content remains immutable; the pre-existing scheduling `.last-dream`
metadata update still occurs. This row does not claim generated skills improve real outcomes.

## Delivery checks

Network-free real dream fixture: two independent logs containing a three-step procedure yield
exactly one candidate; single-session/fork/copied/fabricated support yields none. Malformed model
refinements cannot smuggle prose; scope/limitations cannot be omitted. Coverage includes the
real CLI opt-in, unchanged source bytes, independent effect refusal, unchanged call ceilings,
batch caps, uncooperative timeout and cancellation/accounting. Full build/typecheck/test, named
detected/restored mutations, one bounded independent review, exact-head three-platform CI and
root-coordinated merge/post-merge CI are required. Closing PR records exact receipts.

Independent review `b71374d1-cfb4-45f2-b9aa-f219fa707721` approved implementation head `ca1043b`
with no material findings, independently passing build/typecheck, 2,013 tests plus two skips
and 20 focused cases. Strict-classification and adverse-effect bypass mutations were detected
and restored. Main integration retains all independent R13f changes, followed by final tests.
