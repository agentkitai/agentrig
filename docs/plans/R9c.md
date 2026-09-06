# R9c — nightly scripted structure regression

Status: implemented; validation/review/PR gates pending. No model-quality claim.

## Contract

`node eval/nightly.mjs NEW_OUTPUT WORKER_SHA256 CHECKER_SHA256` is a trusted,
scripted mechanics wrapper over the existing R9b driver, E1 pinned preparation
and independent checks, and E2 reports. It never reads product config or creates
an authenticated provider. There is no product fake-provider flag, source fetch,
image pull/build, dependency provision, or new evaluation engine. The existing
Dockerfile targets must already be built and selected by local image ID.

The original baseline identities are explicitly synthetic scripted fixtures with
actual E1 checks, not historic user sessions. The full pinned upstream Git bundle
is reused unchanged. Shared scripted provider/scripts live in evaluator support,
not a normal runtime provider registry or imported Vitest test module.

Three required isolated controls:

- X1 correct: PASS.
- X1 deliberately broken: FAIL despite its scripted completion claim.
- X4 automatic checks PASS, human verdict PENDING: BLOCKED, never manufactured PASS.

Missing/unexpected results, failed positive controls, unexpectedly passing negative
controls, incomplete usage, cancellation, unreadable E2 evidence, or missing local
containers fail the structure check. Expected X4 BLOCKED counts only when its
behavior/regression/scope lanes pass and the actual human gate is pending.
Scripted usage is fixture accounting, not observed paid model consumption.

An explicit trusted in-process `evidenceLane: "scripted"` dependency annotates the
actual R9b protocol and E2 manifest. Ordinary evaluation remains `live`; neither
profile/config nor model output can select this label. Labels never grant authority.

## Coverage and workflow

The `Nightly structure regression / scripted-structure` check runs at **03:17 UTC**,
on manual dispatch, on PRs, and on main pushes. It has read-only contents permission,
no secrets/provider credentials, non-cancelling per-ref concurrency and a 30-minute
job ceiling. Explicit workflow infrastructure prepares existing Dockerfile targets
and captures their image IDs; actual worker/checker execution remains network-none.

The same job separately runs existing E1/E2/R14d/R13e tests: all eight E1 definitions
are structurally covered, including A1/A2 seeded regressions, A3 extraction identities,
A4 accounting/evidence, and X1–X4 behavior and human-review rules. **A tasks are not
claimed as executed isolated attempts**: the shipped worker still lacks their matching
offline dependency image. X2/X3 receive existing structural checks, not new model runs.
The wrapper's summary explicitly does not attest the separate test invocation;
both must succeed for the job to pass.

GitHub schedules are best effort, default-branch only, and may be delayed/dropped;
public-repository inactivity can disable them. This is not a punctual service or
resident daemon. See [GitHub schedule documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).
Artifact uploads use the documented retention, missing-file and hidden-file settings
of [actions/upload-artifact](https://github.com/actions/upload-artifact).

## Retention, cancellation and limits

The output is create-only under a canonical existing parent. Existing destinations
are untouched. Owned workspaces remain under `work/`; no cleanup deletes them.
Only fixed evaluator-selected baseline/attempt receipts, session logs, reports and
coordinator records are copied into `artifacts/`. No submitted workspace, source
checkout, arbitrary glob, symlink ancestor or special/hardlinked file is followed.
Bounds: 2,000 visited entries, depth eight, 8 MiB/file, 64 MiB total per collection;
bounded reads detect changed files. Each retained file gets a SHA-256 inventory.
Partial copies/missing selections are explicit. This is a cooperative trusted-host
copy boundary, not transactional protection from hostile concurrent writers.

The wrapper has a ten-minute cancellation timer, with normal R9b per-attempt
10,000-token/two-minute guards. SIGINT/SIGTERM use its shared cancellation signal;
awaited evaluation/owned transport calls and container cleanup settle before final
summary publication. Unstarted controls stay in the denominator with null outcomes.
Unexpected errors expose only the fixed current phase, not arbitrary exception,
environment or process payloads. A running summary exists before external preflight.

Workflow uploads run even after test/runner failure, retain selected evidence for
14 days, and separately bound the generated structural test report. Missing report
or artifact-copy overflow fails the job. A hard runner loss/force-kill can prevent
finalization/upload; a RUNNING partial summary is not success. Workspaces stay local
to the disposable runner and are not included in the selected artifact upload.

This does not alter E3, execute live models, assess held-out model quality, infer
benefit, enable automatic skills/unattended defaults, or claim injection is solved.

## Validation record

Initial actual CLI/container execution correctly failed when the baseline wrapper
passed an extra `receiptPath` field to E1's strict checker. Applying the existing
R9b portable-receipt projection fixed the integration without relaxing the checker.
The original failed summary/process receipt was retained. The actual corrected
wrapper produced PASS/FAIL/human-BLOCKED and selected 52 files / 85,511 bytes.

Typecheck passes; existing R9b controls pass 23 plus one conditional container skip.
New portable controls initially pass six plus one conditional container skip; the
combined E1/E2/R14d/R13e/nightly group with actual Linux containers enabled passes
59 tests across five files (11.90s). These are mechanics results only. Named negative
controls, full checks, independent review and exact-head platform receipts follow.

Integrated green R7c main `b2390ce`. Root's integration inspection found its new
trusted `ingestOnEndExplicit` metadata rejected an otherwise supported profile
with `ingestOnEnd: false`. An actual config→CLI preview reproduced that rejection;
allowing only the resolver metadata name fixes it. The same control still refuses
enabled ingestion and strict config parsing still rejects forged metadata. No
provider was constructed. This is a root/author finding, not an independent-review finding.

Named mutants detected and restored:

- **ExpectedOutcomeGateRemoved:** dropping the observed-result comparison accepted
  an incorrect positive/negative result; the discriminator test failed.
- **ArtifactAncestorGateRemoved:** dropping the ancestor link check copied through
  a deliberate directory alias; the linked-artifact control failed.
- **ScriptedLaneDropped:** omitting the trusted wrapper's scripted label produced
  a live-labelled report; the actual portable core/E1/E2 wrapper failed as required.

Additional controls refuse missing selected accounting artifacts even after the
three check outcomes match, enforce byte/file/entry bounds, reject destination
links, preserve occupied files, and retain a RUNNING summary until cancelled owned
transport work has joined. The underlying owned descendant cancellation control
from R9b remains in the full suite; the wrapper-specific join test uses trusted
injected transport, not a claim of hostile-process containment.

Author final pre-review checks on integrated main: build/typecheck pass; full suite
with both actual Linux container fixtures enabled passes **2,710 tests plus two
existing skips / 156 files, 47.86s**. One bounded independent review follows.
