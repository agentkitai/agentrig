# E3 collection notes — observations, not changes to the preregistration

Frozen runner: `5d990d6e8c764ad2b645ec6574b7bf26ec3ae6c6`.
The live runner and E1 checks stay unchanged while collection runs. Publication helpers added
later only package/validate existing evidence; they do not rerun tasks or change outcomes.

## Training task-description overlap

Training session `82a20bc2-f553-4f7a-8272-5ca01b2e5553`, tool call seq 117 / result seq 118,
read `git diff -- TASK.md`. The training exporter reused the X4 pinned input and replaced TASK.md
without replacing its local Git baseline. That diff exposed the original X4 **task description**
(requested answer fields and example inputs) alongside the training task. It did not contain
a held-out solution, a held-out run/result, or independent checker assertions. The training
agent had already run its own examples before that read. Ingest consumed the real training
trace, including this overlap; the corpus was not edited to remove it afterward.

This weakens task-description separation, and the evaluation must not be called a pristine
held-out benchmark. X4 memory-on behavior can be primed by the overlapping task description as
well as the deliberately shared training investigation. Do not interpret X4 alone as evidence
of general stale-memory resistance or a clean generalization advantage. The original EVALSET
already declares public-source contamination, tiny external-task scope and closely related
training/held-out knowledge. All results and this additional limitation will be retained.

For a future eval-set revision, export a training-only baseline with its actual training task
already committed, leaving no held-out task metadata in its Git history. This is recorded at
the roadmap's end, not a recursive E3 milestone or a retroactive change to this run's checks.

## A4 output-contract ambiguity

The first A4 answers interpreted `finalEvent` as the final **auxiliary** record (`auxiliary.usage`
with `final: true`), while E1's checker requires the terminal **session-log** event (`session.end`).
The short task prompt calls it only `finalEvent (string)`. Preserve the exact automatic FAIL:
do not repair a model's answer or relax the assertion after seeing it. But do not equate this
literal mismatch with proof that the explanation misunderstands session-log closure. The raw
prose, independent regression/scope lanes and budget termination remain separate evidence.

A future task revision should disambiguate that field and publish the checker's permitted
evidence-file paths and path-versus-line-number convention in the prompt. This run uses the
unchanged v1 contract and must disclose its limits rather than claim broad reasoning accuracy.
