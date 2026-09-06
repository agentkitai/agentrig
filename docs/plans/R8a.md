# R8a — bounded stable ACP v1 stdio

Status: implemented, verification/review/final CI in progress. One roadmap row;
no MCP serving, websocket client, v2 protocol, question tool or orchestration DSL.

## Contract

[One-page operator guide](../ACP.md) documents the wire surface and caps. The exact
official `@agentclientprotocol/sdk` 1.4.0 dependency handles generated-schema method
dispatch; its fluent `agent`/`client` APIs replace deprecated connection classes.
Registry integrity at selection:
`sha512-/eufudw+aFY1LKLolT6yFE6UMmYRl7fMJ/DEONSIyR6wI3slHWITBsANRGqXEY8FRzqUxwh7QEaGiZHcJPVThg==`.
The SDK supports our existing Zod 3.25 peer. Official sources were read on
2026-09-06; the [v2 draft](https://agentclientprotocol.com/announcements/acp-v2-draft)
has different completion semantics and is deliberately not mixed into v1.

The controller owns actual runs, grant registries, continuation, permission queues
and cleanup. The transport never invents a second agent loop or replays authority.
Its literal prompt method skips slash-command parsing. Core `RunOptions.advisoryContext`
has bounded strings only, fixed external/advisory metadata, and additive
session.start/resume fields; event materialization and snapshots retain it. Only
explicit task text calls the fresh-user expansion path; empty/resource-only turns
stay restricted, including continuation. Existing text-only H6 traces are unchanged.

Each session resolves trusted config independently in its canonical cwd. The launch
`--trust` flag is constrained to that project. No process.chdir, client-provided
profile/permission changes, or inherited blanket project trust. The standard
builder remains responsible for provider, hooks, memory, skills, sandbox and tools.
Scheduler failure banners/report scans remain interactive-only, not ACP startup.

MCP uses exact operator configuration matching and an additive trusted
`requireExistingPins` connection mode. Unlike ordinary CLI trust-on-first-use, ACP
cannot create/update a pin: missing/changed pins require operator CLI action.
Revalidation still occurs before every actual call. First-use refusal may start an
already operator-authorized server to obtain its definitions, but does not expose
its tools or execute a tool. Unknown client configuration refuses before the builder.
Server-provided hints/names/descriptions are not permission grants. Configured host
code, stdout discipline and OS sandbox limitations remain explicit trust assumptions.

Outbound permission IDs are namespaced on the wire and bind exact pending objects.
Only selected `allow` is approval; all other selections/errors/cancellation deny.
Synthetic approval tool updates explicitly describe approval, not successful tool
execution. Actual tool IDs are prefixed by ACP prompt number to avoid collisions
across resumed internal runs. Kind `other` avoids inferring effects from names.

ACP locally settles approval as denied on abort, joins its update, and ignores late
answers. It does not send the optional SDK JSON-RPC request-cancel notification:
the unanswered SDK reply remains counted against the eight-request cap and retains
its byte reservation until answered or the connection closes. This avoids an
unaccounted SDK-generated outbound notification. No abandoned destructive
filesystem call is involved in that local permission wait.

Transport frames and output queues count bytes. A shared 4 MiB ledger reserves
notification bytes before SDK enqueue, 128 KiB per inbound response (16 maximum)
until actual write, and 128 KiB per permission until reply/connection close. Own
results cap at 130,000 bytes plus bounded envelope; errors are fixed/bounded.
Malformed/unknown requests become a constant refusal method before SDK dispatch.
Preflight uses the same public SDK `schema/schema.json` with exact Ajv 8.20.0
draft-2020-12 validation, offline local references only, no fetched schemas and no
serialized validator errors. Extension schemas are shared with actual handlers.
The SDK still validates/distributes requests; no private import or protocol fork.
Its documented ConnectionBuilder/RequestResponder are not package exports in this
release, so the review fix retains public fluent APIs plus this bounded preflight.
The earlier WritableStream-only counter missed the SDK's own serialized queue;
the real blocked-SDK regression now exercises the shared pre-enqueue ledger.
Finite input
frames/Node chunks and generated schemas bound parsing; this is not a hard RSS/CPU
quota for trusted JavaScript. Connection failure aborts controllers and waits for
in-flight creation, observers and MCP cleanup. Existing runtime orphan/uncooperative
host-code limits remain; a protocol completion never claims OS-level quiescence.

Memory extension reads only the configured store, never a client path. It reuses
the actual built policy and refuses a non-allow result. Index cap 256 KiB; query
scan caps 512 entries, depth 8, 256 KiB/file, 2 MiB total; no remote Lore lookup or
maintenance writes. Returned lines are bounded. Raw event subscription is opt-in
and explicitly unredacted, separate from R9a's redacted export.
Events above 256 KiB emit an explicit omission notice with original type/seq/byte
size instead of disconnecting; this subscription is not a lossless copy. Immutable
logs and normal tool-result updates remain unchanged.

## Verification in progress

- Actual official SDK over pipes, canonical session cwd, real local provider,
  deny then allow file mutation; both replies streamed before prompt completion.
- Controller literal `/new` input, resource-only initial/continued prompts,
  unanswered permission cancellation and concurrent eight-session admission cap.
- Exact MCP config mismatch/unknown server refusal and secret-safe diagnostics;
  existing CLI MCP child fixture exercises missing/changed/unchanged pins without
  ACP consent persistence.
- Core snapshots/event materialization retain external context; unchanged H6 traces.
- Blocked actual output write detects queue overflow; malformed/oversized/duplicate
  input closes. Build/typecheck and focused groups passed during implementation.

Named negative controls were applied individually and restored:

- Promoting advisory context through `expansion.user` caused the actual resource-only
  tool effect count to become one instead of zero (one failed / three passed).
- Routing ACP through slash-aware `submit` caused three real controller protocol
  tests to fail instead of interpreting `/new` as literal task text.
- Removing the existing-pin startup guard exposed one MCP client on first use
  instead of zero; the actual Node MCP fixture caught it (one failed / two passed).
- Applying launch `--trust` to every session trusted the second project's root;
  the actual program/config test caught it (one failed / one passed).

Initial full suite: 2,717 passed plus three skips /160 files in 43.96s. One skip was
the existing opt-in Docker fixture, so the final run enables its already-built local
worker/checker images. Build/typecheck passed. Final full suite, one independent
review and exact-head three-platform CI receipts will be appended before handoff.
Final pre-review combined-main validation: build, typecheck and full suite passed
with the actual local Docker worker/checker fixtures enabled: **2,718 passed plus
two existing skips /160 files**, four workers, 44.25s. Client script syntax and
`git diff --check` passed. No live provider calls were used for validation.

## Single review and scoped fixes

[Original findings](R8a-review.md) are retained verbatim. Requested 24 turns;
CLI reported 56. Reviewer ran 19 focused tests plus typecheck; its two SDK shell
probes were denied, and it did not execute the oversized-event reproduction.
Author controls separately established both material findings:

- An initial fixture put large text only in the tool's opaque output, so it failed
  the missing-notice assertion without reproducing disconnect. Correcting it to
  actual full display overflow reproduced `ERR_STREAM_PREMATURE_CLOSE`; after the
  bounded notice fix the same actual tool/ACP turn completes with normal updates.
- Ninety 70,000-byte controller deltas through the official SDK behind corked
  stdout failed the 1.5s closed-state assertion before pre-SDK accounting; the same
  case now closes and joins. This is an actual runtime/control assertion with a
  bounded asynchronous wait, not a direct WritableStream-only capacity claim.
- Actual valid, unknown-method and malformed-schema responses remain reserved
  while stdout is blocked and release after write callbacks, not handler return.
  A seventeenth stalled request closes. Cancelled permission reservations persist
  until a late reply; an eventual allow cannot execute effects or lower bytes below
  zero. Existing unanswered-permission cancellation remains tested.

Optional polish is at ROADMAP's end; no second general review was requested.

## Combined-main final local gates

Integrated R9c main `3b7564a`, retaining evaluator option-source compatibility,
all CI groups and both workflow gates. R9c post-main CI `34047589688` and
structure workflow `34047589697` passed. Frozen install, build/typecheck and full
suite passed: **2,733 tests plus two existing skips /161 files**, four workers,
58.44s, with existing pinned local Docker worker/checker images enabled. A final
compile caught lost generic inference on the extracted permission request; the
explicit official request type/method generic fixed it before these passing gates.

Actual `eval/nightly.mjs` on those local images also passed: correct X1 PASS,
broken X1 FAIL, human-pending X4 BLOCKED, 60 retained entries /85,455 bytes, no
missing artifacts. This is scripted mechanics evidence, not live model quality.
Receipt: `/tmp/agentrig-r8a-structure.0P9xv9/run/summary.json`; evaluator revision
records merge `c3d23fd` with the subsequent type-only permission fix in the tested
worktree. Exact final-head CI and scripted-structure gates remain required.
