# AgentRig

`agentrig doctor` stays offline/read-only. Explicit `agentrig doctor --probe` runs potentially
billable bounded samples against the selected main provider, recording local configuration-bound
observations used by advertised capabilities. Empirical tool/parallel/JSON/cache observations
are not guarantees; native strict-format support stays unknown, and missing evidence retains
labelled unverified defaults. See [R10d limits and cache semantics](docs/plans/R10d.md).

AgentRig is a working agentic coding harness: a TypeScript SDK core plus a thin CLI for running coding agents interactively or headlessly. It combines a persistent, replayable agent loop with two built-in systems that are usually external to a harness:

- a **supervisor loop** that observes the session out-of-band, detects stalls, loops, drift, and budget pressure, then escalates from guidance and replanning through review or abort;
- an **LLM Wiki memory** that keeps immutable session sources and a human-readable Markdown wiki, retrieves with index + BM25 search, records failed attempts, and runs reviewable “dream” consolidation on a copy.

The harness supports Anthropic, OpenAI-compatible APIs and local servers, and experimental browser OAuth for a ChatGPT subscription. It includes tool permissions, budgets, compaction and resume, an interactive TUI, JSONL event logs, session replay, hooks, MCP tools, context-isolated subagents, and on-demand Markdown skills.

**Status: all milestones M0 through M7 are complete.** See [`docs/STATUS.md`](docs/STATUS.md) for implementation notes and known caveats, and [`docs/PLAN.md`](docs/PLAN.md) for the original specification.

## Quickstart

AgentRig requires Node.js 22+ and pnpm. From this checkout:

```sh
pnpm install
pnpm build
```

The examples below use the package's `agentrig` binary. Before the package is linked or installed, run `node packages/cli/dist/index.js` in its place.

Sign in once with the experimental ChatGPT subscription provider. AgentRig opens a browser and stores the resulting credential locally:

```sh
agentrig login openai-chatgpt
```

Then use either of the two run modes:

```sh
# One task, non-interactive
agentrig run "inspect the project and fix the failing tests" \
  --provider openai-chatgpt --model gpt-5.6-sol

# Interactive TUI (the default when no command is given)
agentrig --provider openai-chatgpt --model gpt-5.6-sol
```

`login openai-chatgpt --no-browser` prints the sign-in URL instead of opening it. `login openai-chatgpt --export` prints the stored token bundle for seeding `AGENTRIG_OPENAI_CHATGPT_TOKEN` in another environment. Anthropic uses `ANTHROPIC_API_KEY`; OpenAI-compatible mode uses `OPENAI_API_KEY`, or `--base-url` for a local server.

## Commands

- `agentrig run --ci --task-file task.txt --report report.md` — explicit bounded
  non-interactive task-file/event mode; unresolved asks fail closed and reports
  never overwrite existing files. Optional PR comments require an explicit target
  and exec/net authorization. [CI mode and Actions example](docs/CI-MODE.md).

- `agentrig review [--base main | --pr 12] [--comment]` — one bounded advisory
  supervisor-role diff review; `/review` does the same while the TUI is idle.
  Default includes tracked HEAD-to-worktree text changes only (not untracked files).
  PR reads and explicit comments require `--allow exec --allow net`; headless asks deny.
  No tests or edits run. Binary/oversized/unsupported patches and Git filter-configured
  repositories refuse rather than silently omitting coverage. Uses time/per-response
  limits; configured total-session token/USD caps explicitly refuse. See [R15e](docs/plans/R15e.md).

The agent can ask [structured questions](docs/QUESTIONS.md) in the TUI or an opted-in
ACP client. Headless runs fail unanswered questions unless an explicit literal
`--answer-policy first-option|file:<path>` is selected; answers never grant tools permission.

`agentrig acp` embeds the same controller in ACP v1 editors over stdio, retaining
configured permissions and per-project trust. See the [ACP guide](docs/ACP.md)
for the scripted client, existing-pin MCP requirements and transport limits.

`agentrig mcp-serve` exposes four bounded tools to modern and legacy stdio MCP
clients under configured permissions. Client tasks remain advisory, never human
approval. See [MCP serving](docs/MCP-SERVE.md) for limits and sensitive-data handling.

Optional `--otel-endpoint <url>` exports bounded metadata-only OTLP/HTTP JSON traces.
It is off unless explicitly requested; see [telemetry privacy and limits](docs/OTEL.md).

- `agentrig` — start the interactive TUI.
- `agentrig run <task>` — run one task non-interactively; add `--headless` to guarantee that permission prompts resolve to deny, `--json` for raw event JSONL, or `--verbose` for the full trace.
- `agentrig login <provider>` — authenticate a subscription provider. The implemented login provider is `openai-chatgpt`.
- `agentrig sessions ls` / `show <id>` / `resume <id> [task...]` — inspect, replay, or continue stored sessions. `run --resume <id>` is the other resume form.
- `agentrig memory init|ls|show|search|promote|lint|ingest` — create, inspect, search, maintain, or populate the Markdown wiki.
- `agentrig dream` — run structural and model-backed wiki consolidation on a copy; review is the default and `--auto` applies it while retaining the previous wiki.
- `agentrig dream --skill-candidates --structural-only` — report [evidence-backed procedures](docs/plans/R6a.md) without model calls or skill emission. Model classification/effect review is opt-in and shares `--dream-limits`; explicitly budget three calls (four with global promotion) for a complete pass.
- `agentrig dream --emit-skills --structural-only` — preview [reviewed skill emission](docs/plans/R6b.md). After reading every file, rerun with `--emit-skills --apply <printed-digest> --dream-limits '{"maxCalls":3}'` (without `--structural-only`). Fresh evidence/effect checks are mandatory; edited/locked files are preserved and skills are not activated.
- `agentrig run "review this release" --generated-skills --allow skill` — explicitly [load generated skills](docs/plans/R6c.md) from trusted selected memory and safe home. Discovery and permission are separate; successful model loads record `generated: true` as a manifest label, not approval or evidence of benefit. Default discovery of generated roots remains off.
- `agentrig memory reset-dream-stamp --dir <memory-dir>` — preview a scheduling reset. Stop running/scheduled dreams, then add `--confirm` to archive the regular `.last-dream` file in a named sibling backup and reset cadence. It never initializes missing wikis or removes locks; symlinks and special files require manual inspection.
- `agentrig memory discard-dream <outputRoot>` — preview one registered review artifact. After stopping its users, repeat with the displayed `--owner <uuid> --confirm` to discard that copy and sidecar. Only explicitly released or exited same-host producers are eligible. Source wikis, install backups and writer locks are never removed.

The CLI also exposes provider, permission, budget, output, and command-specific controls through its generated command help.

Dream log capacity is checked before paid consolidation. If the log needs more room, deliberately
raise `dreamScanLimits.maxFileBytes` (or `--dream-scan-limits '{"maxFileBytes":16777216}'`);
other scan caps may also need adjustment. History is never automatically truncated. The stamp
reset above repairs scheduling metadata, not log capacity, abandoned workspaces or writer locks.
If a scheduler reports an unreadable or oversized `.last-dream`, inspect that file and use the
confirmed reset above only after stopping running/scheduled dreams. Backups require filesystem
hard-link support and permission; failure leaves the original stamp in place. Dream log dates
mark consolidation start, not the later append/completion time.

Workspace recovery is single-host, same-PID-namespace coordination on a local filesystem, not a
distributed lease or authentication protocol. New manifests record producer ownership; normal
`runDream` completion/retained failure hands it off. SDK `copyWiki` users call `workspace.release()`
when done producing, or dispose through their runtime handle. Legacy, malformed, unregistered,
foreign-host or ambiguous artifacts require manual inspection. Existing locks are never reclaimed,
even if a producer crashed: stop **all** writers before manually recovering the exact named lock.
Automatic interrupted-install recovery is deferred; this command only discards the output copy.

## Optional run flag groups

These flags are available on both `run` and the interactive TUI (and on `sessions resume`):

- **Memory:** `--memory <dir>` injects a wiki index and enables its read/search tools. `--ingest-on-end` distils the completed session into that wiki. `--dream-on-end` runs a due dream in report-only mode; `--dream-every-sessions <n>` and `--dream-every-hours <n>` set its cadence, while `--dream-structural-only` skips the model-backed pass.
- **Promotion:** `agentrig memory promote <path>` previews runtime-backed claim evidence. Review the excerpts, then add `--confirm` to publish the checked artifact. Citations alone cannot authorize promotion; unsupported paraphrases remain ineligible under the conservative initial gate. See [H4](docs/plans/H4.md).
- **Memory writes:** replacement tools require `if_version` from `memory_read`; omitted/null creates only. Conflicts return current content and its version for an intentional merge/retry. See [H5](docs/plans/H5.md) for cooperative locking and the remaining maintenance work.
- **Budgets:** the interactive TUI defaults to 50 turns; non-interactive `run` and `sessions resume` default to 300 so unattended PR work has enough headroom. `--max-turns <n>` and config/profile values override either default.
- **Supervisor:** `--supervise` attaches heuristic detectors and the escalating policy ladder, which tops out at escalation by default. `--supervisor-abort` opts into its final abort rung; `--supervisor-no-abort` remains a compatibility no-op. `--supervisor-soft <fraction>` sets the proportional soft budget threshold; `--supervisor-turns-remaining <n>` also warns when the fixed turn wrap-up window is reached (15 by default). `--supervisor-review` enables the token-using trajectory reviewer and rubric grader rungs.
- **Auxiliary work:** reviewer/grader calls are bounded and cancelled when main work ends. Their usage is recorded separately from main-model tokens; unfinished or unreported usage is marked unknown, not free. See [H5d](docs/plans/H5-auxiliary-lifecycle.md) for SDK limits and cancellation guarantees.
- **Skills:** repeat `--skills <dir>` to discover Markdown skills from multiple roots. Earlier directories shadow later ones; equal-directory duplicate names (case-insensitive) reject both. Only the compact catalogue is injected, and the agent loads a selected skill on demand. Plain Markdown remains supported; present frontmatter must validate as the [flat v1 format](docs/plans/R5e.md), otherwise the entire skill is rejected. Unsupported permission fields such as `allowed-tools` never silently disappear.
  Optional `trigger: When reviewing a release` adds an inert bounded [routing hint](docs/plans/R6g.md); generated-v1 metadata uses the string `agentrig-trigger` instead. A catalogue example shows a real listed skill's first call. Hints never grant permissions or attest benefit; hand-added hints remain human edits during regeneration.
- **Subagents:** `--subagents` adds the context-isolated `subagent` tool. `--subagent-max-turns <n>` limits each child and `--subagent-max-children <n>` limits the total children a session may run.
- **Providers per role (config only):** a `providers` map names entries, and `roles` picks one per role. A child may be spawned on any named entry; the spawn tool lists them. Example:

  ```json
  {
    "providers": {
      "cloud": { "provider": "openai-chatgpt", "model": "gpt-5.6-sol", "reasoningEffort": "max" },
      "local": { "provider": "openai", "baseUrl": "http://127.0.0.1:8080/v1", "model": "qwen3.8-27b", "contextWindow": 98304 }
    },
    "roles": { "main": "cloud", "supervisor": "cloud", "memory": "cloud", "subagents": "local" }
  }
  ```

  Typed `--provider`/`--model`/`--base-url` flags pin the main role to those values; other roles keep their entries. `agentrig doctor` checks every entry.
- **MCP:** `--mcp-config <path>` supports stdio (`exec`) and remote Streamable HTTP (`net`), including external advisory resources and prompts. Remote discovery requires network permission before connection. `agentrig mcp login <server> --mcp-config <path> --allow net` explicitly prints an OAuth browser URL; ordinary runs never register or open a browser. All advertised lists are pinned and changed definitions require separate consent. See [configuration and limits](docs/plans/R15d.md).
- **Shell:** `--shell <path>` chooses the shell used by the `bash` tool instead of the platform default (`/bin/sh` on POSIX; Git Bash, then PowerShell, then `cmd.exe` on Windows).

## Development

### Trusted extensions

Local bundles install with `agentrig package add ./bundle --trust` (or a local npm `.tgz`).
The mandatory `package.json` includes `{"name":"my-bundle","version":"1","agentrig":{"apiVersion":1}}`.
Supported content is `extensions/`, `skills/`, `prompts/` and README/LICENSE files. Scripts,
runtime dependencies and unsafe archive entries refuse; installation never runs bundled code.
This is create-only under `.agentrig/packages/`: existing packages and edits are preserved.
Trusted runs discover verified package extensions/skills; `--no-packages` or config
`"packages": false` disables that discovery. `--trust` remains per-invocation, not a persisted
approval. Prompts are stored inertly, not injected. `doctor` checks content hashes without
importing extensions; hashes detect changes, not authenticity. See [package limits](docs/plans/R5c.md).

`--extension ./hello.mjs` activates a local ES module with a mandatory `hello.json` sidecar.
Trusted projects also load `.agentrig/extensions/*.mjs`; `--no-extension-discovery` disables
that discovery. **This is ambient host code with access to credentials, environment and files,
not sandboxed code.** Startup prints this warning before import and refuses extensions unless
the sandbox is `none`, independently of YOLO. No home discovery or automatic package download.

```json
{"name":"hello","version":"1","apiVersion":1,"surfaces":["commands"]}
```

```js
// hello.mjs — /hello World in the TUI prints a greeting
export function activate(ctx) {
  ctx.registerCommand({ name: "hello", summary: "Say hello",
    run(args, io) { io.print(`Hello ${args}`); } });
}
```

The [R5a contract](docs/plans/R5a.md) covers hooks/tools, manifest limits, atomic activation,
CLI/config precedence, session receipts and child non-inheritance. Failed activation publishes
no partial surfaces. [R5b failure isolation](docs/plans/R5b.md) disables an extension's handlers
after a throw or existing hook timeout until a new agent build. Expected error results and user
abort do not disable it. Idle slash failures print immediately and are audited on the next run;
this is exception containment, not isolation from trusted code's ambient host effects.

Sandbox modes constrain supported tool effects, not arbitrary JavaScript in the harness process.
The additive `net` permission defaults to ask and is distinct from legacy `network`.
`--allow net` (or YOLO) does not enable sandbox networking: an enforcing sandbox also requires
explicit `--sandbox-network` / config `sandboxNetwork: true`. Conversely that policy flag grants
no tool permission. A separately approved one-time sandbox escape executes outside the sandbox;
mode `none` provides no OS isolation. See [R11a's boundaries](docs/plans/R11a.md).
The built-in `web_fetch` uses that class for GET-only HTTP(S): no redirects, credentials or
custom headers; text/plain and text/html only, 1 MiB decoded body, 20,000 returned characters,
10-second deadline. HTML is lexical text extraction, not browser rendering. It is trusted host
network I/O, not OS-contained JavaScript or SSRF protection; internal destinations are not filtered.
See [R11b](docs/plans/R11b.md) for output/provenance and cancellation limits.
Process stdout/stderr and exit codes do not authenticate sandbox denials. Docker/Seatbelt
command failures stay ordinary tool failures, even if they print “Read-only file system”;
only independently established broker/policy/launcher refusals trigger sandbox-denial consent.
See [H7b](docs/plans/H7b.md) for this conservative evidence boundary.
Built-in file writes and shell launches use Docker on Linux or Seatbelt on macOS. Unsupported
tools (including memory writes and network-backed memory searches) require explicit outside-sandbox approval, even with
`--yolo`; headless runs deny that escalation. Host hooks, including `--ingest-on-end` and
`--dream-on-end`, and stdio MCP startup are refused with an enforcing sandbox selected. Remote
MCP uses trusted host HTTP, not OS-contained execution, and requires explicit `--sandbox-network`
as well as network permission. Use
`--sandbox none` explicitly when accepting those host effects. SDK code, provider calls and
session bookkeeping remain trusted host operations; extensions are not isolated by this boundary.
Local memory reads/searches and subagents that inherit or narrow the sandbox remain available.
The CLI disables Lore recall in enforcing modes and uses local search; SDK callers supplying a
network backend themselves encounter the outside-sandbox approval gate.

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm demo
```

The monorepo packages are `core`, `memory`, `supervisor`, and `cli`.

Export a finished session without loading providers or configuration:

```sh
agentrig sessions export SESSION --format jsonl > transcript.jsonl
agentrig sessions export SESSION --format sharegpt --redact-file known-secrets.json
agentrig sessions export SESSION --format md --omit-opaque > transcript.md
```

Exports use materialized fork/compaction messages and versioned canonical fields for lossless
supported-content round trips. Credential redaction is heuristic: unknown secrets may remain,
so inspect before sharing and supply known literals as a JSON string array with `--redact-file`.
Images refuse unless `--omit-opaque` explicitly requests lossy placeholders; unknown future
content always refuses. Redaction and omission are irreversible; raw logs are not scrubbed.
See [R9a](docs/plans/R9a.md) for formats, bounds and the data-only provenance boundary.

Evaluate explicitly mapped session baselines against a supported profile (preview
by default, no historic tool replay):

```sh
agentrig eval SESSION --against candidate --fixtures fixtures.json --output ./new-evaluation
# After inspecting the preview, opt in to provider use and explicit scheduling limits:
agentrig eval SESSION --against candidate --fixtures fixtures.json --output ./new-evaluation --execute --batch-tokens 100000 --batch-minutes 10
```

Execution requires Linux Docker and already-local pinned images. The shipped worker
supports X tasks; A tasks require a matching offline dependency image. Independent
checks determine outcomes; M6 grading is advisory. See the [fixture/profile contract](docs/plans/R9b.md)
for supported options, human gates, accounting and isolation limitations.

The **Nightly structure regression** workflow runs at 03:17 UTC, on manual dispatch,
PRs and main pushes. It combines the eight-task structural suite and injection controls
with scripted Linux-container PASS/FAIL/human-PENDING checks, retaining bounded evidence
even when a control fails. It needs no model credentials and measures mechanics, not
model quality. See [R9c](docs/plans/R9c.md) for the local runner and scheduling limits.
