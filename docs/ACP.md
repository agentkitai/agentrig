# ACP editor integration

`agentrig acp` serves **stable Agent Client Protocol v1** over UTF-8 newline-framed
JSON-RPC on stdin/stdout. Build first (`pnpm build`). Point an ACP editor at
`node /absolute/path/packages/cli/dist/index.js acp` and normal provider/budget flags.
This is not ACP v2 (currently draft), a network listener, or the `run --json` format.
Configuration/model calls start at `session/new`/`session/prompt`, not `initialize`.

For a scripted client using the official SDK:

```sh
node packages/cli/scripts/acp-client.mjs /absolute/project "inspect this project" --provider openai --model MODEL
```

The example asks on a terminal and denies unattended permission requests. Provider
use can spend money/tokens; tests use only fake providers or local HTTP fixtures.

Supported baseline: `initialize`, `session/new`, `session/prompt`, `session/cancel`,
streamed `session/update`, and agent→client `session/request_permission`. Text and
resource links are accepted; links remain external/advisory references, **not**
fresh user instructions or automatic reads/fetches. Unknown URI retrieval is not
provided. Image/audio/embedded-resource, load/list/resume, HTTP/SSE MCP, and client
filesystem/terminal capabilities are not advertised. Subsequent prompts on the
same live ACP session continue its existing internal conversation.

Each session has its own canonical cwd and live grant registry. `--trust` applies
only to the launch project; it does not trust another client-selected project.
The configured policy still applies, including explicit denies/yolo and sandbox
restrictions. ACP asks offer **allow once / deny once only**. Cancellation, invalid
options, stale replies and disconnect never grant authority. Slash-prefixed prompt
text is literal model input, not a controller command.

Client-provided stdio MCP servers must exactly match entries in the operator's
trusted `--mcp-config`: name, absolute executable, ordered args and env values.
Only requested matching servers connect. First use, changed or missing definition
pins refuse; establish/review pins in the operator CLI first. ACP never persists
definition consent from an execution approval. Enforcing sandboxes still refuse
host MCP startup. Client config/credentials are not echoed in protocol errors.

Versioned extensions are advertised under `_meta.agentrig`:

| Method | Parameters beyond `sessionId` | Result |
|---|---|---|
| `_agentrig/state` | none | Live status, model, turns, plan, pending-approval indicator |
| `_agentrig/events` | `enabled: boolean` | Opt-in future `_agentrig/event` notifications; no history replay |
| `_agentrig/supervisor` | none | Current controller signals |
| `_agentrig/memory` | optional `query` | Bounded local configured-wiki list/search; configured read denies still win |

Raw events are **sensitive, unredacted session data**, not a public export. There is
no arbitrary command/maintenance RPC or client-selected memory path. Normal logs
and notices use stderr; trusted host extensions must also keep stdout protocol-only.

Limits: eight sessions per connection, one prompt each, 32 inbound requests, eight
outstanding permission replies, 1 MiB frames, 4 MiB queued output, 256 queued
notifications, 32 prompt blocks, 256 KiB text and 256 KiB advisory data. Overflow
closes the connection and denies asks, never silently drops a live update. Reconnect
to create sessions after the session cap. The v1 prompt response follows controller
settlement and update flush; cancellation uses existing runtime joining guarantees,
not a claim that arbitrary uncooperative host code/remote work has physically stopped.
Generic harness budget stops map to `max_turn_requests`; `_meta.agentrig.reason`
preserves the actual harness terminal reason. See [R8a details](plans/R8a.md).

Protocol references: [initialization](https://agentclientprotocol.com/protocol/v1/initialization),
[sessions](https://agentclientprotocol.com/protocol/v1/session-setup),
[prompt lifecycle](https://agentclientprotocol.com/protocol/v1/prompt-turn),
[permissions](https://agentclientprotocol.com/protocol/v1/tool-calls),
[extensions](https://agentclientprotocol.com/protocol/v1/extensibility).
