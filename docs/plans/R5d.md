# R5d — MCP tool-definition pinning

MCP tool definitions are executable supply-chain inputs, not authorization evidence. This row
pins the exact names, descriptions and raw input schemas observed on first connection. Object-key
and tool-list order are canonicalized; string bytes, schema arrays and absent fields are not.
Changing a description, adding/removing a tool or changing a schema requires a new explicit user
decision before **any tool from that changed server list** executes.

## Contract

- CLI run/TUI always use `FileMcpPins` in `~/.agentrig/mcp-pins`. Identity is the canonical config
  file path plus exact configured server name, hashed into a filename. Commands, args and env
  secrets are not persisted. Changing a command under the same identity retains its old baseline;
  changing the config path/server identity is a new first use.
- First connection is **trust on first use**, including unattended connections: save the complete
  validated list and print a notice. This records what the user-configured server advertised,
  not a review or safety certification. Ordinary tool permission remains required.
- A changed list is advertised to the model but cannot execute until the user approves its exact
  before/after definitions. Notices name affected tools. The prompt includes both full definitions
  and SHA-256 list hashes; CLI stderr/TUI history render JSON-escaped server content as data.
  `--allow`, `--yolo` and skip-permission policy do not approve changed definitions. TUI standing
  answers do not apply and cannot be minted for these prompts. Unattended/no callback, denial,
  callback failure and cancellation fail closed.
- Re-list immediately before execution. If the result differs from what the model was shown,
  refuse and require reconnection; never execute an old advertised schema against a new list.
  After consent, re-list again before persisting approval. There is no automatic model-schema
  refresh, reinterpretation of inputs, or implicit approval of another change.
- Persist acceptance before calling the server. A short exclusive per-server lock plus CAS prevents
  stale concurrent reviews overwriting different approvals. Locks are not held while prompting;
  contention fails closed. Crashed lock directories are not stolen; stop all writers before
  operator recovery of the exact `.lock` path. Atomic rename preserves the previous complete pin
  on pre-rename failures. Pin files are bounded to 1 MiB and lists to 256 unique names. Corrupt,
  missing-during-execution and incomplete paginated lists refuse instead of resetting trust.
- MCP tools remain `exec`, no declared paths and unknown effects. Names, prose and server read-only
  hints never authorize. Host-started MCP processes remain incompatible with enforcing sandbox
  modes; no exception was added.

## Limits and SDK boundary

This is definition pinning, not binary signing, remote attestation, semantic input validation or
an OS boundary. A hostile server can lie about its behavior, return old definitions while doing
something new, or change between list and call; MCP offers no atomic definition-version-bound
call. First-use compromised definitions are not detected. Config identity relocation starts new
TOFU state. A same-user unsandboxed process can modify trusted state; untrusted project content
does not configure the CLI pin directory. Baselines contain server descriptions/schemas, which
may themselves contain sensitive text already exposed to the model.

`connectServers({ pins, onDefinitionChange })` exposes the same guard to SDK hosts. Omitting pins
is a deliberate trusted-host integration seam preserving the existing SDK; raw `McpClient.callTool`
and `mcpTool` remain trusted primitives, not an independent permission boundary. Approval is
reported through existing interactive diagnostics/tool failures, not a new raw event type.

## Verification

- Core tests cover canonicalization, exact delta receipt, first-use/persistence, all change kinds,
  no-human refusal, denied/failed/cancelled approval, changed-after-advertisement and changed-during-
  consent refusal, corruption, list caps, duplicate names, identity isolation and stale CAS.
- CLI tests run a real portable Node stdio MCP child and scripted provider through `buildAgent`:
  initial execution works; YOLO cannot bypass changed-definition refusal; explicit consent is
  persisted and used by the next session. An independent child-written call marker checks effects.
- TUI test proves exact delta rendering and that remembered permission grants neither satisfy nor
  outlive definition consent. Existing MCP transport, sandbox and permission tests remain applicable.
- Build, typecheck, full tests, two detected/restored negative mutations, one bounded independent
  review and exact-head Linux/macOS/Windows CI precede merge. Receipts are recorded on the PR.
