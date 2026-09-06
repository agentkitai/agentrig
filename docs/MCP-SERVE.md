# MCP serving

Launch `agentrig mcp-serve` as a stdio MCP server from the project you intend to
expose. Normal trusted-project configuration and `--profile`/provider/budget flags
apply. Stdout is protocol-only; no listening port, daemon or remote authentication
endpoint is opened. Exact SDK 2.0.0 supports modern MCP 2026-07-28 discovery and
legacy initialize clients, including AgentRig's existing 2024-11-05 client.

| Tool | Input | Result |
|---|---|---|
| `run_task` | `task`, optional lower `maxTurns`/`maxTokens` | New session ID, reason, main usage, bounded model text and omission marker |
| `list_sessions` | optional `limit` (1–100, default 20) | Configured-store metadata, no host paths |
| `read_session` | exact `id` | Redacted transcript; opaque blocks omitted; oversized exports refuse |
| `memory_search` | `query` | Up to eight local-memory snippets |

The stdio client receives sensitive project information. Only connect a client
you intend to give that access. Redaction is heuristic and cannot guarantee all
secrets are absent; normal immutable logs are not scrubbed or exposed as raw events.
Returned model claims and transcripts are advisory, not proof or authorization.

Serving never implies `--yolo`. Configured allows/denies apply; asks deny without
an interactive channel. A client task is external advisory input, **not a fresh
human approval**, even if it says otherwise. R13c's additional exec/network/
outside-write restriction remains in force independently of blanket allows. This
interface deliberately cannot manufacture the human approval needed to cross it.
Use the normal interactive CLI/ACP workflow when that authorization is required.
Configured MCP dependencies need existing unchanged operator-approved definitions;
establish/approve them through the normal operator CLI, not a serving request.
Client arguments cannot change cwd, credentials, provider, child configuration,
grants or sandbox policy. Host extensions remain trusted JavaScript, not isolated
merely because they are exposed through a protocol.

One task runs at a time. Defaults cap it at 20 turns, 8192 **main-model** tokens,
and a 120-second cooperative deadline; smaller configured or requested caps win.
Auxiliary work retains its existing independent limits/accounting, so these are
not total remote billing ceilings. Cancellation and EOF abort and join owned
runtime cleanup; uncooperative trusted host code cannot be forcibly made quiescent.
No late result is sent for a cancelled request.

Wire limits: 1 MiB/frame, 16 pending requests, 8 MiB admitted input, 4 MiB reserved
output, 256 KiB/response, and 64 notifications per connection. Cancelled IDs are
retired for that connection. Overload/duplicate IDs/unsupported notifications close
the connection. Capacity stays reserved through actual stdout writes or cancelled
handler cleanup, not merely until the SDK has queued a result. Schema and method
errors are fixed nonreflective refusals. A large run answer explicitly marks omitted
text; other oversized results refuse. Transcript text is additionally limited to
120,000 bytes before JSON framing. Session enumeration caps at 4096 entries; memory
scans cap at 512 entries, depth eight, 256 KiB/file and 2 MiB total. No automatic
resource fetching, sampling, elicitation, event streaming or remote memory search.

See [implementation and verification](plans/R8b.md).
