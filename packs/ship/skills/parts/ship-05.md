For CLI receipts with a resolved home, include transport model and JSON-quoted resolved home
in this heading, never only in the body. Historical receipts and transports without a CLI home
use the same heading without the transport/home suffix. Require the suffix for new CLI receipts. Missing reviewer homes or
invalid profiles are pre-launch configuration refusals (exit 64), not retry-consuming exit 2.
A reviewer schema-shape rejection where all required finding fields validate is a reviewer-protocol retry and does not consume the slot's single reviewer retry.
Substitute the slot name, transport-proven pinned model, full reviewed PR head SHA and full origin/main SHA. Preserve the honest assertedModel separately.
The initial heading model must equal the slot's pinned model. A different model makes this a
missing required initial review, not a receipt. Require the complete heading, not just a prefix
or SHA in the body. Post with `scripts/post-review-comment.mjs` using the slot name and the
reviewed config path; never compose an alternate heading inline. Persist per-adapter provenance
(launch/provider entry, model assertion source, start/end, exit, head/main and worktree) with the verdict.
Never infer the asserted model from reviewer prose. Truncation, failed runs, ambiguous assertion,
empty output or pin mismatch are not completed reviews. Retry once with fresh artifacts, then halt.
