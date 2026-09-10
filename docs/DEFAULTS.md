# Recommended defaults (R17b migration)

No configuration file or `--profile` flag is needed. Normal CLI run, TUI, resume,
ACP, Web and MCP entry points use the built-in **recommended** profile as their
lowest-precedence layer. `--profile recommended` names that same baseline; named
user/project profiles overlay it. Existing user config, trusted project config,
selected profiles and explicit retained CLI flags keep their precedence. Project
trust is still required; untrusted project configuration is not loaded.
On profile-aware non-run commands (for example `review` and `doctor`), the built-in
`recommended` name retains that command's baseline and emits a note that run
defaults do not apply. A user-defined profile with that name still overlays
normally.

## Default behavior

- **Markdown rendering** in the TUI, including code fences. The existing Ctrl+O
  plain/expanded view is still available. The line-oriented `run` transcript and
  immutable messages retain their raw Markdown; rendering never rewrites history.
- **Post-edit diagnostics**: existing `tsc` parser for `.ts`, `.tsx`, `.mts`, `.cts`
  (`tsc --noEmit --pretty false --listFiles`) and existing Ruff JSON parser for `.py`, `.pyi`
  (`ruff check --output-format=json -- {path}`, for roots with `pyproject.toml`,
  `ruff.toml` or `.ruff.toml`). These use installed executables on PATH;
  no package installation, checker discovery, new parser or approval bypass.
  TypeScript remains enabled without a root tsconfig, including references-only
  roots and JSONC; absent project/unsupported output is incomplete, not clean.
  The compiler's file list must include the touched file before this default
  checker can report completed coverage. References-only solutions and excluded
  files are incomplete even when tsc exits zero; this does not build references.
  Coverage metadata has a separate finite 4 MiB allowance and 8192-byte line bound;
  diagnostic text retains its configured cap (default 65536 bytes). Any overflow
  or incomplete observation fails closed. See the human-approved
  [bounded metadata amendment](plans/R17b-outside-diagnostics.md).
  Custom tsc checker arrays without `--listFiles` retain their existing output
  semantics and do not gain this coverage check.
  A checker still needs the existing exec permission and sandbox. Missing tools,
  denied execution and unsupported output are visibly unavailable/incomplete,
  never a fabricated clean result. Other extensions have no invented checker.
  Configure `diagnostics: []` to disable, or supply the existing checker array.
- **Prompt history**: existing durable TUI history, with its existing byte bounds
  and navigation keys. Nothing makes headless runs into interactive sessions.
- **Notifications**: `notifications: "bell"`; the existing 30-second idle threshold
  and mounted TTY gating remain. Desktop notifications are not enabled implicitly.
- **Git checkpoints**: `checkpoints: false` by default. Ordinary editing, diagnostics
  and background tests do not acquire a checkpoint lease or pass a snapshot gate.
  Opt in with `checkpoints: true` in trusted config if you need guarded session undo;
  that mode requires a cooperative, quiescent worktree and refuses background commands.
  Existing snapshots, lock recovery and strict undo checks remain supported.
- **Session-end memory ingest**: `ingestOnEnd: true`, using existing `.agentrig`
  memory and the configured ingest role. Automatic capture first performs a bounded,
  model-free latest-run eligibility check. Successful read-only explanation runs
  defer visibly; useful conversational learning may still exist, and the raw log
  remains available to `agentrig memory ingest <session-id>`. Recorded non-read or
  unknown dispatched work, failed tool results, file changes and explicit attempts
  qualify; this is a spending heuristic, not execution authority or semantic proof.
  Complete evidence must fit the capture budget; oversized/incomplete scans defer
  rather than silently summarize a prefix. Automatic defaults are 30s total, 15s per
  call and 4 calls; explicit ingest limits override. Manual ingest and SDK hook
  defaults are unchanged. Qualifying automatic capture can make a separately accounted
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

### Automatic memory injection is opt-in (R17f)

The recommended CLI profile now sets `memoryIndexInjection: false`. The
[96-attempt measurement](R17f-RESULTS.md) did not establish the preregistered
benefit threshold; this conservative policy does not prove memory has no value.
Only the automatic `memory_index` system-prompt block is disabled. Explicit
`memory_search` / `memory_read`, their existing startup permission rules, and
session-end ingestion remain enabled as before.

Set `"memoryIndexInjection": true` in user config, trusted project config, or a
selected profile to restore automatic index injection. There is no new CLI flag.
Direct SDK `buildAgent` callers that leave this field unspecified retain their
previous injection-on behavior; CLI resolved defaults do not silently become SDK
defaults. LLM supervisor review and automatic abort remain opt-in; free heuristics
remain on. Security defaults are unchanged.

### Enforcing sandboxes (approved exception)

Implicit session-end ingest applies only when sandbox is absent or
`none`. Enforcing sandboxes visibly omit this implicit host-process hook,
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
| `--checkpoints` | `"checkpoints": true` | Opt-in; off by default, enforcing sandbox still refuses |
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
Transport selection and explicit write/bash approvals are fixture inputs, not
feature opt-ins. It checks the absence of checkpoint events, an approved background
command's completed output, an honest post-edit diagnostics line (checker exec
remains denied unattended), completed session-end ingest and raw
Markdown preservation; the existing TUI Markdown renderer is asserted separately.
The historical `docs/plans/R17b-repair-smoke.py` ran the checkpoint-on R17b TUI in a PTY,
declining project trust and diagnostic exec approval, and checked its final rendered
frame plus canonical session events. Round-3 reproduction commands and receipts are in
[`plans/R17b-round3.md`](plans/R17b-round3.md); old smoke receipts are historical,
not independently reproduced reviewer evidence. Both fixtures use a local
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

In one atomic Git ref transaction before publishing the terminal ownership seal, the last **two mutating-turn refs** remain as undo targets; older turn refs are deleted using compare-and-delete, never by rewriting session JSONL. Immutable checkpoint events for pruned turns remain historical receipts; attempting to undo or `/diff checkpoint <turn>` a pruned target reports "pruned or missing" before writing. A pruning failure leaves all refs unchanged and emits no sealed event. Retained targets keep the existing ownership, quiescence, index and HEAD guards. Sealed refs are kept. Sessions interrupted before the seal transaction keep all turn refs. If the
transaction commits but the subsequent sealed-event append fails, older turn refs
have already been pruned although the log is unsealed; undo refuses without the
seal event. This is not an all-refs recovery guarantee for that failure window.
Sessions and sealed refs therefore still grow over time. This is not global garbage collection and does not add a prune command.

`supervisorAbortRestores` requires explicit trusted-config or CLI sources for both `supervise` and `checkpoints`, as well as explicit abort/restore flags and the existing sandbox-none/quiescence conditions. The implicit recommended layer never supplies destructive-restore authority. Resolver provenance markers cannot be set in config.
