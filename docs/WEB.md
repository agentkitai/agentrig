# Local reference web client

```sh
agentrig web --host 127.0.0.1 --port 0
```

Open the printed URL manually and paste the separately printed **sensitive bearer**.
Enter an absolute project directory, then a task. The page streams literal output,
shows one-time permission choices and structured questions, and supports cancellation.
It uses the existing ACP server and controller, not another execution protocol.
One page/session is the reference UI; authenticated custom ACP clients may use the
existing eight-session bound. No file editor/browser, uploads, Markdown rendering,
automatic approval, raw-event display or hosted/daemon mode is included.

Only the exact `127.0.0.1` bind is accepted, with a decimal port 0–65535; zero chooses
an ephemeral port. IPv6, localhost, wildcard and external binds refuse. Existing
provider, permission, budget and sandbox flags apply. `--trust` applies only to the
canonical launch project; connecting does not trust another cwd or enable YOLO.
The page requests no MCP servers; custom clients retain ACP's configured/pinned stdio
matching and remote-MCP refusal. Prompts are literal text, not slash commands.

## Authentication and browser boundary

The 256-bit per-process bearer is required before an ACP connection is created. Do
not share it or capture startup output in public logs. It is sent in an offered
WebSocket subprotocol, never a URL, cookie, browser storage or selected response
protocol. The password field clears on connect; reconnect requires another paste.
Only the fixed `agentrig-acp-v1` protocol is selected. Exact Host and Origin checks
reject cross-site browser upgrades, including missing/null origins. No mutable HTTP
API or ambient cookies exist. Nonbrowser clients can spoof Origin, so Origin alone
is never authentication. Possessing the token authorizes a local client connection,
not project trust, tool permission or a claim that model prose is human consent.

Fixed assets expose no project files or credentials. CSP, no-store, no-referrer and
nosniff headers supplement literal `textContent` rendering. HTTP/WS is local plaintext;
OS processes, browser extensions/devtools and a compromised local browser remain
outside the boundary. This is not multi-user isolation or an OS sandbox.

## Bounds and shutdown

One authenticated connection owns the runtime while active **and closing**. Another
is refused until the prior ACP cleanup actually joins, including pending questions,
permissions, task work, MCP clients and telemetry. Disconnect and process signals
abort through that lifecycle; a slow close is not reported as task completion.
Arbitrary uncooperative trusted host code cannot be forcibly stopped and can retain
the closing slot. The normal Cancel task button waits for the final ACP response.

HTTP caps 16 sockets and 16 KiB headers. Header/request deadlines are configured at
five seconds (Node checks at one-second intervals); socket inactivity is also five
seconds. WebSockets use a 15-second ping cycle; a peer missing the next pong is closed.
Messages must be compact, single-line UTF-8 JSON ACP objects, at most 1 MiB; binary,
compression and multi-line/multiple-object frames refuse. Incoming queued payload is
bounded at 1 MiB and 1024 queued frames, outgoing payload at 4 MiB before Node/WS enqueue.
Existing ACP reservations remain held until the local WebSocket write callback;
that is not browser receipt or remote durability. Bounded encoding/parser overhead
is additional, not a total RSS guarantee. Slow/flooding peers may be disconnected.

The reference page retains at most 1 MiB/1000 displayed entries and announces when
older display is omitted. Stored logs are unchanged; the existing core replay buffer
is outside these added bridge/UI bounds. Pending browser RPCs are capped at 16.

See [R8d contract and verification](plans/R8d.md). Chromium is used only by the
test suite; users need a browser, not a Playwright installation or local framework.
