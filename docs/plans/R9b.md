# R9b — explicit session evaluation against a profile

Status: implementation and validation in progress; no delivery or benefit claim.

## Contract

`agentrig eval <session...> --against <profile> --fixtures <map> --output <new-dir>`
previews a bounded explicit mapping from finished session identities and E2 baseline
bundles to existing pinned E1 tasks. It does not infer tasks from prose, replay old
tool calls, or treat model completion claims as outcomes. Preview constructs no
provider and creates no output. Execution requires `--execute --batch-tokens N
--batch-minutes N`, Linux Docker, and explicitly selected local image IDs. The
product never builds/pulls images or downloads/installs dependencies.

The existing E1 `prepare` and `check`, E3 owned-container helper, E2 accounting
report, normal core session, and M6 grader remain the execution/evidence machinery.
This row adds orchestration, not a second evaluation engine. Main and auxiliary
calls share a scheduling guard. Missing usage or retries make accounting incomplete
and stop further scheduling; in-flight calls can exceed a boundary. Time limits
cancel owned processes/containers, whose cleanup is joined before final receipts.
These are not guarantees about remote provider cancellation or final billing.

Each task has independent E1/R14d checks and an E2 report. M6 grading is separately
labelled advisory and cannot replace a failed check or required human verdict.
The separate coordinator `evaluation.jsonl` contains protected `eval.result`
events; original session logs are never appended. Unstarted blocked attempts have
a coordinator-generated attempt ID, explicitly distinguished in their receipt.
All requested tasks remain in the aggregate denominator, including BLOCKED rows.

## Fixture map and supported profiles

The strict version-1 map is at most 64 KiB and sixteen unique session rows:

```json
{
  "version": 1,
  "workerImage": "sha256:<64 lowercase hex digits>",
  "checkerImage": "sha256:<64 lowercase hex digits>",
  "sessions": [{
    "sessionId": "original-session-id",
    "task": "X1",
    "source": "./pinned-source-repository",
    "baseline": "./baseline/manifest.json"
  }]
}
```

Paths resolve relative to the mapping file. Baseline main-session identity, task
and pinned starting revision must match. E2's bounded reader validates baseline
receipts. Legacy E2 manifests do not attest their worker/checker image identities;
the comparison explicitly reports this uncertainty, not a profile-only delta.
Current selected image identities and preparation outcomes are retained.

Supported profile settings: provider/model/base URL/context window/reasoning,
named providers with main/supervisor roles, system text (16 KiB), per-run turn/token/
time/output limits, supervisor enable/abort/soft threshold/remaining turns/review,
and optional frozen read-only memory. Fixed tools are isolated `bash`, `update_plan`
and, with memory, `memory_search`/`memory_read`. Full-harness replay is not supported.
Enabled/nonempty skills, extensions, packages, MCP, subagents, checkpoints, network,
custom shell, permission rules, repo maps and other unsupported effective fields
are refused by field name; they are not silently disabled.

Pricing is optional, but all four explicit input/output/cache rates are required
when supplied. Flat rates cannot price distinct main/supervisor model identities.
`maxUsd` requires this complete pricing and gates combined reported usage, not
unobservable external costs. Missing external-cost evidence stays unknown in E2.

A memory-enabled row must additionally supply `memory: {"path": "./corpus",
"sha256": "<64 hex digits>"}` matching the profile's selected memory directory.
The canonical corpus is bounded (1,000 entries, depth 16, 1 MiB/file, 16 MiB total),
rejects links/special files and is digest-checked before copying to a fresh attempt.
There is no ingest/dream/global-memory fallback.

## Isolation and offline prerequisites

The shipped `eval/Dockerfile` worker operationally supports X1–X4. A1–A4 are accepted
task identities but require a user-supplied pinned worker image containing matching
offline dependencies for E1's exact AgentRig revision:

```text
/opt/agentrig-eval-deps/node_modules
/opt/agentrig-eval-deps/packages/core/node_modules
/opt/agentrig-eval-deps/packages/memory/node_modules
/opt/agentrig-eval-deps/packages/supervisor/node_modules
/opt/agentrig-eval-deps/packages/cli/node_modules
```

Provision these directories in the image beforehand using the pinned revision's
lockfile, retaining pnpm's relative symlink layout. Product preparation copies only
these directories into its disposable workspace, runs the pinned repository's
existing `pnpm build` without network, and requires an unchanged tracked tree and
index. Missing directories, build failure or tracked changes BLOCK before provider
construction. There is no user-supplied preparation script or product image builder.

Container images are trusted evaluator/operator code, not authenticated by a hash
alone. Workers use network none, read-only root, dropped capabilities, PID/memory/CPU
bounds and only their own workspace mount. The checker additionally receives its
read-only external receipt. UUID-owned containers are removed on completion/abort.
Owned preparation groups/trees are cancelled, not arbitrary processes by name;
this is not containment of deliberately detached hostile host descendants.

Tests explicitly build existing Dockerfile targets and capture IDs on Linux CI.
The correct/broken discriminator must use actual containers there. macOS/Windows
exercise real core/E1/checker subprocesses through trusted fixture transport and
production unsupported/unavailable-platform refusal; this is not isolation proof
on those platforms. No test calls a live provider. Offline source fixture provenance
is in [is-number-pinned.md](../../eval/fixtures/is-number-pinned.md).

## Gates

Pending: expanded controls, named negative mutations, full checks, one bounded
independent Claude review, updated-main PR and exact-head all-platform CI.
