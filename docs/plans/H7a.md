# H7a — bounded output-limit continuation

Issue #116 is a correctness repair before R5b, after R5a PR #157 and its green main gate.
The current roadmap's two-continuation acceptance supersedes the older issue's one-retry
suggestion. Provider-specific caps and reasoning UI are not part of this repair.

## Runtime contract

- A `max_tokens` response stages at most two consecutive continuations. A third consecutive
  truncated response ends with an explicit non-fatal exhaustion error and session reason
  `error`. Any non-truncated response resets this consecutive allowance. Existing session
  budgets still bound alternating tool/continuation responses; explicit resume starts a new
  allowance, while retaining cumulative session usage and turn counts.
- Preserve the typed assistant content emitted by the adapter. Raw incomplete argument bytes
  already discarded by existing adapters are not reconstructed. Execute **no** tool call from
  a truncated response, even if its arguments parse. Persist paired advisory error results
  stating that each call was not executed, with its original tool-use ID. These are transcript
  repairs, not fabricated `tool.call`/`tool.result` execution receipts.
- Append a platform/advisory continuation nudge to the existing task. Its user-role transport
  is not genuine user input, a steer, fresh permission approval, or a source-trust upgrade.
  It must not clear R13c's external-input restriction.
- Continue through the ordinary loop, compaction, pause/abort, budget, and pre-model gates.
  Each attempted continuation is a new model iteration and budgeted turn; per-response token
  caps do not change. Token/cache/USD totals include all reported responses. As before, a
  pre-model veto can consume an allocated turn without making a provider call; it retains
  the existing `done` outcome. Cancellation yields `aborted`, budget refusal `budget`.
- `turn.continued` records the new turn `n`, prior truncated turn `from`, consecutive `attempt`
  (1 or 2), `maxAttempts: 2`, and `reason: max_tokens`. Emit only at the actual provider-attempt
  boundary after budget/abort/pre-model gates, not when staging a possible retry. A provider
  error after that boundary is still an attempted continuation. No event on blocked retry.
  CLI/TUI chat makes this visible separately from transport-level `model.retry`.
- Recheck wall-clock budget and abort after pre-model preparation, counting the current turn
  slot only once. Saved partial content and transcript repairs remain available even if no
  retry can run. They never authorize pending tool dispatch on resume.

## Verification

Network-free real-loop fixtures: two truncations then completion (exactly two continuation
events), exhaustion, reset after a non-truncated call, cumulative accounting, actual partial
tool non-execution and paired IDs, snapshot/materialized-log equality and resume; normal
turn/token/USD caps, pre-model veto/abort/time refusal. Real Anthropic, OpenAI-compatible and
Responses SSE parsers feed the loop, and outbound projections preserve repaired call IDs.
Rendering/schema tests and the continuation suite run on Windows as well as full Unix CI.
Named negative controls, complete build/typecheck/tests and one bounded independent review
gate delivery. No live evaluation spending or task-benefit claims.

## Independent review receipt

Single Claude session `fb321df8-52c6-45dc-a950-6d1bd57c05fb` reviewed `2ffc821` against
main `78e8e19`: APPROVE, no material findings. Requested max24, reported 19 turns,
167 seconds, no restart or subagents. Independently passed build/typecheck and the full
2,308 tests plus two skips across 123 files. The two non-blocking notes, verbatim:

> When a continuation is staged but the next iteration's budget gate refuses it, the platform nudge remains in the persisted transcript with no matching `turn.continued`. The contract allows saved repairs without a retry, and it is harmless on resume, but the transcript then contains a nudge for a continuation that never happened.

> The pre-existing pre-model veto path still breaks without a `turn.end` event. The contract explicitly retains that behavior, so it is out of scope here.

Both are documented behavior; optional polish is recorded at the roadmap end. No production
changes followed the review and no second general review was run.
