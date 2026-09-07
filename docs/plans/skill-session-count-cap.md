# Generated skill session-count boundary

Close only the R6b END serializer-count fragment. Before serializing metadata,
reject more than 128 distinct publication session references, after deduplication.
Keep the 8192-character metadata cap, file/header byte caps, deterministic sorting,
evidence and effect approval, exact digest confirmation and create-only/guarded
replacement behavior unchanged. Remaining recovery/model-rejection diagnostics stay queued.

This is a defensive format invariant, not a newly demonstrated publication bypass:
the ordinary evidence loader already defaults to 128 validated sessions. The core
skill parser independently caps the metadata array at 128. The pure serializer is
named/exported only from its internal module for direct boundary controls, not the
package entry point; calling it does not validate evidence, write files or authorize
publication. Normal emission still uses fresh runtime-backed candidates and gates.

A real structural dream supplies the boundary fixture's candidate. Synthetic copies
of its publicationSources exercise 128 distinct references (duplicated input accepted,
sorted/deduplicated output accepted by the actual core parser) and 129 short references
that fit below the character cap. The 129 control failed before the guard; no file is
published by these pure controls. Existing actual dream/CLI apply and refusal controls
remain required. No live provider calls, new format version, activation or authority.

Verification: build/typecheck, focused serializer/dream/CLI/parser tests, full required
pinned-Docker suite, Chromium, one bounded Claude review, exact-head CI and serialized
merge/post-main gates. Final hosted receipts live on the implementation PR.
