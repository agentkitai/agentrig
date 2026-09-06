# H7b — process output is not sandbox-denial evidence

Issue #95 closes the correctness-repair lane after H7a PR #161, whose merged main `668f7f1`
passed all three platforms in CI 34028225992. The issue's old sentinel/exit-code suggestion is
not an authentication mechanism: the controlled child can forge both. No tracing framework is
introduced in this bounded repair.

## Contract

- Docker and Seatbelt still enforce their existing OS/container profiles and workspace bounds.
  Neither currently supplies an independently observed process-denial signal. Printed stdout,
  stderr, exit codes, plausible paths, network messages or sentinel-shaped strings cannot
  create `SandboxDeniedError`, `sandbox.denied`, or a sandbox-escalation permission request.
- Foreground bash preserves failed exit status, output and ordinary error classification.
  Background status polling preserves output drainage and the failed child's exit status;
  a successful status query is still not itself an error. The sandboxed file-write helper
  preserves ordinary failed-process details without claiming its cause was a policy denial.
- Trusted broker refusal (read-only mode or canonical target outside cwd) and a configured
  provider's unavailable launcher/refusal remain actual denials with the existing explicit,
  one-call escalation path. No permissions, grants, default modes or containment are widened.
- Exported `throwIfSandboxDenied` remains a deprecated compatibility no-op. Exported text/path
  plausibility helpers and legacy protected provider diagnostic methods retain compatibility,
  explicitly marked diagnostic-only; runtime tools no longer call them. Historical events
  remain readable and immutable. Removing those compatibility helpers is optional future work.
- This deliberately stops auto-classifying genuine but unobserved process sandbox failures,
  too. Their ordinary process error remains visible; plausible wording does not authorize a
  boundary-crossing retry. Trusted custom provider code can still throw `SandboxDeniedError`
  for its own independently established refusals; this is not a sandbox for hostile SDK code.

## Verification

Actual prepared Docker/Seatbelt tools use a controlled Node subprocess in place of platform
executables: spoofed stdout/stderr, outside/relative/read-only/network/sentinel shapes through
foreground commands, retained background polling and the file-write helper. Real agent events
must contain no denial or escalation asks from those bytes. Genuine broker and missing-launcher
refusals remain positive controls. These fixtures test output handling, not OS effectiveness;
existing wrapper/profile and optional live-local Docker containment tests remain separate.

Legacy heuristic tests remain diagnostic tests; old runtime tests now require honest ordinary
failed exits, including large-output and intermediate-drain cases. Named runtime inference
mutations must be detected and restored. Full build/typecheck/tests, one bounded independent
Claude review with material findings addressed, updated-main PR and exact-head three-platform
CI gate delivery. No live model evaluation, new milestone nesting or runtime observer framework.
