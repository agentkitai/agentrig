# Recommended defaults (R17b migration)

No configuration file or `--profile` flag is needed. Normal CLI run, TUI, resume,
ACP, Web and MCP entry points use the built-in **recommended** profile as their
lowest-precedence layer. `--profile recommended` names that same baseline; named
user/project profiles overlay it. Existing user config, trusted project config,
selected profiles and explicit retained CLI flags keep their precedence. Project
trust is still required; untrusted project configuration is not loaded.

## What is on

- **Markdown rendering** in the TUI, including code fences. The existing Ctrl+O
  plain/expanded view is still available. The line-oriented `run` transcript and
  immutable messages retain their raw Markdown; rendering never rewrites history.
- **Post-edit diagnostics**: existing `tsc` parser for `.ts`, `.tsx`, `.mts`, `.cts`
  (`tsc --noEmit --pretty false`) and existing Ruff JSON parser for `.py`, `.pyi`
  (`ruff check --output-format=json -- {path}`, for roots with `pyproject.toml`,
  `ruff.toml` or `.ruff.toml`). These use installed executables on PATH;
  no package installation, checker discovery, new parser or approval bypass.
  TypeScript remains enabled without a root tsconfig, including references-only
  roots and JSONC; absent project/unsupported output is incomplete, not clean.
  A checker still needs the existing exec permission and sandbox. Missing tools,
  denied execution and unsupported output are visibly unavailable/incomplete,
  never a fabricated clean result. Other extensions have no invented checker.
  Configure `diagnostics: []` to disable, or supply the existing checker array.
- **Prompt history**: existing durable TUI history, with its existing byte bounds
  and navigation keys. Nothing makes headless runs into interactive sessions.
- **Notifications**: `notifications: "bell"`; the existing 30-second idle threshold
  and mounted TTY gating remain. Desktop notifications are not enabled implicitly.
- **Git checkpoints**: `checkpoints: true`, active when the workspace is a Git
  repository, with a concise checkpoint-created notice in the default transcript.
  Existing outside-repository warning/no-op and ownership refusals
  remain; no auto-init or relaxed restore checks.
- **Session-end memory ingest**: `ingestOnEnd: true`, using existing `.agentrig`
  memory and the configured ingest role. This can make a separately accounted
  model call. Failure is reported without changing the successful main task;
  an unavailable provider is not a successful ingest.
- **Supervisor heuristics**: `supervise: true`. LLM review and automatic abort
  are still separate explicit choices, not newly enabled.
- **Tool summaries**: `toolSummaries: true`; expanded event output remains
  available with `toolSummaries: false` and the TUI's existing view toggle.
- **Thinking preserved**: the existing raw conversation/opaque thinking replay
  is unchanged. Display choices do not discard signed reasoning or expose it in
  exports where it was already excluded.

Heartbeat retains its existing constrained behavior (no mutation/checkpoint,
post-edit diagnostics, or notifications). Its scheduled-ingest opt-out uses
explicit config provenance as before. SDK `createAgent`/`buildAgent` callers do
not silently acquire CLI defaults.

### Enforcing sandboxes (approved exception)

Implicit checkpoints and session-end ingest apply only when sandbox is absent or
`none`. Enforcing sandboxes visibly omit these two implicit host-process hooks,
including through the mounted UI notice path. Explicit `checkpoints: true` or
`ingestOnEnd: true` still reaches the **existing fail-closed startup error**.
This does not provide sandbox-safe hook execution. The zero-config sandbox was
already `none`; `ask`, sandbox, grants, project trust and fail-closed manifests
have not changed. Existing explicit extension/dream hooks are not silently removed.

### Every changed CLI flag

These flags are removed, not hidden aliases; Commander reports an unknown option.
Put the replacement in user config (`~/.agentrig/config.json`) or trusted project
config (`.agentrig/config.json`), optionally under a named profile:

| Former flag | Replacement | Default meaning now |
| --- | --- | --- |
| `--supervise` | `"supervise": true` | Heuristics on |
| `--no-supervise` | `"supervise": false` | Explicit config opt-out |
| `--checkpoints` | `"checkpoints": true` | On in repositories, subject to sandbox exception |
| `--ingest-on-end` | `"ingestOnEnd": true` | On, subject to sandbox exception |
| `--no-ingest-on-end` | `"ingestOnEnd": false` | Explicit config opt-out |
| `--notifications <mode>` | `"notifications": "off" / "bell" / "desktop" / "both"` | Bell, existing idle/TTY gating |
| `--verbose` | `"toolSummaries": false` | Summaries on; false selects expanded output |

There were no `--no-checkpoints`, Markdown, prompt-history or thinking-preservation
CLI toggles to migrate. `--json`, `--profile`, security flags, tuning flags such as
`--notification-idle-seconds`, and all other options retain their meaning. Root
`agentrig --help` has two options (`--profile` and `--help`), as in the baseline;
no advanced options were hidden to manipulate the under-40 acceptance count.

Example explicit opt-out profile:

```json
{"profiles":{"quiet":{"supervise":false,"checkpoints":false,"ingestOnEnd":false,"diagnostics":[],"notifications":"off","toolSummaries":false}}}
```

Run it with `agentrig --profile quiet` or `agentrig run --profile quiet "task"`.

## Evidence and limitation

`recommended-runtime.test.ts` runs the built CLI against a local deterministic
provider in a fresh repository, with separate empty home and **no config files**.
Transport selection and one explicit write approval are fixture inputs, not
feature opt-ins. It checks checkpoint creation, an honest post-edit diagnostics
line (exec remains denied unattended), completed session-end ingest and raw
Markdown preservation; the existing TUI Markdown renderer is asserted separately.
The companion `.agentrig/r17/recommended-smoke.py` runs the real TUI in a PTY,
declines project trust and diagnostic exec approval, and checks its final rendered
frame plus canonical session events. The observed result is in
[`plans/R17b-smoke.json`](plans/R17b-smoke.json). Both fixtures use a local
deterministic provider, not a live-provider claim. Existing Markdown/frame,
prompt-history, notification, summary and thinking
replay suites continue to cover their already-default paths.

Feel issue #235 records an existing interaction exposed by the combined defaults:
session-end ingest can write memory after the last tool, so the terminal
checkpoint ownership seal refuses those later changes. Checkpoint creation still
works, but undo may be unavailable. This PR does not widen checkpoint exclusions
or relax that safety check. #232 is the prior declaration-only plan-check friction;
#233 is covered by the approved sandbox exception above.

## Checkpoint retention and destructive restore

In one atomic Git ref transaction before publishing the terminal ownership seal, the last **two mutating-turn refs** remain as undo targets; older turn refs are deleted using compare-and-delete, never by rewriting session JSONL. Immutable checkpoint events for pruned turns remain historical receipts; attempting to undo or `/diff checkpoint <turn>` a pruned target reports "pruned or missing" before writing. A pruning failure leaves all refs unchanged and emits no sealed event. Retained targets keep the existing ownership, quiescence, index and HEAD guards. Sealed refs are kept. Interrupted/unsealed sessions keep all refs to avoid discarding recovery data; sessions and sealed refs therefore still grow over time. This is not global garbage collection and does not add a prune command.

`supervisorAbortRestores` requires explicit trusted-config or CLI sources for both `supervise` and `checkpoints`, as well as explicit abort/restore flags and the existing sandbox-none/quiescence conditions. The implicit recommended layer never supplies destructive-restore authority. Resolver provenance markers cannot be set in config.
