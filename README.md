# AgentRig

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

- `agentrig` — start the interactive TUI.
- `agentrig run <task>` — run one task non-interactively; add `--headless` to guarantee that permission prompts resolve to deny, `--json` for raw event JSONL, or `--verbose` for the full trace.
- `agentrig login <provider>` — authenticate a subscription provider. The implemented login provider is `openai-chatgpt`.
- `agentrig sessions ls` / `show <id>` / `resume <id> [task...]` — inspect, replay, or continue stored sessions. `run --resume <id>` is the other resume form.
- `agentrig memory init|ls|show|search|promote|lint|ingest` — create, inspect, search, maintain, or populate the Markdown wiki.
- `agentrig dream` — run structural and model-backed wiki consolidation on a copy; review is the default and `--auto` applies it while retaining the previous wiki.
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
- **Skills:** repeat `--skills <dir>` to discover Markdown skills from multiple roots. Earlier directories shadow later ones; only the compact catalogue is injected, and the agent loads a selected skill on demand.
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
- **MCP:** `--mcp-config <path>` starts the stdio MCP servers in the JSON config and adds their namespaced tools to the session. MCP tools use the `exec` permission class.
- **Shell:** `--shell <path>` chooses the shell used by the `bash` tool instead of the platform default (`/bin/sh` on POSIX; Git Bash, then PowerShell, then `cmd.exe` on Windows).

## Development

Sandbox modes constrain supported tool effects, not arbitrary JavaScript in the harness process.
Built-in file writes and shell launches use Docker on Linux or Seatbelt on macOS. Unsupported
tools (including memory writes and network-backed memory searches) require explicit outside-sandbox approval, even with
`--yolo`; headless runs deny that escalation. Host hooks, including `--ingest-on-end` and
`--dream-on-end`, and CLI MCP startup are refused with an enforcing sandbox selected. Use
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
