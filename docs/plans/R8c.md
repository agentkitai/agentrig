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
entries, so there is no identity-eviction cache or unused retained-map limit.

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
  backoff. Honor valid Retry-After only within the remaining batch and shutdown deadlines;
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

## Review and material fixes

One read-only Claude Opus 5 review of frozen `160ffd2` versus `6322139` requested
24 turns and reported 26, with verdict **APPROVE WITH FIXES**. It independently ran
145 focused/related tests and typecheck, not the full suite or multi-platform CI.
Two compound command forms were denied before permitted individual checks ran.
The reported list-price estimate was USD 2.226773, not a subscription billing claim.
[Original final findings, verbatim](R8c-review.md). No second review was requested.

- F1: an actual held local collector reproduced a new build failing while the prior
  exporter drained. Availability now soft-omits observation for that build, with a
  fixed notice; its real task completes. The same bounded behavior applies to owner
  capacity and different-endpoint contention. No second sink or endpoint substitution
  occurs. Invalid endpoint/sandbox configuration still fails pre-session.
- F2: an actual collector returning empty `partialSuccess` reproduced incorrect
  accepted-span accounting. Exact rejected-span counts now separate acknowledged
  accepted and rejected spans; empty/warning-only zero rejection means full acceptance.
  Empty, warning-only and one-rejected-span controls pass without partial retries.
- F3: an empty HTTP 200 body remains an invalid JSON acknowledgement under this
  deliberately strict subset. This is not evidence that the collector stored nothing.
  Optional compatibility treatment is at the roadmap end, not a delivery blocker.
- F4: removed the unused retained-identity limit; keyed derivation retains no map.
- F5: the suggested MCP startup leak was not reproduced: the existing enclosing
  builder `assemble` catch already closes started MCP clients on a late acquisition
  error. A real Node MCP fixture mutates trusted endpoint options after startup and
  verifies that rejection joins process cleanup. Its initial first-use approval-hook
  fixture assumption was incorrect; the corrected first-use notice triggers the
  intended late failure. No new cleanup guard is claimed. Separately, telemetry close
  errors now remain observational and cannot replace the task outcome.

F1/F2 reproductions and fixes are author evidence, not reviewer reproductions. Both
failed before and passed after the repairs; an initial malformed Vitest invocation
ran no tests and is not evidence. The original privacy/capacity mutants remain restored.
Post-fix build, typecheck and Docker-required full suite pass: **2,817 tests plus two
existing skips, 170 files, four workers**. The 23 telemetry controls exercise actual
core, CLI/TUI/ACP/MCP and local HTTP paths. No live provider or remote collector spend.
At that checkpoint, integration awaited the separate post-R15a test-readiness
repair's green main gate; all four exact-head CI checks remained pending.

That gate is now released: integrated main `3174475`, containing R15a and test-only
repair #191, passed CI `34056045886` and structure `34056045804` on all four checks.
Question handlers, ACP/controller wiring and telemetry observers are retained together;
no second general review for this mechanical integration. Combined build/typecheck
and Docker-required full suite pass: **2,846 tests plus two existing skips, 173 files,
four workers**. This includes unchanged pinned logs, telemetry privacy/bounds and
actual question/TUI/ACP controls. Exact-head CI remains pending.

The first PR head `24eaf57` passed all four checks (CI `34056787349`, structure
`34056787376`). Subsequent integration of green R15d main `8da49d4` retains remote
MCP lifecycle and its independent network-policy checks alongside telemetry preflight.
The actual remote skill/provider/storage/resume fixture now also exports to a local
OTLP endpoint: no-network refuses before either endpoint is hit; remote content stays
external and cannot authorize exec, never enters telemetry, and both owned lifetimes
close. This is focused integration evidence, not another broad review.
Combined build/typecheck and Docker-required full suite pass **2,877 tests plus two
existing skips, 177 files, four workers**. New exact-head CI follows this integration.

Final queued integration includes R15f main `887fef8`, all four post-main checks green
(CI `34058784223`, structure `34058784219`). The actual built `run --ci` subprocess
control compares telemetry disabled versus a local collector returning HTTP 500:
both finish with successful task/report outcomes, process cleanup joins, and collector
error text/task content never leak across the reporting boundary. No second review.
Final combined build/typecheck and Docker-required full suite pass **2,893 tests plus
two existing skips, 178 files, four workers**. All four updated exact-head CI gates
remain pending before root merge.
