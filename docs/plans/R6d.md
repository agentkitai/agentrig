# R6d — memory write-quality lint

Fresh branch from updated main `412a9af` after H6 PR #138 exact-head CI 34011748505 and post-merge
CI 34011951160 passed all three platforms. R6d only; R6e remains next. Generated skills remain
conditional on benefit evidence, not automatically activated by completing this hardening row.

Existing ingest already validates stated/observed/inferred tags on distilled facts. Preserve
that format; fix new model-written source summaries incorrectly labeled observed by writing
explicit inferred model synthesis. Existing historical pages/raw logs are never relabeled or
rewritten. Tags are model-proposed provenance categories, not runtime semantic proof.

Add model-free advisory findings to structural lint and dream reports: inferred prose without
uncertainty, ephemeral status outside source history, exact repeated claims excluding citation
groups, observed universal claims with at most one cited session, and facts whose explicit
leading subject link names another unambiguous existing page. Missing-tag bullets are also
reported for inspection. No automatic deletion, merge, move, provenance assignment or promotion.

Limits: English text-shape heuristics are not semantic verification. Routing requires an explicit
subject link; prose-only/ambiguous subjects are not guessed. Source history intentionally retains
status and repeated narrative. Citation counts are not proof of independent observations; H4's
promotion evidence gate remains unchanged. Reuse existing bounded scans and cancellation.

Acceptance: positive/negative controls for every category, fenced/code/quoted text exclusions,
legacy report compatibility, actual ingest tag round-trip and raw immutability, model-free dream
and CLI reporting/count/exit behavior. Mutation must fail a named integration test. Build/typecheck,
full regression, one bounded independent review and exact-head/post-merge CI precede R6e.

## Validation receipt

Build/typecheck and full Node22 suite: 1,945 passed, two skipped, 94 files. One bounded independent
Claude review `e8c67340-87c2-4808-8cfd-c22a9b4d6f47` approved with no material findings and
independently passed build/typecheck plus the same full suite. A summary/source-fact dedup
regression caught during implementation was repaired without weakening its existing assertion.
Suppressing write-quality integration fails the actual CLI lint exit/report test; relabeling
summary synthesis observed fails the ingest round-trip test. Both mutations restored.

Legacy source regrowth may append an inferred summary beside an older observed summary; old
history is retained, not silently relabeled. Nested hand-written bullets may need human judgment
on missing tags. These optional refinements are at ROADMAP's end, not new prerequisites.
Exact-head and post-merge main CI remain required.
