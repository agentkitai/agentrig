# R8c independent review — original record

Frozen snapshot `160ffd2` against green base `6322139`. Session
`088c010d-0f2c-4b05-8aca-25c1b325c852`; one invocation requested 24 turns,
reported 26, completed with `Approve with fixes`. Model `claude-opus-5`;
reported list-price USD 2.226773, not a subscription billing claim.
Two compound typecheck/redirection commands were denied; a subsequent permitted
invocation passed. Independently executed 20 focused +125 related tests and
four-package typecheck. No edits, providers, remote collectors or subagents.
Findings F1/F2/F3 were code-reading inferences, not independently reproduced.

## Original final response (verbatim)

## Verdict

**Approve with fixes.** I found no privacy leak, no authority bypass, no unbounded growth, and no OTLP encoding defect. One lifecycle defect (F1) is worth fixing before merge; the rest are accuracy/hygiene.

## Findings

**F1 — medium-high · telemetry shutdown fails unrelated sessions · `packages/cli/src/otel.ts:11`, `:27`**
`acquireOtel`'s close sets `owner.closing = true` *before* `await owner.sink.close()` and only clears `shared` in the trailing `finally`. `validateOtel` throws whenever `shared.closing`, and `buildAgent` calls it as its first statement (`agent-builder.ts:446`). So for the whole drain window — pump join plus up to `closeMs` 5 s — any new build throws `OTLP exporter unavailable: one endpoint and at most 128 live owners per process`. Failure scenario: ACP `session/new` (`acp.ts:63`) or MCP `run_task` (`mcp-serve.ts:70`) arriving while the previous session's telemetry drains a slow/hung collector → session creation or the tool call fails outright. That contradicts `docs/plans/R8c.md:26` ("observer failures do not fail task execution"), and it is worst exactly when the collector is unhealthy. Not covered: `packages/cli/test/otel.test.ts:62-72` builds `second` *before* closing `first` and builds `third` only *after* awaiting the close, so the window is never exercised.

**F2 — medium · OTLP partial-success mapping · `packages/core/src/otel-exporter.ts:100`**
`if (parsed.data.partialSuccess !== undefined) this.counters.partial += count;`. The trace-service contract states a `partial_success` with `rejected_spans == 0` and empty `error_message` is equivalent to the field being unset and should be read as full success, and servers may set it with `rejected_spans = 0` purely to carry a warning. A collector answering `{"partialSuccess":{}}` therefore turns a fully-accepted export into `exported=0, partial=N` in the operator notice (`cli/src/otel.ts:31`). Separately, an actual partial counts the *whole* batch as partial, so `exported` under-reports by up to 127 spans per batch. The tell is `rejectedSpans` being parsed at `:23` and never read.

**F3 — low-medium · empty 200 body counted as dropped · `packages/core/src/otel-exporter.ts:89-99`**
A `200` with `content-type: application/json` and a zero-length body yields `parts = []` → `JSON.parse("")` → SyntaxError → non-retryable, `failed++` and `dropped += count`. Spec-strict (OTLP does require a body), but collectors/proxies that answer 200 empty cause accepted spans to be reported as dropped in the shutdown notice.

**F4 — low · dead limit · `packages/core/src/otel-exporter.ts:4`**
`identities: 1024` in the frozen `OTEL_LIMITS` is never referenced; the design intentionally has no identity map (`R8c.md:40-41`). A named cap no code enforces will mislead the next reader.

**F5 — low · new throw site after MCP startup · `packages/cli/src/agent-builder.ts:670`**
`acquireOtel` is the last statement of `buildAgent` and re-runs `validateOtel`, so it can throw after MCP clients are spawned. Every call site guards with `built?.mcp ?? []` (`acp.ts:93`, `mcp-serve.ts:69`), and `built` is `undefined` on throw, so those child processes leak. Pre-existing shape, newly reachable. Also `await built.closeTelemetry?.()` at `run.ts:516` and `tui/start.tsx:214` is unguarded, unlike the adjacent `server.close().catch(() => {})`.

## Verified clean (checked, not assumed)

- **Privacy.** Exported attributes are only `agentrig.seq/turn/usage.*/outcome/permission/phase`. `outcome` draws from `session.end.reason` (`z.enum(["done","aborted","error","budget"])`, `events.ts:228`) plus fixed literals; `permission` is `PermissionClass` (`events.ts:272`). `traceId` is HMAC-SHA256 over `session.id` under a per-sink `randomBytes(32)` key truncated to 16 bytes; the `ids` correlation map is keyed by hashes and never exported. `model.response.usage` is required (`events.ts:241`), so `e.usage.input` cannot throw.
- **OTLP encoding.** Hex (not base64) trace/span IDs — the classic JSON gotcha, handled; decimal-string `intValue`; decimal-string nanoseconds; numeric enums; `service.name` resource attribute; correct `resourceSpans/scopeSpans/spans` nesting; `redirect: "manual"`; fixed `content-type`/`accept` only, no auth or cookies; non-200 and oversized bodies cancelled.
- **Bounds.** `push` decrements `bytes`/`count` only in `pump`'s `finally` (`otel-exporter.ts:63`), so the 1024-span/1 MiB cap really does account in-flight payload. `activeSpans` lives on the sink, so parent and children share one budget. `close()` re-reads `this.active` after the `.finally` restart, so the drain isn't cut short, and the 5 s `stopped.abort()` bounds it; the per-request abort covers headers *and* body read (timer cleared in the outer `finally`); response read capped at 64 KiB with `reader.cancel()`; Retry-After beyond the remaining batch deadline drops rather than sleeps.
- **Gating.** `packages/cli/src/config.ts` is `.strict()` with no `otelEndpoint` key, so config-only activation fails; the env/config controls at `cli/test/otel.test.ts:41-51` prove both are inert. Sandbox refusal fires at `buildAgent`'s first statement, before provider/session/network work; `--allow net` and YOLO don't bypass.
- **Entrypoints.** `--otel-endpoint` is on `withRunOptions` (`program.ts:226`), applied to `run` (:331), `acp` (:367), `mcp-serve` (:375), `sessions resume` (:648), `tui` (:727); `RunOptions`/`AcpFlags` extend `AgentBuildOptions` and are passed whole. `closeTelemetry` is joined on all five paths.
- **Resume/children.** `runSession` reuses the resumed id (`agent.ts:281`) → stable traceId within an exporter lifetime, new root span per segment, no historical replay exported. Children get `observeSession` via `childConfig`, own trace.
- **Observer isolation.** `agent.ts:263` wraps observation in `try` + `.catch`; tests confirm a throwing and a rejecting observer leave the JSONL log byte-identical.

## Tests actually run

- `pnpm typecheck` — 4 packages, pass.
- `pnpm exec vitest run packages/core/test/otel.test.ts` — 14 passed.
- `pnpm exec vitest run packages/cli/test/otel.test.ts` — 6 passed (20 total, matching the STATUS claim).
- `pnpm exec vitest run packages/core/test/{h6-trace,agent,parallel-strategy}.test.ts packages/cli/test/{mcp-serve-runtime,acp-server}.test.ts` — 125 passed, so the `createAgent` wrapper didn't regress pinned traces or the ACP/MCP surfaces.

All fixtures bind `127.0.0.1` only; no provider, no remote collector, no agents spawned, no files edited.

## Limitations

- F1, F2 and F3 rest on code reading, not execution — I created no scratch test file, so none is reproduced empirically. The paths are short and unambiguous, but treat them as unverified-by-run.
- Did not run `pnpm build`, the full suite, or the Docker/multi-OS gates; Linux/WSL2 only.
- Per scope: no review of inherited core replay buffering, metrics/SDK/framework concerns, or R8a/R8b internals beyond their telemetry hooks.
- Reviewed `160ffd2` against `6322139` only; no assessment against main at 188.

