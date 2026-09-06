# R8b — bounded MCP serving

Status: implementation started from green main `0493b09` (R8a #184).

## Approved contract

`agentrig mcp-serve` serves exactly `run_task`, `list_sessions`, `read_session`,
and `memory_search` over stdio. Exact official SDK server 2.0.0 owns modern
2026-07-28 discovery/envelopes and legacy initialize compatibility; actual existing
2024-11-05 core-client interoperability is required. A bounded public Transport
adapts the existing NDJSON framing approach, not a second protocol engine.

One fixed canonical launch project supplies trusted configuration. Clients cannot
choose cwd, provider, credentials, policy, child configuration or arbitrary paths.
Tasks are advisory external input, never automatically fresh human authority.
Configured permission decisions remain effective; unresolved asks, sandbox escape,
and external-input expansion refuse without a human approval channel. Existing
configured MCP definitions require unchanged operator-established pins. No new pin
or execution consent is created by serving or by a tool request.

One live task at a time reuses the actual headless TuiController and agent builder.
Task input is at most 64 KiB; default ceilings are 20 turns, 8192 main-model tokens,
and a 120-second cooperative deadline. Smaller configured/per-call limits win.
Existing auxiliary accounting/limits remain separate: this is not a total remote
billing cap, nor a hard timeout of uncooperative trusted host code.

Read tools require configured read allowance (ask denies). Session listing scans
at most 4096 directory entries and returns at most 100 metadata records, without
host paths. Session reads use validated IDs and the existing bounded redacted
export with opaque content omitted; at most 256 KiB, otherwise explicit refusal.
Memory retrieval uses only the configured local store: query 4096 characters,
512 scanned entries, depth eight, 256 KiB/file, 2 MiB total, eight hits. No remote
Lore, raw event export, maintenance or client-selected files. Returned information
is sensitive; heuristic redaction is not a complete secret-removal guarantee.

Transport limits: 1 MiB UTF-8 NDJSON frame, 16 pending RPCs, 8 MiB admitted input,
4 MiB queued/reserved output, and 256 KiB tool payloads. Pre-SDK reservations cover
schema/unknown-method errors as well as successful responses. Errors are bounded
and nonreflective. Reservations survive until physical write, or cancellation
plus actual handler settlement, or connection close; neither a cancel notification
nor SDK handler return alone releases them. Duplicate IDs, batches and overload
fail closed. No streaming notifications, raw events or outbound client requests.

Cancellation aborts and joins the owned controller/runtime before reusing its slot;
cancelled requests produce no subsequent result. EOF/signal joins all owned cleanup.
SDK connection closure alone is not proof of runtime quiescence.

Implementation bounds additionally cap notifications at 64 per connection and
retire cancelled IDs, keeping late responses from borrowing a new reservation.
Transcript text caps at 120,000 bytes before nested JSON framing. Schema/unknown
tool validation uses the same Zod schemas before SDK dispatch to avoid SDK error
content reflecting hostile names/keys. Standard JSON Schema is adapted through
the pinned Zod public converter, without an unrelated dependency migration.

Actual official modern-client cancellation found SDK 2.0.0's `_oncancel` ignores
numeric ID zero (`if (!notification.params.requestId) return`). The first actual
client tool request is ID zero and the unmodified handler never saw abort. The
bounded public transport now owns per-admitted-ID cancellation, combined with the
SDK signal; the exact fail-before/pass-after control includes cleanup retention,
no late result, and subsequent connection usability. No SDK/private patch was used.

## Plan and verification

1. Install exact public SDK and implement bounded transport/server registration.
2. Wire fixed-project configuration and actual controller; implement bounded reads.
3. Exercise official modern and existing legacy clients, actual built CLI and local
   fake provider, permission/provenance refusal, limits, cancellation and joins.
4. Named negative mutations, one bounded Claude review, material fixes only.
5. Build, typecheck, full Docker-enabled tests, current-main integration, one PR;
   all three platform jobs plus scripted-structure green. Root merges and checks main.

ACP server is not changed. R15a owns question delivery; R15d owns remote MCP client.
R8b does not implement either surface or a new approval mechanism.

## Primary sources

## Verification checkpoint (before independent review)

- Build/typecheck passed; full Docker-enabled suite: 2769 passed, two existing
  skips, 166 files, four workers, 51.48 seconds. Later small close/error-listener
  hardening and stronger negative assertions will receive final integrated checks.
- Eleven focused tests pass: official modern SDK and existing 2024 core client
  through built CLI/local HTTP provider; actual configured allow/deny and advisory
  execution restrictions, bounded reads, cancellation/EOF join and transport caps.
- Advisory-to-fresh-text mutation is detected by a real shell result (one vs zero).
  First mutation attempt restored before the test loaded and passed: invalid
  evidence, rerun correctly. An earlier assertion order caught metadata first;
  final order now proves actual dispatch discrimination.
- Raising the pending cap to 17 fails the actual SDK blocked-stdout control
  (17 retained vs zero after fail-closed overload). Initial version failed only
  by timeout; a stronger immediate state assertion now identifies the violation.
- All mutations restored. Numeric-zero cancellation has its separate actual
  fail-before/pass-after receipt above. No live provider/evaluation calls.

## Primary sources

- https://modelcontextprotocol.io/specification/2026-07-28
- https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio
- https://modelcontextprotocol.io/specification/2026-07-28/server/discover
- https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- https://modelcontextprotocol.io/specification/2024-11-05/basic/lifecycle
- https://github.com/modelcontextprotocol/typescript-sdk

The exact server 2.0.0 public declarations expose `serveStdio(factory, { transport,
legacy })` and `Transport`. No private imports or independently invented negotiation.
