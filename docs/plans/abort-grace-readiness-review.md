# Independent review receipt

Frozen commit:20fc2c9, base ebfd10f. One substantive Claude review requested maximum24 turns; actual15. Session 8ee5f054-9c72-45d9-ae03-8453c1213a27. No repeat review. Raw result below is unchanged. Reported cost is list-price metadata, not an invoice or subscription charge.

Author disposition: APPROVE, no material findings. Independent review did not run full/build/hosted or before mutation. Author independently reproduced the150ms parent's first-response control: old80ms abort baseline passed, delayed failed at missing note; readiness implementation restored both. The reviewer reports an unavailable GitHub MCP connection and an ad-hoc test typecheck with pre-existing implicit-any errors outside this diff. Author normal build/typecheck passed;45-file-focused tests, full pinnedDocker3318+2 skips/209files88.83s and realChromium1passed3.23s. Parent verified prior receipts; no new hosted claims yet.

## Original verdict

**Verdict: APPROVE.** The single commit on this branch touches only the test file and docs, and it meets the contract in docs/plans/abort-grace-readiness.md.

**Actual readiness.** The readiness signal is real, not timer-based. In packages/core/test/subagent.test.ts, `GatedStore.append` calls `signalEntered()` when the child's `session.end` payload arrives and only then awaits the gate. The test awaits `childStore.ready` (bounded by a 4s rejecting timer) before calling `session.control.abort()`. In packages/core/src/session-lifecycle.ts, `finish()` does `await emit({ type: "session.end", reason })` before the child's `done` can resolve, so while the gate is held the child's `done` stays pending and the parent's 100ms grace fires deterministically.

**Retained assertions.** All three survive unchanged:
- `expect(summary.reason).toBe("aborted")` and the exact regex `/still running 100ms after abort \(tool subagent\)/`
- `expect(note!.fatal).toBe(false)`
- child log read back: `expect((childEvents.at(-1) as { type: string }).type).not.toBe("session.end")`

**Joined failure cleanup.** The `finally` block aborts the parent, releases the gate, then `await session.done` and `await child?.done`. The child session is the real one, captured by wrapping `run()` in the harness's `createAgent` (spreading a plain object literal with arrow-function members, so no `this` loss). Because `finish()` awaits the terminal append, `child.done` resolving means the JSONL write has landed before the `afterEach` `rm(root)`. The old 200ms sleep is gone. The readiness timer is cleared in both paths, so no dangling handle or unhandled rejection.

**Test validity.** Focused run passed:

```
pnpm vitest run packages/core/test/subagent.test.ts -t "abort grace is bounded"
Tests  2 passed | 43 skipped (45)   Duration 1.85s
```

Root `pnpm typecheck` excludes `test/` (core tsconfig includes only `src`), so I ran an ad hoc `tsc --noEmit` on the test file against the built declarations. The only errors are pre-existing implicit-any errors at line 792, outside this diff. No production files changed.

**Not verified.**
- The "failing-before delayed control" claim, since confirming it requires editing the old 80ms fixture, which was not permitted.
- The ROADMAP receipt links for #217 and #218. The GitHub MCP server failed to connect.
- Full suite, `pnpm build`, and hosted CI were outside the review bounds and were not run. No commands were denied.

**Non-blocking notes.**
- The 150ms delay is applied to the first `stream()` call, which is the parent's first turn, not child startup specifically. That matches the contract's "first-response delay" wording, but the test title says "startup".
- ROADMAP.md and STATUS.md also mark #217 and #218 as delivered. That is bookkeeping outside the test-only contract, harmless if the receipts are accurate.

## Raw reported metadata

```json
{
  "duration_api_ms": 147567,
  "stop_reason": "end_turn",
  "session_id": "8ee5f054-9c72-45d9-ae03-8453c1213a27",
  "total_cost_usd": 1.5163722499999999,
  "usage": {
    "input_tokens": 258,
    "cache_creation_input_tokens": 45455,
    "cache_read_input_tokens": 376769,
    "output_tokens": 10210,
    "output_tokens_details": {
      "thinking_tokens": 6129
    },
    "server_tool_use": {
      "web_search_requests": 0,
      "web_fetch_requests": 0
    },
    "service_tier": "standard",
    "cache_creation": {
      "ephemeral_1h_input_tokens": 45455,
      "ephemeral_5m_input_tokens": 0
    },
    "inference_geo": "not_available",
    "iterations": [
      {
        "input_tokens": 32,
        "output_tokens": 1051,
        "cache_read_input_tokens": 55300,
        "cache_creation_input_tokens": 1715,
        "cache_creation": {
          "ephemeral_5m_input_tokens": 0,
          "ephemeral_1h_input_tokens": 1715
        },
        "type": "message"
      }
    ],
    "speed": "standard"
  },
  "modelUsage": {
    "claude-fable-5-1": {
      "inputTokens": 258,
      "outputTokens": 10210,
      "cacheReadInputTokens": 376769,
      "cacheCreationInputTokens": 45455,
      "webSearchRequests": 0,
      "costUSD": 1.5163722499999999,
      "contextWindow": 1000000,
      "maxOutputTokens": 64000,
      "thinkingTokens": 6129,
      "canonicalModel": "claude-fable-5-1",
      "provider": "firstParty",
      "costBasis": "list"
    }
  },
  "permission_denials": [],
  "terminal_reason": "completed",
  "fast_mode_state": "off",
  "fast_mode_disabled_reason": "sdk_opt_in_required",
  "subagent_stats": {
    "spawned": 0,
    "requested": {
      "background": 0,
      "foreground": 0,
      "unset": 0
    },
    "started_in_background": 0,
    "max_depth": 0,
    "spawned_by_subagents": 0,
    "completed": 0,
    "failed": 0,
    "killed": {
      "parent": 0,
      "user": 0,
      "system": 0
    },
    "refused": {
      "depth_limit": 0,
      "concurrency_limit": 0,
      "budget": 0
    },
    "by_type": {}
  },
  "is_error": false,
  "num_turns": 15,
  "subtype": "success",
  "api_error_status": null,
  "result": "**Verdict: APPROVE.** The single commit on this branch touches only the test file and docs, and it meets the contract in docs/plans/abort-grace-readiness.md.\n\n**Actual readiness.** The readiness signal is real, not timer-based. In packages/core/test/subagent.test.ts, `GatedStore.append` calls `signalEntered()` when the child's `session.end` payload arrives and only then awaits the gate. The test awaits `childStore.ready` (bounded by a 4s rejecting timer) before calling `session.control.abort()`. In packages/core/src/session-lifecycle.ts, `finish()` does `await emit({ type: \"session.end\", reason })` before the child's `done` can resolve, so while the gate is held the child's `done` stays pending and the parent's 100ms grace fires deterministically.\n\n**Retained assertions.** All three survive unchanged:\n- `expect(summary.reason).toBe(\"aborted\")` and the exact regex `/still running 100ms after abort \\(tool subagent\\)/`\n- `expect(note!.fatal).toBe(false)`\n- child log read back: `expect((childEvents.at(-1) as { type: string }).type).not.toBe(\"session.end\")`\n\n**Joined failure cleanup.** The `finally` block aborts the parent, releases the gate, then `await session.done` and `await child?.done`. The child session is the real one, captured by wrapping `run()` in the harness's `createAgent` (spreading a plain object literal with arrow-function members, so no `this` loss). Because `finish()` awaits the terminal append, `child.done` resolving means the JSONL write has landed before the `afterEach` `rm(root)`. The old 200ms sleep is gone. The readiness timer is cleared in both paths, so no dangling handle or unhandled rejection.\n\n**Test validity.** Focused run passed:\n\n```\npnpm vitest run packages/core/test/subagent.test.ts -t \"abort grace is bounded\"\nTests  2 passed | 43 skipped (45)   Duration 1.85s\n```\n\nRoot `pnpm typecheck` excludes `test/` (core tsconfig includes only `src`), so I ran an ad hoc `tsc --noEmit` on the test file against the built declarations. The only errors are pre-existing implicit-any errors at line 792, outside this diff. No production files changed.\n\n**Not verified.**\n- The \"failing-before delayed control\" claim, since confirming it requires editing the old 80ms fixture, which was not permitted.\n- The ROADMAP receipt links for #217 and #218. The GitHub MCP server failed to connect.\n- Full suite, `pnpm build`, and hosted CI were outside the review bounds and were not run. No commands were denied.\n\n**Non-blocking notes.**\n- The 150ms delay is applied to the first `stream()` call, which is the parent's first turn, not child startup specifically. That matches the contract's \"first-response delay\" wording, but the test title says \"startup\".\n- ROADMAP.md and STATUS.md also mark #217 and #218 as delivered. That is bookkeeping outside the test-only contract, harmless if the receipts are accurate.",
  "ttft_ms": 5286,
  "type": "result",
  "duration_ms": 155652,
  "uuid": "8b34c80a-0bd2-4843-a282-67145076c703",
  "ttft_stream_ms": 2257,
  "time_to_request_ms": 282,
  "first_content_frame_ms": 3020,
  "queued_turn_count": 0
}
```

