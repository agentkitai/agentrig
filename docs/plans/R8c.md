# R8c — optional bounded OTLP event subscriber

Contract recorded before implementation, from green main `6322139` (R8b #187;
[final receipt](https://github.com/agentkitai/agentrig/pull/187#issuecomment-5561447223)).
One roadmap row and PR; no additional milestone hierarchy or live evaluation spend.

## Scope and authority

`--otel-endpoint <url>` explicitly enables OTLP/HTTP JSON trace export. No flag means
no exporter, network access, service or new package dependency. No ambient OTEL/env
fallback and no config-only activation in this row. A fixed startup notice explains
that timing/status metadata leaves the process. No raw endpoint is printed.

The URL is an explicit traces endpoint, normally `/v1/traces`: HTTP(S) only, at most
2048 characters, no credentials, query or fragment, and no redirects. Plain HTTP is
unencrypted even on a non-loopback destination; document that deliberate operator
choice. Requests carry only fixed content headers, no ambient auth/cookies. Endpoint
validation and sandbox-network refusal happen before a session or endpoint access.
An enforcing sandbox without `network: true` refuses enablement; `--allow net` or
YOLO alone does not bypass it. No one-time sandbox escape is minted for telemetry.
None mode has no OS containment. This is explicitly authorized trusted-host
observation, not a model tool, permission grant or promise to isolate host JavaScript.

Shared builder wiring covers run/resume, TUI, ACP and MCP serving where the flag is
accepted. A small optional trusted session-observer seam reaches actual children and
descendants; observer failures do not fail task execution or mutate event order.
One process-owned exporter budget is shared across builds and children, not multiplied
per child. Explicit release/close paths join bounded export cleanup. No second loop,
new event variant or raw-log rewrite. CLI remains assembly around core logic.

## Mapping and privacy

Each observed session maps to a trace; each live run/resume segment has a root span,
each turn a child span, and each tool call a turn child (internal nested calls retain
their actual parent correlation). Call sequences disambiguate reused model IDs.
Forks/children have their own traces; do not infer or export cross-session authority.
Per-exporter random keyed trace IDs stay stable for a session during that exporter's
lifetime, including resume, without storing raw session IDs in exported attributes.
New exporter lifetimes deliberately get new trace identities; no persistent identity
cache. Implementation uses keyed derivation directly, retaining zero identity-map
entries (below the 1024-entry ceiling), so there is no identity-eviction cache.

Export fixed span names and allowlisted numeric/enum metadata only: sequence/turn
numbers, timestamps/durations, completion/denial/error/incomplete status, reported
main token counts plus explicit completeness, and permission class where recorded.
No task, prompt, content, tool input/output, command, file path, raw session/call ID,
tool/model/provider name, config, exception text, reason or endpoint credential.
No content opt-in switch here. Timing, counts and correlation remain sensitive
operational metadata; this is minimization, not anonymization or secret detection.

Missing terminal events produce explicit incomplete spans; they are not fabricated
success. Resume consumes only the new live segment, not a replay export of historical
events. Parallel completion order and actual internal checker correlation are tested.

## Bounds and lifecycle

- At most 128 active observed sessions and 1024 active spans total. Identity derivation
  needs no retained map. Drop/refuse additional observations with bounded counters.
- Added egress state is capped at 1024 completed spans /1 MiB, whichever comes first;
  batches at 128 spans /256 KiB; one in-flight HTTP request per process exporter.
  This accounts queued plus in-flight span payloads; bounded request/response encoding
  buffers add overhead. It is not a total process RSS ceiling.
- The event iterator pump never awaits network. Mapping retains only allowlisted
  bounded state, not raw events. Existing core `EventStream` keeps its shared replay
  buffer for all consumers; R8c does not change or claim to bound that preexisting
  storage. Added telemetry state alone is bounded.
- A request has a two-second total deadline covering headers and decoded body;
  response collection is capped at 64 KiB. Cancel the body on refusal/overflow.
- At most two attempts and 4.5 seconds per batch for network failures or 429/502/503/504, bounded
  backoff. Honor valid Retry-After only within the remaining shutdown deadline;
  otherwise drop explicitly. Partial success never retries. Other refusal, malformed
  or oversized responses do not retry. Never echo server diagnostic text.
- Close drains for at most five seconds, then aborts owned network and reports dropped
  counts. No late task changes, indefinite timer or unhandled rejection. Session work
  never waits for network; lifecycle shutdown may join only this bounded drain.
- Fixed safe notices/counters distinguish dropped, failed, partial and incomplete
  export. No claim of lossless telemetry or remote storage durability. Duplicate
  delivery remains possible after ambiguous transport failure/retry.

## Protocol and dependencies

Implement the bounded OTLP/HTTP JSON wire subset directly, with no OTel SDK/global
instrumentation or mandatory package. Resource/scope/spans follow official protobuf
definitions: lowercase-camel fields, hex trace/span IDs, numeric enums, decimal-string
64-bit nanosecond timestamps, `application/json`. This is a trace sink, not a complete
OpenTelemetry SDK, semantic-convention framework, metrics/logs exporter or propagator.

Primary sources inspected during read-only preparation:

- [OTLP specification](https://opentelemetry.io/docs/specs/otlp/): JSON encoding,
  HTTP traces endpoint, bounded responses, partial success and retry status rules.
- [Trace protobuf](https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/trace/v1/trace.proto).
- [Exporter specification](https://opentelemetry.io/docs/specs/otel/protocol/exporter/).

## Verification plan

Capture-buffer mapping and local HTTP collector fixtures only. Actual core sequential,
parallel, denial/error, cancellation, internal tool, child and resume paths; unchanged
pinned H6 logs. Actual CLI, TUI startup, ACP and MCP surfaces prove the flag reaches
their sessions; disabled and no-network-sandbox controls prove zero collector hits.
Secret canaries in all excluded fields must never enter request bytes or notices.
Held collector/body, oversized response, partial success, retry, redirect, queue/active
caps and close controls prove bounds without slow wall sleeps. Named mutations remove
privacy filtering or a runtime gate/cap and must fail before restoration.

One bounded Claude review, material fixes and preserved original verdict/findings;
build/typecheck/full Docker suite; integrate current main and pass Linux/macOS/Windows
plus scripted-structure at exact head. Root alone merges and records post-main gates.

## Implementation checkpoint before review

Twenty focused controls pass: actual run/TUI/ACP/MCP, child and same-session resume,
denial, cancellation, real post-edit checker nesting, fixed metadata allowlist,
shared lifetime/capacity, startup refusal and local HTTP response/bounds controls.
Pinned H6 and sequential traces also pass unchanged. Initial typecheck before the
fresh worktree's first build lacked workspace declarations; build then typecheck pass.
An initial test imported obsolete `@harness/core` from the older CLAUDE convention;
the actual published package name fixed the fixture, with no production change.

Actual denial control initially found no span because a denied request intentionally
has no `tool.call`. Mapping now marks a zero-duration refused attempt; it does not
add a call to the canonical log. An interrupted observation is marked incomplete.

Named mutations detected and restored: adding raw `session.start.task` as an attribute
fails `maps actual parallel ... excludes all content` on `SECRET_TASK`; dropping the
in-flight count gate fails `counts in-flight payload ...` with 1030 vs 1024 spans.
The held-body fixture retains cleanup even on assertion failure. No live providers
or remote collectors used. Independent review and final integrated full gates follow.
