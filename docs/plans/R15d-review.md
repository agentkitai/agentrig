# R15d independent review receipt

One frozen review of `197ca01251357fa1b015ab55012e9b348ffcc30f` against `eead687`.
Claude session `8b4b461a-b496-4973-ad22-16329297624b`, 407.218 seconds, exit 0.
Requested `--max-turns 24`; returned metadata reports **53 turns**. This is not a claim
that the turn or spend cap was enforced. Outer timeout was 600 seconds. Two compound
SDK-location/read shell commands were denied; source was subsequently inspected through Read.
The reviewer ran no tests. No second broad review after fixes or integration.

## Original result (verbatim)

**Verdict: REQUEST_CHANGES** (two narrow fixes; the security contract itself checks out).

## Material findings

**1. Medium, verified by reading. One remote server's stale credential file aborts the whole agent startup.**
`packages/cli/src/agent-builder.ts:511-512` runs `await oauth?.load()` for every remote server *before* `connectServers` and outside its per-server try/catch. `McpOAuthProvider.load()` throws on a changed issuer or client ID (`packages/core/src/mcp/auth.ts:100-102`), on a refused redirect binding (`auth.ts:106-107`), and `McpCredentialStore.read()` throws on any non-ENOENT problem, including a symlinked `~/.agentrig` (`auth.ts:59`). Any of these makes `buildAgent` reject, so `agentrig run` and the TUI fail to start at all, and this happens before the startup network consent prompt. That contradicts the fault-isolation contract restated in `packages/core/src/mcp/tools.ts:147-149` ("a server that fails to start costs its own tools and nothing else") and the existing stdio behavior. Reproduction: configure one working stdio server plus one remote OAuth server, then change `oauth.issuers` in config after a login; the run refuses entirely instead of reporting the remote server unavailable. Narrow fix: perform `load()` inside `RemoteMcpClient.start()` after `authorizeStart`, or wrap the call per server and route the failure to `onHookError` while skipping only that server. The credential-preservation property ("invalid/changed issuer preserves prior secrets") does hold.

**2. Medium, high-confidence but not executed. Stdio servers advertising `resources` but not implementing `resources/templates/list` are now refused entirely.**
`packages/core/src/mcp/client.ts:87-90` issues `resources/templates/list` whenever the initialize result claims the `resources` capability, and `packages/core/src/mcp/remote.ts:88` does the same for HTTP. Resource templates are optional under the resources capability, and hand-written servers commonly answer that method with JSON-RPC -32601. That error rejects `catalog()`, `connectServers` treats the server as failed, and its tools that worked on main disappear. The fixtures in `mcp-remote.test.ts:26` and the runtime test always answer templates, so nothing covers this. This is the one place I see the "local stdio remains compatible" claim at risk. Narrow fix: treat a method-not-found error on `resources/templates/list` as an empty template list (still pinned as empty) and keep every other error refusing the server.

## Optional polish (not blocking)

- **Bound inconsistency.** `catalog()` is one owned operation (`remote.ts:83`), and each owned operation allows 16 HTTP requests (`http.ts:55`). Four lists at up to 20 pages each can never reach the documented 20-page bound; a server needing more than roughly 16 pages total is refused. Either document the effective bound or run each list as its own owned operation.
- **ACP note.** A stdio server that already had a v1 tools-only pin and also advertises resources or prompts now snapshots as v2 (`tools.ts:166-167`), so an ACP session with `requireExistingPins` refuses until the CLI re-approves. This matches the plan's "newly exposed definitions require separate consent" wording, but R15d.md's stdio compatibility sentence should say so.

## Verified as correct (against SDK 2.0.0 source in the worktree)

- `callTool` with `toolDefinition` never consults the SDK cache and skips the HeaderMismatch evict/relist/retry path (SDK `index.mjs:4105`, `4135`); mirrored headers are only `mcp-param-*`, so schema annotations cannot set auth or session headers. Admission checks in `remote.ts:127-148` run before pinning.
- Exactly one 401 refresh and retry per send (SDK `index.mjs:5103-5121`); non-interactive refresh cannot register, open a browser, or expand scope (`auth.ts:118`, `134-138`, `145-146`, `153`), and `invalidateCredentials` throws instead of discarding stored secrets.
- Discovery endpoints, resource indicator, token issuer and redirect binding are all checked against configuration (`auth.ts:155-175`); bearer tokens never leave the endpoint href (`http.ts:75-76`); redirects, non-loopback HTTP, query strings and credentials in URLs are refused.
- Raw OAuth and SDK error text is masked in `remote.ts:59-64` and `auth.ts:218`; the OAuth test asserts `error_description` does not escape.
- Startup requires an explicit `net` decision before the first request, headless defaults to deny, and enforcing sandboxes require `--sandbox-network` (`agent-builder.ts:461-462`, `514-517`). Remote tools claim `sandbox: "compatible"` on the same basis as `web_fetch`, with README wording that says trusted host HTTP, not containment.
- ACP `matchAcpMcp` rejects remote entries and remote client requests (`acp.ts:37`); `requireExistingPins` and CAS semantics in `tools.ts:171-186` are unchanged.
- Resource and prompt results are `resultSource: "external"`, and the CLI runtime test shows the trust label surviving provider request, snapshot, resume and compaction, with YOLO unable to authorize the post-external bash call.

## Verification limits

Read-only review of source, tests and the vendored SDK. I did not execute any tests in this session (the shell was restricted to read tools), so finding 2 rests on the code path and spec reading, not on an observed failure. No live OAuth, network or model calls were made, and no credentials were read.

## Author disposition

Both material findings reproduced before production fixes. The actual CLI builder with a
working stdio child and malformed remote credential file failed; modern/legacy HTTP template
controls failed (3 failures, 16 passing controls). The stdio wire control separately failed
(1 failure, 30 passing controls). After fixes the three files passed 50 tests.

1. Credential load now occurs inside the owned per-server startup after network authorization.
   Denied startup does not read credentials. Malformed bytes remain untouched, unrelated stdio
   tools execute, and diagnostics contain no secret bytes.
2. Only the first optional `resources/templates/list` page's exact JSON-RPC -32601 becomes an
   empty pinned list. Typed stdio/SDK protocol errors retain the code. SDK 2.0 exposes modern
   HTTP404 as public `SdkHttpError`; its already-bounded JSON body must validate as a -32601
   error envelope, not generic HTTP404 or prose. Other codes and partial lists still refuse.
   Actual modern/legacy HTTP and stdio controls discriminate these paths.

Spec check: both [2026 resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources)
and [2025 resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources)
describe resource templates separately; the modern capability explicitly requires resources/list.
The [modern HTTP binding](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
uses HTTP404 plus JSON-RPC -32601 for an unimplemented method. Mapping this optional endpoint
to an empty list is our narrow compatibility policy, not a claimed normative client MUST.

Optional documentation corrections included: effective 16-total-request catalogue cap is
stricter than each 20-page ceiling; newly exposed stdio resources/prompts require v2 consent
before ACP's require-existing-pins mode accepts them. No broader behavior change.

