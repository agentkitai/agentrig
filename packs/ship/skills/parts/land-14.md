### Durable review evidence (#547)

Before every positional adapter launch, export `AGENTRIG_REVIEW_REPOSITORY=OWNER/REPO`,
`AGENTRIG_REVIEW_PR=NN` and `AGENTRIG_REVIEW_PASS=PASS` (a unique initial or focused
pass name). Missing/invalid identity refuses launch. The adapter itself writes both
`review.md` and `provenance.json` under
`$HOME/.agentrig/review-evidence/OWNER/REPO/NN/PASS/ATTEMPT/`, using exclusive files
and a unique attempt id. Its stdout JSON supplies `receipt`, `output`, and `sha256`
(the receipt digest); the receipt binds the output digest and pass identity as well
as the head/slot/model/adapter/verdict. The posting helper automatically reads `<PREFIX>.durable.json`, validates its
receipt/output digest and repository/PR/pass/head/slot/model/adapter bindings, and
attaches the adapter manifest to the schema-bearing posted comment in an
`agentrig-review-evidence:v1` block. Keep the launch identity exports set during
posting. Do not manually copy manifests into the PR body: retain the posted review
URL in the append-only ledger for every successful slot and pass. OUT's
`<PREFIX>.provenance.json` is only a posting-compatible scratch copy, not the durable
artifact. The durable evidence directory is outside OUT, reviewer temporary roots,
proof TMPDIR and worktrees: never include it in scratch cleanup. Retain superseded
passes too. If HOME places it inside any cleanup root, halt before launch and fix
that environment; do not relocate evidence into temporary storage.

Before deleting scratch, fetch the posted review comment and validate its attached
manifest with the command below. Land, including a separate later session, consumes
the attached manifest from the live (reassembled if chunked) comment, never a manually
transcribed PR-body locator. It runs this gate BEFORE the existing comment validation:

```sh
node scripts/review-provenance.mjs --comment "$LIVE_REVIEW_FILE" "$REPOSITORY" "$PR" "$PASS" "$REVIEWED_HEAD" "$SLOT" "$MODEL" "$ADAPTER"
```

A missing receipt/output, digest mismatch, or identity/verdict binding mismatch
halts. This also compares the live structured verdict with the durable output. Use
the returned manifest receipt as `TRUSTED_ADAPTER_RECEIPT` for the existing
`review-finding-index.mjs --validate` gate on the live (reassembled if chunked)
comment; the durable gate does not replace live-comment checks. Never regenerate
provenance from prose/configuration. If landing on another host, transfer the exact
receipt and adjacent `review.md`, retaining the comment-attached digest and identity;
if unavailable, recover original artifacts or rerun review. Scratch cleanup never
deletes these durable artifacts and cannot be used to waive the land gate.
