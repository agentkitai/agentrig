For every adapter launch, export `AGENTRIG_REVIEW_REPOSITORY=OWNER/REPO`,
`AGENTRIG_REVIEW_PR=NN` and `AGENTRIG_REVIEW_PASS=PASS`. The adapter stores durable
output/receipt pairs under `$HOME/.agentrig/review-evidence/OWNER/REPO/NN/PASS/ATTEMPT/`,
never under review scratch. Follow docs/SHIPPING-WORKFLOW.md **Durable review evidence
(#547)**: save the stdout manifest in the PR, validate it with
`node scripts/review-provenance.mjs` before scratch cleanup and again before landing,
and never delete durable pairs during cleanup. Missing or tampered evidence refuses.
