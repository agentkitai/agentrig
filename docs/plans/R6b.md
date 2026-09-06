# R6b — explicitly reviewed skill emission

R6b follows merged R6a/R5e and the delivered H4/R6e gates. It is independent of runtime
permission/activation work: this row emits files only, never R6c automatic activation. The
user's committed-vision sequencing applies; no live evaluation spending or benefit claim.

## Review and apply

```sh
agentrig dream --emit-skills --structural-only
# Read every printed proposed file and its canonical destination; copy the printed digest.
agentrig dream --emit-skills --apply <review-digest> --dream-limits '{"maxCalls":3}'
```

Both commands use the selected `--dir` memory directory (default `.agentrig`). `--global`
does not redirect skill output. `--emit-skills` alone previews; ordinary dream, `--auto`, and
`--skill-candidates` never emit. Skill `--apply` requires explicit opt-in and a 64-character
digest; it cannot combine with `--review`, `--auto` or `--structural-only`. Applying skills
does not apply the dreamt wiki. Explicit model preview is also available by omitting
`--structural-only`; all calls use the normal provider selection and shared dream limits.

SDK: `runDream({ ..., emitSkills: { root: '<memory-dir>/skills/generated', apply?: digest } })`.
The result's `skillEmission` contains exact proposals, digest, preview/applied/refused status,
written paths and preserved destinations. The root must be the selected wiki's sibling
`skills/generated`; this is not a generic arbitrary-path writer. A chosen existing memory-root
alias is canonicalized, while symlinks in its skills/generated subtree are refused.

The digest confirms human review, not machine authority. It binds body, name, canonical
destination, source sessions/page and exact runtime witness hash. Only the fresh run identifier
and derived ownership checksum are excluded. Any changed behavior/evidence/destination requires
a new review. Each apply rebuilds candidates from final dream pages and freshly loaded H4 raw
evidence, classifies the complete procedure and obtains an opaque exact-artifact R6e receipt.
Saved JSON reports, copied receipts and status strings are never accepted as authorization.
Uncertain/adverse effects, malformed refinement, missing provider or insufficient budget refuse
emission. The default two-call cap is unchanged; explicitly budget three for consolidation,
classification and effects, or four with global promotion. Structural previews make zero calls.

## Artifact and bounded format

Files are `<memory-dir>/skills/generated/<name>/SKILL.md`. Names are deterministic from the
source page, 1–64 lowercase alphanumeric/hyphen characters, with no doubled/edge hyphens;
the name matches its directory. Body contains only the existing gate's exact supported claims
and references; description uses supported scope claims, not invented applicability.

The emitted YAML subset conforms to the [Agent Skills specification](https://agentskills.io/specification):
required name/description and optional string-to-string `metadata`. Metadata keys are
`agentrig-schema: "1"`, `agentrig-generated: "true"`, `agentrig-sessions` (JSON array string),
`agentrig-page`, `agentrig-dream`, `agentrig-evidence` (witness SHA-256), `agentrig-content`
(ownership checksum), and `locked: "false"`. To lock a generated skill, set **metadata**
`locked: "true"`. Bare YAML booleans and top-level `locked` remain unsupported/fail closed.
Any ordinary byte edit also protects the file, without requiring a lock or checksum update.

Core's explicit versioned extension accepts two-space nested JSON-quoted metadata strings,
not arbitrary YAML. Unknown/security fields, duplicate keys, wrong types/versions, aliases,
extra collections and `allowed-tools` remain refused. Legacy flat/plain Markdown compatibility
is retained. Generated frontmatter is bounded to 64 lines/16 KiB, emitted files to 64 KiB; inherited
16-candidate/128-claim and raw/wiki scan caps remain. Memory does not import core runtime;
actual CLI/core-parser roundtrip tests guard the independent serializer's contract. Future
R6g metadata requires an explicit versioned compatibility change, not accidental acceptance.

## Regeneration and limits

Under the existing cooperative memory lock, new files use exclusive creation. Existing files
must match the generated format/source/name, be unlocked, and have an intact whole-file ownership
checksum. Unknown occupied directories, edited/locked/malformed files, links and nonregular
targets are preserved with per-file reasons. Replacement stages a bounded temporary file and
rechecks bytes/ownership and subtree paths immediately before rename. It never unlinks an old
target to make replacement succeed. Existing unrelated assets are not touched.

The checksum detects ordinary edits; it is not a cryptographic signature or sandbox against
hostile writers who recalculate it. Cooperative locks cannot make concurrent human/external
writes transaction-safe: the last-check/rename race remains. Stop external editing while
applying. Per-file commits are not a batch transaction; refusal/cancellation/I/O failure may
follow earlier writes, and there is no rollback or force-overwrite mode. Actual paths/outcomes
are reported when returned; maintenance failure accounting remains conservative. No raw or
wiki content is overwritten; the existing dream scheduling stamp update still occurs.

The generated directory is deliberately not discovered by the existing one-level project
skill scan. R6c activation is separate. A human explicitly adding it as a discovery root is
an existing manual configuration choice, not an approval inferred from metadata.

## Delivery gates

Network-free actual dream and actual CLI preview/apply/parser roundtrip; fresh unsafe/malformed/
unassessed/capped evidence rejection; independent versus single/fork/copied observations;
locked/edited/foreign/nonregular/link preservation; canonical-root alias and subtree escapes;
unchanged input bytes, cancellation and scan caps. Full build/typecheck/test, detected/restored
named negative mutations, one bounded independent Claude review, exact-head three-platform CI
and root-coordinated merge/post-merge gates. Exact receipts will be recorded in the closing PR.
