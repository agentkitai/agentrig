# R8b independent review — original record

Frozen snapshot `b67dbec`, session `e310826f-22ee-4e58-9668-ff5b2b0c6407`.
The first invocation requested 24 turns, reported 25, and returned
`error_max_turns`: `Reached maximum number of turns (24)` with no final result.
The root authorized only a same-session final-summary continuation: at most two
requested turns, tools disabled, no new inspection. It reported one turn and
completed. These are two invocations of one bounded review, not two broad rounds.
Reported list costs were USD 1.847751 and 1.360345; not subscription billing claims.
No reviewer tests/typecheck ran. The incomplete verdict is not approval. Material
findings are addressed by author reproduction and focused checks, not attributed
to independent execution. One SDK Bash probe was denied; see original summary.

## Original final summary (verbatim)

# R8b Review — Final Summary

## Verdict: **INCOMPLETE**

I hit the turn cap partway through verification. I read all five new/changed source files, all three new test files, the plan, the docs page, and confirmed the SDK's real public API and the `_oncancel` claim. I did **not** run any tests or typecheck, and several planned verifications remain open. Treat the findings below as a partial review — I cannot certify the branch.

---

## Checks actually run

Read-only inspection only (all via `git diff`/`Read`/`Grep` on the frozen snapshot):

- `git diff --stat origin/main...HEAD`, merge-base confirmed as `eead687`; branch is `fbb0929` + merge `b67dbec`.
- Read in full: `mcp-serve-schema.ts`, `mcp-serve-transport.ts`, `mcp-serve-server.ts`, `mcp-serve.ts`, all three test files, `docs/plans/R8b.md`, `docs/MCP-SERVE.md`, the `program.ts` and `ci.yml` diff hunks.
- Read for comparison: `packages/cli/src/acp.ts` (R8a precedent), `packages/cli/src/session-export.ts`.
- Verified the SDK is genuinely installed and pinned: `@modelcontextprotocol/server@2.0.0`, `@modelcontextprotocol/client@2.0.0` (devDep), transitive `@modelcontextprotocol/core@2.0.0`, in `pnpm-lock.yaml` with integrity hashes.
- Verified against the real `.d.mts`/`.mjs` in `node_modules`: `serveStdio(factory, { transport, legacy, onerror, maxSubscriptions })`, the `Transport` interface shape, `ServerContext`/`BaseContext.mcpReq.id`, and `StandardSchemaWithJSON`. No private imports; the plan's "public declarations only" claim holds.

**Not run** (would have been in scope, cap reached first): `pnpm exec vitest run packages/cli/test/mcp-serve*.test.ts`, `pnpm typecheck`.

**Denied commands:** one chained `grep|head; echo; grep` Bash call was refused by the permission layer for containing multiple operations; I re-ran the needed part via the `Grep` tool instead. No other denials. No network, provider, subagent, or write operations were attempted.

---

## Findings established

### 1. `_oncancel` numeric-zero claim — **verified by direct code inspection** (not by reproduction)
`src-CX2iR2pK.mjs:6249-6252`:
```js
async _oncancel(notification) {
  if (!notification.params.requestId) return;
  ...
}
```
Falsy-check, so request ID `0` (and `""`) is silently ignored. The plan's justification for the transport owning per-ID cancellation is factually correct. I did **not** reproduce the fail-before/pass-after control the plan describes.

### 2. `run_task` can lose a completed, budget-consuming run to a generic error — **inference, not reproduced**
`mcp-serve-server.ts:29-31` checks `Buffer.byteLength(JSON.stringify(value)) > 250_000`, but the payload is JSON-encoded **twice**: once here, then again by the SDK when embedding it as `content[].text`. Characters needing escapes expand ~2× per layer.

With `answer` capped at 120,000 bytes (`mcp-serve.ts:48`), the serialized response exceeds `MCP_SERVE_LIMITS.response` (262,144) once roughly 40% of the answer's bytes are escape-worthy (quotes, backslashes, newlines) — realistic for code or minified JSON output. `send` then replaces the whole response with `"MCP response exceeds output bound"` (`mcp-serve-transport.ts:113-115`).

Impact: the run already executed and consumed budget, but the client loses `sessionId`, `reason`, `turns`, and `usage` — everything. The `answerOmitted` marker exists precisely to avoid this and does not cover it. Fails closed (no security impact); partially recoverable via `list_sessions`.

Bounded fix: budget `answer` against the *serialized* cost, or drop `answer` and set `answerOmitted: true` when the framed result would exceed the response bound, so the metadata always survives.

### 3. `read_session` has the same double-encoding exposure — **inference, not reproduced**
`mcp-serve.ts:108` passes `outputBytes: 120_000` to `exportSession`. A quote-dense JSONL transcript double-escapes past 262,144 and refuses. This is arguably contemplated ("otherwise explicit refusal" in the plan; "additionally limited to 120,000 bytes before JSON framing" in the docs), but 120,000 is not a *sufficient* bound for the worst case, so the docs' figure implies more reliability than the code delivers. Lower severity than #2.

### 4. Behaviours confirmed correct by reading
- Cancel/settle/release interleavings in `mcp-serve-transport.ts:83,92-99,106-109` are correct in both orders (cancel-during-handler and cancel-after-settle): the slot is released exactly once and no late result is written.
- `cancelledIds` is bounded — entries are only added for existing slots, and cancellations are gated by the 64-notification-per-connection cap.
- `taskActive` check-and-set (`mcp-serve-server.ts:24-25`) is inside the synchronous prefix of the async IIFE, so the one-live-task invariant is not racy.
- `allowed()` (`mcp-serve.ts:27-29`) uses `!== "allow"`, so `ask` denies — matches the contract.
- `list` returns only `{id, updatedAt, bytes}` — no host paths.
- Schema/unknown-tool rewriting to `_agentrig/refused` (`mcp-serve-transport.ts:67-76`) plus the fixed error message in `send` means hostile tool names and argument keys are not reflected; the three negative assertions in `mcp-serve.test.ts:37-38` target exactly this.

---

## Open — inspection started but not finished

These are **not** findings; they are unverified questions I had reached and could not close:

- Whether `maxTokens` is a real flag consumed by `parseBudget`/`buildAgent`. If it is not, the 8192-token ceiling in `lower(opts.maxTokens, ...)` is silently ineffective — and the existing tests do not cover it (`mcp-serve-runtime.test.ts:51-58` proves the budget stop via `maxTurns: "1"`, not tokens).
- Whether `buildAgent` ignores `opts.mcpConfig` when `mcpServers` is passed explicitly. `mcp-serve.ts:65-67` passes both, whereas ACP deletes `opts.mcpConfig` when no servers matched (`acp.ts:71`). Possible double-start of configured MCP servers.
- Whether `TuiController.shutdown()` is idempotent — it is called from both `run`'s `finally` (`mcp-serve.ts:83`) and `close()` (`mcp-serve.ts:119`).
- Whether `lower()` tolerates a non-numeric configured value (`Number(current)` → `NaN` → `"NaN"`), and whether `maxMinutes: "0"` yields an immediate `abort()` via `Math.min(0, 120_000)` at `mcp-serve.ts:62`.
- Whether the SDK ever emits an unsolicited outbound notification, which `send` would treat as `"unsupported outbound message"` and use to tear down the connection (`mcp-serve-transport.ts:102-104`).
- Whether the CI job that gained the new line runs `pnpm build` first — `mcp-serve-cli.test.ts:30` launches `../dist/index.js` and requires a build.
- `store.pathFor`, `isValidSessionId`, and `unionRetrieve` signatures were used but not verified against their definitions.

---

## Optional polish (separate, non-blocking)

- `onerror: () => {}` (`mcp-serve-server.ts:56`) discards every out-of-band SDK error. Stderr is available and already used for `notice()`; routing errors there would cost nothing.
- `input.task.slice(i, i + 16_000)` (`mcp-serve.ts:74`) splits on UTF-16 code units and can bisect a surrogate pair at a block boundary.
- The `data` handler's per-segment `Buffer.concat` (`mcp-serve-transport.ts:49`) is quadratic in the number of partial chunks; bounded at 1 MiB, so cosmetic.
- Notification frames are not counted against the 8 MiB `inputBytes` cap; they have their own count cap (64), so the "8 MiB admitted input" wording in `docs/MCP-SERVE.md` is slightly narrower than it reads.

---

**Bottom line:** no security defect found in what I examined, and the SDK-interoperability claims I could check are accurate. Finding #2 is a real functional defect worth fixing. But with zero tests executed, no typecheck, and seven open verification questions, this review does not clear R8b — it needs to be resumed.

## Original tool requests (verbatim JSON records)

```json
[
  {
    "tool": "Read",
    "input": {
      "file_path": "/home/amit/agentrig/.claude/worktrees/r8b-mcp-serve/CLAUDE.md"
    }
  },
  {
    "tool": "Read",
    "input": {
      "file_path": "/home/amit/agentrig/.claude/worktrees/r8b-mcp-serve/docs/plans/R8b.md"
    }
  },
  {
    "tool": "Bash",
    "input": {
      "command": "git diff --stat origin/main...HEAD",
      "description": "Show diff stat vs main"
    }
  },
  {
    "tool": "Bash",
    "input": {
      "command": "git log --oneline --graph origin/main...HEAD | head -30; echo \"---merge-base---\"; git merge-base origin/main HEAD",
      "description": "Show branch topology and merge base"
    }
  },
  {
    "tool": "Bash",
    "input": {
      "command": "git diff origin/main...HEAD -- packages/cli/src packages/cli/package.json packages/cli/test .github/workflows/ci.yml",
      "description": "Show source diff"
    }
  },
  {
    "tool": "Read",
    "input": {
      "file_path": "/home/amit/agentrig/.claude/worktrees/r8b-mcp-serve/packages/cli/src/mcp-serve-schema.ts"
    }
  },
  {
    "tool": "Read",
    "input": {
      "file_path": "/home/amit/agentrig/.claude/worktrees/r8b-mcp-serve/packages/cli/src/mcp-serve-transport.ts"
    }
  },
  {
    "tool": "Read",
    "input": {
      "file_path": "/home/amit/agentrig/.claude/worktrees/r8b-mcp-serve/packages/cli/src/mcp-serve-server.ts"
    }
  },
  {
    "tool": "Read",
    "input": {
      "file_path": "/home/amit/agentrig/.claude/worktrees/r8b-mcp-serve/packages/cli/src/mcp-serve.ts"
    }
  },
  {
    "tool": "Read",
    "input": {
      "file_path": "/home/amit/agentrig/.claude/worktrees/r8b-mcp-serve/packages/cli/test/mcp-serve.test.ts"
    }
  },
  {
    "tool": "Read",
    "input": {
      "file_path": "/home/amit/agentrig/.claude/worktrees/r8b-mcp-serve/packages/cli/test/mcp-serve-runtime.test.ts"
    }
  },
  {
    "tool": "Read",
    "input": {
      "file_path": "/home/amit/agentrig/.claude/worktrees/r8b-mcp-serve/packages/cli/test/mcp-serve-cli.test.ts"
    }
  },
  {
    "tool": "Bash",
    "input": {
      "command": "git diff origin/main...HEAD -- packages/cli/src/program.ts docs/MCP-SERVE.md",
      "description": "Show program.ts and docs diff"
    }
  },
  {
    "tool": "Bash",
    "input": {
      "command": "ls node_modules/.pnpm 2>/dev/null | grep -i modelcontext; echo \"---\"; ls packages/cli/node_modules/@modelcontextprotocol 2>/dev/null; echo \"--- lock ---\"; git diff origin/main...HEAD -- pnpm-lock.yaml | head -60",
      "description": "Check MCP SDK install state"
    }
  },
  {
    "tool": "Bash",
    "input": {
      "command": "cd node_modules/.pnpm/@modelcontextprotocol+server@2.0.0/node_modules/@modelcontextprotocol/server && ls && cat package.json | head -60",
      "description": "Inspect MCP server package"
    }
  },
  {
    "tool": "Bash",
    "input": {
      "command": "cd node_modules/.pnpm/@modelcontextprotocol+server@2.0.0/node_modules/@modelcontextprotocol/server/dist && ls && wc -l *.d.mts",
      "description": "List SDK dist files"
    }
  },
  {
    "tool": "Bash",
    "input": {
      "command": "D=/home/amit/agentrig/.claude/worktrees/r8b-mcp-serve/node_modules/.pnpm/@modelcontextprotocol+server@2.0.0/node_modules/@modelcontextprotocol/server/dist; ls -la $D",
      "description": "List SDK dist files"
    }
  },
  {
    "tool": "Read",
    "input": {
      "file_path": "/home/amit/agentrig/.claude/worktrees/r8b-mcp-serve/node_modules/.pnpm/@modelcontextprotocol+server@2.0.0/node_modules/@modelcontextprotocol/server/dist/stdio.d.mts"
    }
  },
  {
    "tool": "Bash",
    "input": {
      "command": "D=/home/amit/agentrig/.claude/worktrees/r8b-mcp-serve/node_modules/.pnpm/@modelcontextprotocol+server@2.0.0/node_modules/@modelcontextprotocol/server/dist; grep -n \"interface Transport\" -A 40 $D/createMcpHandler-CLhGwQTn.d.mts | head -60",
      "description": "Find Transport interface"
    }
  },
  {
    "tool": "Bash",
    "input": {
      "command": "D=/home/amit/agentrig/.claude/worktrees/r8b-mcp-serve/node_modules/.pnpm/@modelcontextprotocol+server@2.0.0/node_modules/@modelcontextprotocol/server/dist; grep -n \"_oncancel\" -A 20 $D/mcp-DXXb3Vv3.mjs | head -60",
      "description": "Check SDK cancellation handler"
    }
  },
  {
    "tool": "Bash",
    "input": {
      "command": "D=/home/amit/agentrig/.claude/worktrees/r8b-mcp-serve/node_modules/.pnpm/@modelcontextprotocol+server@2.0.0/node_modules/@modelcontextprotocol/server/dist; grep -rn \"notifications/cancelled\" $D/*.mjs | head -20",
      "description": "Find cancellation notification handling"
    }
  },
  {
    "tool": "Bash",
    "input": {
      "command": "D=/home/amit/agentrig/.claude/worktrees/r8b-mcp-serve/node_modules/.pnpm/@modelcontextprotocol+server@2.0.0/node_modules/@modelcontextprotocol/server/dist; sed -n '6150,6175p' $D/src-CX2iR2pK.mjs",
      "description": "Inspect SDK cancelled notification handler"
    }
  },
  {
    "tool": "Bash",
    "input": {
      "command": "D=/home/amit/agentrig/.claude/worktrees/r8b-mcp-serve/node_modules/.pnpm/@modelcontextprotocol+server@2.0.0/node_modules/@modelcontextprotocol/server/dist; grep -n \"_oncancel(notification)\\s*{\" -A 15 $D/src-CX2iR2pK.mjs | head -30; echo \"===\"; grep -n \"_oncancel\" $D/src-CX2iR2pK.mjs",
      "description": "Find _oncancel implementation"
    }
  },
  {
    "tool": "Grep",
    "input": {
      "pattern": "_oncancel",
      "path": "/home/amit/agentrig/.claude/worktrees/r8b-mcp-serve/node_modules/.pnpm/@modelcontextprotocol+server@2.0.0/node_modules/@modelcontextprotocol/server/dist/src-CX2iR2pK.mjs",
      "output_mode": "content",
      "-A": 14
    }
  },
  {
    "tool": "Bash",
    "input": {
      "command": "cd /home/amit/agentrig/.claude/worktrees/r8b-mcp-serve && wc -l packages/cli/src/acp.ts packages/cli/src/run.ts packages/cli/src/agent-builder.ts packages/cli/src/session-export.ts packages/cli/src/tui/controller.ts packages/cli/src/config.ts",
      "description": "Check sizes of related files"
    }
  },
  {
    "tool": "Read",
    "input": {
      "file_path": "/home/amit/agentrig/.claude/worktrees/r8b-mcp-serve/packages/cli/src/acp.ts"
    }
  },
  {
    "tool": "Read",
    "input": {
      "file_path": "/home/amit/agentrig/.claude/worktrees/r8b-mcp-serve/packages/cli/src/session-export.ts"
    }
  },
  {
    "tool": "Bash",
    "input": {
      "command": "D=/home/amit/agentrig/.claude/worktrees/r8b-mcp-serve/node_modules/.pnpm/@modelcontextprotocol+server@2.0.0/node_modules/@modelcontextprotocol/server/dist; grep -n \"mcpReq\" $D/createMcpHandler-CLhGwQTn.d.mts | head -40",
      "description": "Find mcpReq in SDK types"
    }
  },
  {
    "tool": "Bash",
    "input": {
      "command": "D=/home/amit/agentrig/.claude/worktrees/r8b-mcp-serve/node_modules/.pnpm/@modelcontextprotocol+server@2.0.0/node_modules/@modelcontextprotocol/server/dist; sed -n '2170,2260p' $D/createMcpHandler-CLhGwQTn.d.mts",
      "description": "Read ServerContext mcpReq shape"
    }
  },
  {
    "tool": "Bash",
    "input": {
      "command": "D=/home/amit/agentrig/.claude/worktrees/r8b-mcp-serve/node_modules/.pnpm/@modelcontextprotocol+server@2.0.0/node_modules/@modelcontextprotocol/server/dist; sed -n '2070,2140p' $D/createMcpHandler-CLhGwQTn.d.mts",
      "description": "Read BaseContext mcpReq"
    }
  }
]
```

