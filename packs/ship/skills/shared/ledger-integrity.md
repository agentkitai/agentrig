
### Mechanical PR-body ledger integrity (#571)

The pre-tool ship hook guards `gh pr edit --body` / `--body-file` and `gh api`
pull PATCH body writes. The entire existing PR body is an append-only ledger:
the hook requires every existing byte, including prior findings, resolutions, coverage and
counters. Corrections are appended, not history rewrites. A fresh
empty body may be populated. The guard fetches the live body and validates cited
issue-comment, inline-review-comment and review URLs against fetched comment IDs
and exact `html_url` values. Missing comments, wrong anchors, malformed responses
and fetch timeouts deny before the write. Use one literal gh command, an explicit PR
number/URL, and a regular body file (not stdin); shell interpolation/operators are
not verifiable and must not wrap a body mutation. This pre-tool guard is not a GitHub
transaction: land still re-fetches the ledger and checks completeness before merge.

For new repair dispatches use one standalone `Finding identities: ` line followed
by a JSON array of `{ "heading": "exact source heading", "url": "source comment URL" }`.
Take `heading` directly from structured `findings[].heading` without adding severity
or Markdown decoration; preserve quotes, backslashes, leading/trailing whitespace,
Unicode and delimiters. JSON escaping transports those bytes losslessly. The guard
uses these identities for PR-body edits as well as repair dispatches. A newly cited
structured review with findings requires explicit identities; prose-only substitutes
are refused. It parses structured findings and compares exact decoded strings, never JSON-line or
surrounding-prose approximations. Legacy exact heading/source records remain
supported. Append source identities and resolution evidence; do not collapse them.

Initial builder tasks may request `Initialize Repair round: 0/3, Review disposition, Residuals`
without a live PR. Round zero and ledger-initialization prose are not repair receipts.
Positive repair rounds (N >= 1), including inline/quoted or malformed receipts,
and Pre-dispatch read-back markers still trigger strict live-PR receipt validation;
a zero-round mention never exempts another repair receipt in the same task.
