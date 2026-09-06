# R8d — authenticated loopback reference client

Approved contract recorded before implementation, from green main `b3bb06a` (R8c
#192, CI `34060311037` and structure `34060311027`, all four root-verified green).
One row, one review, one PR; no new milestone hierarchy or live-provider spending.

## Operator and authority

`agentrig web --host 127.0.0.1 --port <0..65535>` runs in the foreground; defaults
are the literal IPv4 loopback address and an ephemeral port. Every other host spelling,
including localhost, IPv6 and wildcard addresses, refuses before binding. No daemon,
automatic browser launch, hosted service, framework or project filesystem server.
Existing appropriate run flags, budgets and sandbox/trust configuration reach ACP;
web mode never implies YOLO. The CLI displays its exact local URL and a random 256-bit
bearer once for manual paste. This explicitly sensitive operator output is never
persisted or placed in session logs, telemetry, URL, cookies or browser storage.

Only fixed compiled HTML/JS/CSS assets are served, through exact GET/HEAD paths.
No path decoding/traversal, queries, arbitrary cwd assets, mutable HTTP API or CORS.
Assets contain no token, project path/config or session content. Require one exact
canonical HTTP Host (`127.0.0.1:<bound port>`, except default port 80 is omitted) on
all requests; duplicate/missing/alternative Host refuses.
Forwarded headers cannot supply authority. Upgrade only `/acp` with one exact Origin
canonical HTTP origin; absent, null and cross-origin values refuse.

Before creating ACP streams/controllers, require the fixed `agentrig-acp-v1` and
`bearer.<base64url secret>` offered subprotocols. Compare a fixed-length secret in
constant time and select/echo only the fixed protocol, never the bearer. The browser
clears its password field on connect; credentials exist only in live browser memory.
No cookies means no ambient cookie-CSRF flow. Origin is browser protection, not
authentication against a nonbrowser that can spoof it; bearer possession is required.
Local OS/browser compromise, devtools and extensions are outside the containment
claim. HTTP/WS remains local plaintext. Use no-store, nosniff, no-referrer, restrictive
self-only CSP, frame-ancestors/base-uri/form-action none; no inline event handlers,
eval or HTML/Markdown rendering of agent text.

## Protocol and UI

A bounded text-frame adapter plugs into actual `startAcp(input/output)`, retaining
official SDK validation, ACP preflight, server, controller, questions, permissions,
provenance, canonical per-session trust and cleanup. Exactly one UTF-8 ACP JSON object
per WebSocket message; no binary or compression. No auth RPC or second execution
protocol. One authenticated **connection**, not a claim of one ACP session: the page
uses one session, while custom clients retain ACP's existing eight-session cap.

The user supplies an absolute cwd; no process.chdir or blanket trust for arbitrary
cwd. Authentication never grants project trust, execution permission or model/user
authority. Client text uses existing literal ACP prompts, not slash commands. No
provider/config overrides. Existing configured/pinned stdio MCP matching and ACP's
remote-MCP refusal remain; the page requests no MCP servers.

The page has connect/disconnect state, cwd, task/send/cancel, literal streamed reply
and tool status, explicit supplied permission choices with semantic effects, and
negotiated structured question options/free text. No automatic approvals, grant
synthesis, file editor/upload, project browser, arbitrary links or hidden actions.
Late/duplicate/wrong-ID answers cannot widen authority. Raw sensitive events stay
off; no separate memory/supervisor/debug UI. Completion follows ACP's final response
after updates; cancel stays pending until runtime settlement.

## Ownership and bounds

- One authenticated socket, including startup and closing. Reject replacements until
  the prior actual ACP done promise joins cleanup, not merely until its socket closes.
  Disconnect denies pending prompts and aborts/joins owned task/MCP/telemetry work.
  Uncooperative trusted host code cannot be forcibly stopped; its closing slot stays
  unavailable rather than falsely reporting completion. Signals stop acceptance and
  follow the same join path.
- HTTP: at most 16 sockets, 16 KiB headers, five-second header/request idle deadlines,
  fixed small refusal responses. Only fixed asset buffers, never a generic filesystem.
- WebSocket: max message 1 MiB including fragments; no compression/binary. Bounded
  heartbeat/dead-peer cleanup. Added inbound queued payload at most 1 MiB, outbound
  at most 4 MiB including queued/in-flight payload. Account before enqueue and release
  only on actual consumption/write callback or closure, not high-water-mark promises.
- Existing ACP four-MiB pre-SDK reservations remain held through the output Writable
  callback after WebSocket send callback. Verify public ws callback semantics and
  stalled peer behavior before claiming this interaction. Framing buffers/encoding
  add separately bounded overhead; not a total RSS or remote receipt guarantee.
- UI transcript: at most 1 MiB/1000 entries, explicit older-display omission notice,
  immutable stored logs unchanged. At most 16 client RPCs; responses correlate to
  live IDs, no implicit default permission/question answer. Original shared core
  EventStream retention remains outside this row's added-state bounds.

## Dependencies and verification

Exact public `ws@8.21.3` runtime transport, no optional native accelerators; exact
dev-only `playwright@1.63.0` and Chromium smoke in the existing Linux CI test job so
there remain four named gates. Browser binaries are test infrastructure, not runtime
requirements. Node HTTP/WS controls run on all three platforms.

Real HTTP and WS tests cover Host/Origin/token (including missing/null/duplicate),
non-loopback refusal before builder creation, malformed/binary/oversized/flood input,
blocked output, exclusive closing ownership, cancellation and startup failure. Actual
fake-provider/controller tests prove permission deny prevents a sentinel, explicit
allow_once permits only its requested tool, structured answers preserve provenance,
and external material cannot mint grants. Real Chromium loads served assets, submits
a task, sees streaming, answers permission/question and cancels. Script/handler/link
canaries stay literal and cause no execution or outbound request. Existing ACP/H6
and telemetry unchanged-log controls remain. Named auth/origin/queue mutations must
fail then restore. One bounded Claude review with verbatim findings/material fixes;
build/typecheck/full Docker plus exact-head Linux/macOS/Windows/structure gates.
Root alone merges after current-main integration and records post-main gates.

Primary sources inspected during approved read-only preparation:

- [RFC 6455](https://datatracker.ietf.org/doc/html/rfc6455), particularly 10.1, 10.2,
  10.4: nonbrowser/Origin limitations and implementation-specific resource limits.
- [Public ws API](https://github.com/websockets/ws/blob/master/doc/ws.md): upgrade,
  protocol selection, maxPayload, send callback and connection termination.
- [Browser WebSocket constructor](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/WebSocket):
  protocol offer mechanism; no arbitrary Authorization header API.

No source implementation or browser test results are claimed by this initial contract.

## Implementation checkpoint

The public ws 8.21.3 sender forwards its send callback to the last local socket.write;
the bridge's callback preserves ACP reservations through that completion, not peer
receipt. A controlled callback barrier proves a real ACP response still holds its
131,072-byte reservation even after peer receipt. A separate real paused-peer fixture
proves pre-enqueue output capacity and exactly-once callbacks. Incoming frames are
compact single-line JSON and additionally capped at 1024 queued messages. HTTP
deadline checks run at one-second intervals alongside five-second idle limits.

Fifteen Node HTTP/WS/actual runtime controls and one real Chromium smoke pass. The
browser test covers explicit write approval, structured answer, streamed hostile text
remaining literal without DOM injection/network, and joined cancellation. Chromium
runs explicitly inside the existing Linux job, not a skipped or fifth check.

Named negative mutations detected and restored: bypassing bearer comparison and
bypassing Origin each fail with `Untrusted connection accepted`. Removing the outgoing
byte cap initially failed only by timeout; the fixture was strengthened with an actual
admission barrier. Repeating that mutant now fails the measured queue assertion:
5,400,390 bytes exceeds 4,194,304. The original weaker result is not called a direct
capacity proof. Restored focused and Chromium suites pass. Initial fixture parse typo
ran no tests; the source's initial Duplex/Socket typing mismatch failed build and was
corrected without runtime widening. No live providers or remote collectors were used.

Pre-review build/typecheck and Docker-required full suite pass **2,908 tests plus
two existing skips, 179 files, four workers**. The explicit real Chromium lane also
passes its one smoke test. Independent review and exact-head all-four CI follow.

## Independent review and bounded closure

One frozen review of `9bd018c` against `b3bb06a` returned **APPROVE WITH FIXES**;
24 turns requested, **37 reported**, session `a11514ce-4195-4b2b-9e6d-bf169c508be8`.
The reported list-price estimate was USD 3.0642035, not a subscription billing claim.
[Original final response, verbatim](R8d-review.md). It independently passed 15 Node
tests, one real Chromium smoke and four-package typecheck; it did not run build/full
Docker. Three standalone/version probes were denied, not executed:

```text
node -e "console.log(require('/home/amit/agentrig/.claude/worktrees/r8d-web-client/node_modules/ws/package.json').version)" 2>/dev/null; ls node_modules/.pnpm | grep -i -E '^(ws@|playwright@)'
node -p "require('./node_modules/ws/package.json').version"
pnpm exec tsx -e "import('/home/amit/agentrig/.claude/worktrees/r8d-web-client/packages/cli/src/web.ts').then(m => console.log('loaded', typeof m.serveWeb, m.WEB_LIMITS))"
```

- F1 was an untested assumption, not a confirmed idle disconnect. The new actual
  authenticated ACP test idles seven seconds with real Node timers, then completes
  a prompt. Removing our timeout clear **survived**: public ws 8.21.3 itself clears
  the timeout at websocket.js:247. A separate mutation reattaching a five-second
  timeout after upgrade fails CLOSED(3) versus OPEN(1). Restored behavior passes;
  this does not claim our redundant clear fixes a preexisting bug.
- F2 is an author-confirmed default-port interoperability defect. A real HTTP/WS
  fixture injects only the advertised port 80 while binding an ordinary ephemeral
  port (no privileged CI bind). Canonical browser Host initially failed 403 versus
  200. Deriving canonical HTTP authority fixes it; exact Host/Origin matching remains,
  and explicit noncanonical `:80` spelling still refuses. These are author tests,
  not reviewer reproductions.
- F4 now has a 1025-small-frame control independent of byte capacity. A following
  ping is an ordered receive barrier. Removing the count cap fails `pong` versus
  `closed`; restored behavior passes without a timeout-only oracle.
- F3 CLI wording and hypothetical F5 future permission kinds/F6 `end(chunk)` use
  are optional follow-ups at the literal roadmap end. The current server offers
  only once choices and ACP writes/destroys this adapter, never `end(chunk)`.
  F7 uncooperative-host/second-interrupt behavior is the existing explicit joined
  ownership limitation, not a new forced-cancellation promise.

No second general review or library edits. All named mutations are restored.

Post-fix build and typecheck pass. Full Docker-required validation passes 2,911
tests plus two existing skips across 179 files (four workers, 61.36 seconds);
the separate real Chromium smoke passes. These are author-run checks.
