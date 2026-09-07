# Subagent integer turn-limit independent review

Frozen ea067b2 vs base300c5e2. One substantive review: requested24/reported26 turns;
APPROVE, no material findings. No summary continuation. Reported turn count is not
an enforced ceiling. First invocation failed before any session because variadic
CLI arguments consumed the prompt; corrected invocation used an explicit separator.
One git command was denied; reviewer base-comparison limitation is retained verbatim.
Author separately verified `git diff db2271b 300c5e2 --` for the changed source/test
files is empty. No second review. Metadata cost is list-price estimation, not a
subscription invoice.

## Verbatim reviewer result

**Verdict: APPROVE.** Commit ea067b2 does what the plan doc specifies, and I found no material defects.

**What the change does, as inspected**

- `packages/cli/src/config.ts:21` adds `SubagentTurnLimitSchema`, which is the existing positive-number setting plus a safe-integer refinement. `subagentMaxTurns` in the config schema now uses it at line 130. Config numbers and strings both pass through the existing `String` transform, so a file value of `1.5` or `"1.5"` is rejected at config parse with the schema-authored message, which the custom-issue branch of `safeIssueMessage` preserves.
- `packages/cli/src/agent-builder.ts:71-75` adds `subagentTurnLimit`, defaulting to "15" and throwing a flag-named error. It is called first thing in `buildAgent` at line 491, before OTEL validation, heartbeat rewriting, provider table validation, package/extension discovery, and `buildProviders` at line 516. It is also used in `subagentOptions` at line 427, replacing the old `positiveNumber` call, so any caller that builds child wiring without `buildAgent` is still covered.
- The role-runtime requirement it mirrors is `packages/core/src/tools/subagent.ts:277-279`, which refuses a role spawn unless the effective turn count is a safe integer at least 1. The CLI check now matches that exactly, so the pre-existing R15h review finding about fractional limits making every role spawn refuse is closed at startup rather than at dispatch.
- Precedence is retained. The flag still defaults to "15" in `program.ts:275`, and `explicitCliValues` ignores default-sourced flag values, so a config value is not shadowed by the flag default. The config-source test cases rely on this and expect exit 1.

**Tests, as read**

- `agent-roles.test.ts:19-60` runs a real local-provider spawn with omitted, "2", and "2.0" limits, asserts the role allowlist reaches the child request, bash is denied despite YOLO, and the spawn event carries the role's own turn limit of 2. That covers the retained-behaviour side of the acceptance.
- `agent-roles.test.ts:62-75` covers flag, config-number, and config-string sources of 1.5 with a `buildProviders` canary that must never be called, exit code 1, and an "integer" message on stderr.
- `agent-roles.test.ts:77-81` covers the direct builder for "1.5", "0", "NaN", "Infinity", and 2^53 with the same canary.
- `subagent-wiring.test.ts:95-117` still expects "3" to yield 3 and "lots" to throw naming the flag. The new message contains the flag name, so that assertion still holds.

**Optional notes, not blocking**

- A bad `--subagent-max-turns` now fails startup even when subagents are disabled, since validation runs before `heartbeatBuildOptions` and regardless of `opts.subagents`. Config already behaved this way. It is consistent with the plan's "fail before provider construction" intent, but it is a small behaviour change for the flag path.
- The builder error no longer echoes the offending value, unlike `positiveNumber`. Diagnostics are slightly less specific. Tests only match on "integer" and the flag name.
- Validation runs twice on the `buildAgent` path, once at entry and once in `subagentOptions`. Harmless.
- Integer-valued exotic spellings such as "1e1" or "0x10" are accepted because `Number()` yields an integer. That is inherited from the existing positive-setting behaviour and is outside this row's scope.

**What I inspected and did not execute**

- Read: the plan doc, `docs/STATUS.md` head, ROADMAP R15h entries, `config.ts`, `agent-builder.ts` regions around lines 60-90, 300-530, and 716, `run.ts` `positiveNumber`, `core/src/tools/subagent.ts` around line 277, `program.ts` flag definition, and both test files above.
- Base comparison: Bash was denied in this session, so I could not run `git diff 300c5e2 ea067b2`. I confirmed from the worktree reflog that the branch moved from 300c5e2 to ea067b2 in one commit, and compared the touched files against the main checkout's copies, which show the pre-change `positiveSetting` and `positiveNumber` spellings. That main checkout is at db2271b, two commits behind 300c5e2. I inferred, but did not verify, that those two intervening commits did not touch these files.
- Did not run tests, build, or typecheck, so the "61 passing" claim in STATUS.md is unverified by me. Did not install tools, invoke models, access the network, or delegate. No files were edited.

## Reported metadata

```json
{
  "duration_api_ms": 103871,
  "stop_reason": "end_turn",
  "session_id": "4952565a-bd7f-47c2-8960-2aa7ad0026f3",
  "total_cost_usd": 2.33148525,
  "usage": {
    "input_tokens": 194,
    "cache_creation_input_tokens": 91115,
    "cache_read_input_tokens": 406781,
    "output_tokens": 8111,
    "output_tokens_details": {
      "thinking_tokens": 2703
    },
    "server_tool_use": {
      "web_search_requests": 0,
      "web_fetch_requests": 0
    },
    "service_tier": "standard",
    "cache_creation": {
      "ephemeral_1h_input_tokens": 91115,
      "ephemeral_5m_input_tokens": 0
    },
    "inference_geo": "not_available",
    "iterations": [
      {
        "input_tokens": 32,
        "output_tokens": 2463,
        "cache_read_input_tokens": 89083,
        "cache_creation_input_tokens": 2032,
        "cache_creation": {
          "ephemeral_5m_input_tokens": 0,
          "ephemeral_1h_input_tokens": 2032
        },
        "type": "message"
      }
    ],
    "speed": "standard"
  },
  "modelUsage": {
    "claude-fable-5-1": {
      "inputTokens": 194,
      "outputTokens": 8111,
      "cacheReadInputTokens": 406781,
      "cacheCreationInputTokens": 91115,
      "webSearchRequests": 0,
      "costUSD": 2.33148525,
      "contextWindow": 1000000,
      "maxOutputTokens": 64000,
      "thinkingTokens": 2703,
      "canonicalModel": "claude-fable-5-1",
      "provider": "firstParty",
      "costBasis": "list"
    }
  },
  "permission_denials": [
    {
      "tool_name": "Bash",
      "tool_use_id": "toolu_01MQXXWikNGSg9oNGtf6BuSS",
      "tool_input": {
        "command": "git -C /home/amit/agentrig/.claude/worktrees/subagent-integer-turn-limits status --short && git -C /home/amit/agentrig/.claude/worktrees/subagent-integer-turn-limits diff --stat 300c5e2 ea067b2 && git -C /home/amit/agentrig/.claude/worktrees/subagent-integer-turn-limits diff 300c5e2 ea067b2",
        "description": "Show status and diff between base and head"
      }
    }
  ],
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
  "num_turns": 26,
  "subtype": "success",
  "api_error_status": null,
  "ttft_ms": 3464,
  "type": "result",
  "duration_ms": 104580,
  "uuid": "8e690b00-6227-46eb-816f-3e405c13016c",
  "ttft_stream_ms": 2585,
  "time_to_request_ms": 389,
  "first_content_frame_ms": 3440,
  "queued_turn_count": 0
}
```

## Author disposition

No material fixes required. Validation of explicitly supplied invalid values also
applies when subagents are disabled; fixed diagnostics omit raw invalid values.
Inherited integer-valued spellings and default15 remain intentional. Duplicate
boundary validation protects direct child-wiring calls as well as startup. No broader
numeric reform or new framework. Author gates: build/typecheck,95 focused tests,
required pinned Docker full3,280 passed+2 existing skips/209 files (93.36s), Chromium1.

