# Optional OTLP traces

```sh
agentrig run "inspect the project" --otel-endpoint http://127.0.0.1:4318/v1/traces
```

The explicit URL is used as the traces endpoint; AgentRig does not append a path.
Only `--otel-endpoint` enables this feature. Configuration files and OTEL environment
variables cannot enable it. With no flag there is no exporter, service or new package
dependency. This is an OTLP/HTTP JSON sink, not a full OpenTelemetry SDK. Your collector
must accept JSON. No collector is installed or launched.

Run/resume, the TUI, ACP and MCP serving use the same builder; their children share
one process-wide exporter capacity. `--sandbox workspace-write` or `read-only` requires
explicit `--sandbox-network` before telemetry starts; tool `--allow net` or YOLO does
not enable sandbox network. None mode has no OS containment. This network operation
is trusted operator observation, not an execution permission granted to the model.

Choose the destination deliberately. HTTP is plaintext, including non-loopback HTTP;
HTTPS uses ordinary TLS verification. Credentials, query and fragment are refused;
there is no redirect, auth-header, cookie or environment-based endpoint support.
Trusted host JavaScript, Node's global fetch dispatcher and its networking configuration
are outside this application's containment claim.

## What leaves the process

Only fixed span names (`session`, `turn`, `tool`), keyed trace IDs, random span IDs,
timestamps, sequence/turn numbers, outcomes, recorded permission class and reported
main token counters/completeness. A denial without execution is a zero-duration
`refused-attempt`, not a successful tool execution. Incomplete intervals are marked
incomplete. A normal `done` outcome means the harness ended normally, not verified
task success. Auxiliary spending is not included in these main counters.

No task, prompt, output, command, path, tool/model/provider name, raw session/call ID,
configuration, exception text or arbitrary event attributes. There is no content
opt-in switch. Timing and usage are still sensitive operational metadata; this is
data minimization, not anonymization or proof that activity cannot be inferred.

Each session has one trace within the exporter's live lifetime. Resume creates a new
root segment in that trace without exporting old log history. Children/forks have
separate traces. Identity is keyed with a random in-memory secret, with no persistent
ID cache; closing the last owner or restarting changes future trace IDs.

## Limits and failures

128 active sessions and 1,024 open spans share one process sink. Completed spans use
a 1,024-span /1 MiB accounted-payload cap, including in-flight spans. Batches are at
most 128 spans /256 KiB, with one HTTP request in flight. Serialized request/response
buffers have additional bounded overhead; this is not a total process RSS guarantee.
The existing shared session replay buffer is unchanged, not made bounded by telemetry.
If the shared exporter is draining, its owner capacity is full, or another build owns
a different endpoint, a fixed notice reports that the new build is unobserved. That
build continues without telemetry for its lifetime; no second exporter starts and
its data is never redirected to the other endpoint. Invalid endpoint configuration
and sandbox-network refusal remain pre-session errors.

Each attempt has two seconds for headers plus decoded body (64 KiB response cap).
At most two attempts and 4.5 seconds per batch; shutdown drains for at most five
seconds before cancelling owned fetch work. Retry-After outside the remaining batch
or shutdown lifetime causes a drop. Partial success never retries. Failed/partial/
dropped/incomplete counts are reported with fixed notices, never collector error text.
Retries can duplicate spans after ambiguous network failure. No lossless delivery,
remote persistence or global SDK instrumentation guarantee.
`exported` counts spans the collector acknowledges as accepted; `partial` counts
explicitly rejected spans, not whole partially accepted batches. Empty or warning-only
`partialSuccess` with zero rejected spans is full acceptance. Responses must contain
valid OTLP JSON; an empty HTTP 200 body is an invalid acknowledgement here. A dropped
or failed acknowledgement does not prove the collector stored nothing.

Event mapping never waits on network. Shutdown can wait for the bounded drain;
task outcomes, tool authorization and immutable event logs are not rewritten.
Arbitrary uncooperative host code cannot be forcibly stopped by this observer.

See the [implementation contract and verification](plans/R8c.md).
