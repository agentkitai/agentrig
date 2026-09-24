Retain the adapter-written durable `provenance.json` and adjacent `review.md`, bound to
repository/PR/pass, reviewed head, slot, configured model, assertedModel, verdict, and successful
exit. The posting helper attaches the adapter manifest (receipt/output locators and receipt SHA-256)
to the posted review automatically; land consumes that attachment, not a manual PR-body copy. The scratch `<PREFIX>.provenance.json` is only a posting-compatible copy. Posting
uses `--provenance <PREFIX>.provenance.json`; land retrieves the durable trusted receipt, not a
reviewer-authored replacement, and passes its local path as `TRUSTED_ADAPTER_RECEIPT` to
`--validate FILE REVIEWED_HEAD SLOT MODEL TRUSTED_ADAPTER_RECEIPT`. Validate the reassembled
canonical body when split comments are used. Missing or mismatched provenance halts: recover
the original adapter artifact or rerun the adapter, never fill transportModel from configuration.
