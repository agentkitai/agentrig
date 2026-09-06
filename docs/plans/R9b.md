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
Provider-specific limitations still apply: the experimental ChatGPT adapter cannot
send a response-token cap and warns when that setting is explicit. Shared guards
remain accounting/scheduling controls, not provider-enforced billing limits.

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
This fixed preparation has a 120-second outer bound on the worker's two-CPU budget;
slower matching images may therefore BLOCK safely before any provider request.

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

## Validation before review

Own build/typecheck and four-worker full suite passed: **2,648 tests plus two existing
skips, 151 files, 42.86 seconds**, including the actual Linux container discriminator.
Explicitly built existing Dockerfile targets locally; captured image IDs:

- Worker: `sha256:f111ef59dce766519eb2ac455b554b01793aff0e9cd1d68d29b6d314d7db52e9`.
- Checker: `sha256:33443f68f312abe4f1e88e16be7c88407d7173e80d7e55dfb0a12a5541e733e5`.

The correct profile passed and deliberately broken profile failed through actual
network-disabled containers and the independent checker. Portable controls run
actual trusted E1/checker subprocesses. The local OpenAI SSE adapter/CLI test exposed
and fixed a real resolver integration bug: unregistered CLI defaults were being
treated as explicit overrides of the selected profile. Eval now identifies those
values as defaults, preserving both enabled profile options and unsupported-field
refusals. No live provider calls occurred.

Named negative controls detected and restored before review:

- **UnknownUsageGateRemoved**: bypassing the shared incomplete-usage guard made the
  guard regression fail; restored.
- **MemoryDigestGateRemoved**: bypassing the frozen-corpus hash check accepted the
  deliberately wrong digest and failed the actual snapshot control; restored.
- **BaselineIdentityGateRemoved**: bypassing task/main-session binding accepted a
  differently named session mapping to the original baseline; the control failed;
  restored. The final discriminator requests the mismatched mapped ID so another
  missing-map check cannot mask this mutation.
- **OwnedTreeWithoutRealGroup** (author-discovered regression): the first actual
  descendant-cancellation test exceeded its unchanged 15-second bound because
  `execFile` does not forward `detached`. Using `spawn` with a real owned process
  group made that same control pass in 49 ms. No timeout or assertion was weakened.

One bounded independent Claude review completed on clean snapshot `1d7a538`:
session `7f1cee19-f134-4a87-a109-a26c20a67c2f`, 238 seconds, 22 reported turns
of requested maximum 24. It independently passed typecheck and the full suite with
the container fixture environment set: **2,649 passed, two skipped, 151 files,
40.67 seconds**. It did not run build. [Verbatim findings](R9b-review.md).

The sole material finding was missing direct renderer coverage for `eval.result`.
Added trace/chat tests for BLOCKED outcomes with null/true/false advisory values and
invalid negative usage. Optional roadmap annotation and existing preparation-bound
documentation were corrected; an unrelated pre-existing container was left untouched.
There is no second review round. Final combined checks are recorded below; PR/CI gates remain pending.

Final author checks after the review fix: build/typecheck passed; full suite with
the captured Linux fixture image IDs passed **2,652 tests plus two existing skips,
151 files, 40.28 seconds**. Exact-head three-platform PR CI remains the delivery gate.

Integrated R7b main `f3a1ec8`, preserving heartbeat default suppression and both docs
rows. Combined build/typecheck and full suite with the same real Linux fixture images
passed **2,660 tests plus two existing skips / 152 files, 40.71 seconds**. The earlier
PR head's Linux/macOS and targeted Windows evaluation controls passed; they do not
replace the newly integrated exact-head three-platform gate. No new broad review.

Integrated-head CI `34042521286` passed Linux/macOS and the new Windows evaluation
controls, but two unchanged package fixtures exceeded their explicit 30-second
bounds: actual npm packing and the 1,000-file/two-install aggregate-cap scan. The
npm timeout was followed by cleanup EBUSY while its subprocess was still active.
The previous head's all-green CI `34042223949` measured those Windows cases at
5.896s and 8.989s respectively. Unchanged local focused controls passed 29/29 with
two workers (4.02s total) and one worker (4.95s total); these do not prove the cause
of the Windows slowdown.

The bounded test/CI response serializes only that Windows two-file step, makes
actual npm packing explicitly offline with its update notifier disabled, and
reuses the reviewed owned-process-tree helper with a 15s subprocess bound inside
the unchanged 30s fixture. It joins process close before cleanup and rejects any
interrupted/nonzero result before inspecting the archive. All 29 package cases,
1,000 input files, real packing, integrity/import-canary assertions, production
caps, and outer test deadlines remain unchanged. This reduces resource/network
variables and addresses the cleanup race; contention is suspected, not proven.
No second general review or separate roadmap milestone was added.

After this fixture adjustment, the focused package/evaluation controls passed
51 tests with the conditional Docker case skipped; final build/typecheck and full
suite with actual Linux Docker images enabled passed **2,660 plus two existing
skips / 152 files, 41.38s**. Fresh exact-head platform CI is still required.
