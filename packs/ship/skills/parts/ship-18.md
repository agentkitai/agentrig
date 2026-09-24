### Durable review evidence (#547)

Before every positional adapter launch, export `AGENTRIG_REVIEW_REPOSITORY=OWNER/REPO`,
`AGENTRIG_REVIEW_PR=NN` and `AGENTRIG_REVIEW_PASS=PASS` (a unique initial or focused
pass name). Missing/invalid identity refuses launch. The adapter itself writes both
`review.md` and `provenance.json` under
`$HOME/.agentrig/review-evidence/OWNER/REPO/NN/PASS/ATTEMPT/`, using exclusive files
and a unique attempt id. Its stdout JSON supplies `receipt`, `output`, and `sha256`
(the receipt digest); the receipt binds the output digest and pass identity as well
as the head/slot/model/adapter/verdict. Record this manifest verbatim in the PR
handoff for every successful slot and pass, not just a prose model claim. OUT's
`<PREFIX>.provenance.json` is only a posting-compatible scratch copy, not the durable
artifact. The durable evidence directory is outside OUT, reviewer temporary roots,
proof TMPDIR and worktrees: never include it in scratch cleanup. Retain superseded
passes too. If HOME places it inside any cleanup root, halt before launch and fix
that environment; do not relocate evidence into temporary storage.

Before deleting scratch, validate each saved manifest with the command below and
read back the PR handoff. Land, including a separate later session, retrieves the
manifest from that handoff and runs this same gate BEFORE comment validation:

```sh
node scripts/review-provenance.mjs "$RECEIPT" "$RECEIPT_SHA256" "$REPOSITORY" "$PR" "$PASS" "$REVIEWED_HEAD" "$SLOT" "$MODEL" "$ADAPTER"
```

A missing receipt/output, digest mismatch, or identity/verdict binding mismatch
halts. Use the original durable receipt as `TRUSTED_ADAPTER_RECEIPT` for the existing
`review-finding-index.mjs --validate` gate on the live (reassembled if chunked)
comment; the durable gate does not replace live-comment checks. Never regenerate
provenance from prose/configuration. If landing on another host, transfer the exact
receipt and adjacent `review.md`, retaining the PR-persisted digest and identity;
if unavailable, recover original artifacts or rerun review. Scratch cleanup never
deletes these durable artifacts and cannot be used to waive the land gate.
