# R8a independent review — original findings

Snapshot `39324e6`, session `bd92a587-5f12-408f-9cd4-94df14d0c93a`.
One read-only `claude -p` invocation requested `--max-turns 24`; its JSON reported
**56 turns**, not 24. No subagents or network tools. The CLI reported list-price
cost USD 4.2219695; this is not a claim about subscription billing. Two attempted
SDK-location shell probes were denied by the allowlist. Findings below are the
original result verbatim, not independently reproduced claims.

**Verdict: REQUEST_CHANGES** (one blocking defect, one bound claim that the real path does not enforce). The core security posture holds: trust isolation, literal prompts, advisory authority, exact MCP match with existing pins only, and permission correlation all check out against the code.

**What I ran**
- `vitest run` on advisory-prompt, acp-transport, acp-server, acp-config, mcp-pinning: 5 files, 19 tests passed.
- `pnpm typecheck`: all four packages clean.
- Not run: `acp-cli.test.ts` (spawns `dist/`, needs a build), the full suite, and any live provider. I did not execute a reproduction of finding 1 because that requires writing a test; it is established from code reading only.

**Findings (blocking)**

1. **Raw event extension can tear down the whole connection on one large tool result.** `packages/cli/src/acp-server.ts:79` forwards every core event verbatim when `_agentrig/events` is enabled. A `tool.result` event carries the complete overflow text in `output` (`packages/core/src/tool-execution.ts:480`), and that text is uncapped for `read_file` (`packages/core/src/tools/read-file.ts:48-50`) and `bash` (`packages/core/src/tools/bash.ts:205-210`). The transport's `size()` hook (`packages/cli/src/acp-transport.ts:115-116`) calls `close()` on any message over 1 MiB, which destroys stdin/stdout and aborts every session on the connection. Failure scenario: client enables raw events, model reads a 1.1 MB log file, the tool runs, then the editor loses the agent mid-turn. Minimal fix: in `observe`, serialize the event once and, if it exceeds a raw-event cap (for example 256 KiB), send a bounded substitute such as the event with `output` removed and a `truncated: true` marker, or skip it with a `_agentrig/event` notice. Never let a per-event payload reach the frame-close path.

2. **The documented 4 MiB queued-output cap is not effective on the real SDK path.** The SDK serializes writes through a promise chain and awaits each `writer.write` before starting the next (`node_modules/.pnpm/@agentclientprotocol+sdk@1.4.0_zod@3.25.76/node_modules/@agentclientprotocol/sdk/dist/jsonrpc.js:872-889`). So the transport's `size()` accounting at `acp-transport.ts:111-119` only ever sees one message at a time, and the queue really lives in the SDK chain, bounded only by the server's 256 outstanding notifications at `acp-server.ts:54`. The test at `packages/cli/test/acp-transport.test.ts:35-45` writes to the transport directly and therefore does not exercise this path. Effective worst case with raw events is 256 × 1 MiB, not 4 MiB. Minimal fix: track cumulative serialized bytes of `outstanding` in `send()` and `fail()` when they exceed `ACP_LIMITS.outputBytes`, and correct `docs/ACP.md:53-55` and the "Output accounting happens when the SDK enqueues a write" sentence in `docs/plans/R8a.md:52-54`.

**Verified as correct**
- Trust: `--trust` is scoped to the launch project root only (`acp.ts:57-58`), config loads per session cwd without chdir, and the other project's config and `trustedProjectRoot` are absent (`acp-config.test.ts:54-56`).
- Literal prompt and advisory authority: `controller.prompt` bypasses the slash parser; `expansion.user` only fires for non-blank text, advisory blocks are `external`/`advisory`, and initial/continued/resumed runs plus snapshot and event materialization retain them. Text-only runs emit no new fields, so H6 traces are unchanged.
- MCP: exact name/command/args/env match, cwd resolved per session, `requireExistingPins` refuses before any `compareAndSet`, and a partial connect is refused by the count check at `acp.ts:91`.
- Permissions: outbound IDs are namespaced, the pending object identity is rechecked before resolve, only a selected `allow` approves, cancel settles locally as deny and the approval update is flushed before the prompt response.
- Memory: configured store only, actual policy consulted and fail-closed when absent, scan caps applied, results sliced and bounded.

**Optional polish**
- `session/cancel` arriving after the run has finished but before `busy` clears reports `cancelled` even though the run completed; the `_meta` reason still tells the truth.
- A cancel during the very first prompt leaves `resumable` false, so the next prompt silently starts a fresh internal session rather than continuing. Worth a sentence in ACP.md.
- `size()` and `write()` each `JSON.stringify` the same message; compute once.
- The 256 outstanding-notification cap is far tighter than the byte cap for small deltas when the client stalls its read; consider raising it once byte accounting exists.
- `renderEvent` now prints an advisory-context count for `session.start`/`session.resume`, but no render test covers it.
