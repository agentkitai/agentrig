import { Command } from "commander";
import { SessionStore } from "@agentkitai/agentrig-core";
import { renderEvent } from "./render.js";
import { DEFAULT_ANTHROPIC_MODEL, DEFAULT_SESSIONS_DIR, runCommand, type RunOptions } from "./run.js";
import { loginCommand } from "./login.js";
import { dreamCommand, type DreamOptions } from "./dream.js";
import { startTui } from "./tui/start.js";
import {
  memoryIngest,
  memoryInit,
  memoryLint,
  memoryLs,
  memoryPromote,
  memorySearch,
  memoryShow,
  type MemoryIngestOptions,
} from "./memory.js";

/**
 * Builds the command tree without parsing, so a test can drive argv fixtures against it.
 *
 * Extracted after a root-level option regression shipped: options added to the root `program` are
 * consumed by Commander wherever they appear in argv, including after a subcommand name, so every
 * subcommand silently lost `--root`, `--model`, `--max-turns` and the rest. Nothing could catch
 * that, because nothing could parse argv without also running the CLI.
 */
/**
 * The default command catches ANY unmatched argv, so a typo'd subcommand would drop the user
 * into an interactive agent with their intended command silently discarded. Returns the error to
 * report, or null when the operands are genuinely empty (a real bare `agentrig`).
 *
 * Pure so it can be tested directly: an integration test cannot reach it, because stubbing the
 * command tree's actions is the only way to parse argv without launching the CLI.
 */
export function describeStray(args: string[], known: string[]): string | null {
  const stray = args.filter((a) => !a.startsWith("-"));
  if (stray.length === 0) return null;
  const guess = closest(stray[0]!, known);
  return `error: unknown command '${stray[0]!}'${guess === null ? "" : `\n(Did you mean ${guess}?)`}`;
}

/** One-edit-distance-ish suggestion, so a typo gets the same help Commander used to give. */
function closest(input: string, known: string[]): string | null {
  let best: string | null = null;
  let bestScore = Infinity;
  for (const candidate of known) {
    const d = distance(input, candidate);
    if (d < bestScore) {
      bestScore = d;
      best = candidate;
    }
  }
  return best !== null && bestScore <= Math.max(2, Math.floor(input.length / 3)) ? best : null;
}

function distance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j += 1) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      rows[i]![j] = Math.min(
        rows[i - 1]![j]! + 1,
        rows[i]![j - 1]! + 1,
        rows[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return rows[a.length]![b.length]!;
}

export function buildProgram(): Command {
  const program = new Command();
  program.name("agentrig").description("AgentRig — agentic harness with a built-in supervisor loop and LLM Wiki memory");

  function withProviderOptions(cmd: Command): Command {
    return cmd
      .option(
        "-p, --provider <provider>",
        "model provider: anthropic | openai (OpenAI-compatible) | openai-chatgpt (experimental subscription auth)",
        "anthropic",
      )
      .option("-m, --model <model>", "model id", process.env.AGENTRIG_MODEL ?? DEFAULT_ANTHROPIC_MODEL)
      .option("--base-url <url>", "OpenAI-compatible server URL (e.g. http://localhost:11434/v1)");
  }

  function withRunOptions(cmd: Command): Command {
    return withProviderOptions(cmd)
      .option("--headless", "never prompt; `ask` permissions resolve to deny (also implied when stdin is not a TTY)")
      .option("--json", "emit raw event JSONL to stdout")
      .option("--verbose", "show the raw event trace instead of just the conversation")
      .option("--memory <dir>", "inject this memory wiki's index into the system prompt", ".agentrig")
      .option("-r, --root <dir>", "sessions directory", DEFAULT_SESSIONS_DIR)
      .option("--system <prompt>", "override the system prompt")
      .option(
        "--allow <rule>",
        "allow a tool name or permission class, confined to the cwd for paths; append :anywhere to lift (repeatable)",
        collect,
        [],
      )
      .option("--drift-scope <path>", "path the drift detector may change (repeatable)", collect, [])
      .option(
        "--drift-contract <path>",
        "build or test contract path the drift detector watches (repeatable)",
        collect,
        undefined,
      )
      .option("--deny <rule>", "deny a tool name or permission class (repeatable)", collect, [])
      .option(
        "--dangerously-skip-permissions",
        "allow every tool call without asking, including outside the working directory; --deny still applies",
      )
      .option("--yolo", "alias for --dangerously-skip-permissions")
      .option("--max-turns <n>", "turn budget", "50")
      .option("--max-tokens <n>", "token budget (input + output)")
      .option("--max-minutes <n>", "wall-clock budget in minutes")
      .option("--max-usd <n>", "USD budget; requires --price-in/--price-out")
      .option("--price-in <usd>", "input price in USD per million tokens")
      .option("--price-out <usd>", "output price in USD per million tokens")
      .option("--max-tokens-per-turn <n>", "max_tokens per model response", "8192")
      .option("--supervise", "attach the supervisor: heuristic detectors + escalating policy ladder")
      .option("--supervisor-no-abort", "let the supervisor steer and escalate but never abort the session")
      .option("--supervisor-soft <fraction>", "fraction of the budget at which the soft warning trips", "0.8")
      .option(
        "--supervisor-review",
        "enable the LLM-backed supervisor rungs (trajectory reviewer + rubric grader); costs tokens",
      )
      .option("--ingest-on-end", "distil this session into the wiki when it finishes (PLAN §3.2); costs tokens")
      .option("--dream-on-end", "run the scheduled dream when one is due (PLAN §3.7); reports, never applies")
      .option("--dream-every-sessions <n>", "sessions since the last dream before one is due", "10")
      .option("--dream-every-hours <n>", "hours since the last dream before one is due", "24")
      .option("--dream-structural-only", "the scheduled dream skips the model-backed pass — free, no tokens")
      .option("--mcp-config <path>", "JSON file of MCP servers whose tools are added to this session")
      .option("--subagents", "give the agent a `subagent` tool for context-isolated sub-tasks")
      .option("--subagent-max-turns <n>", "turn budget for each subagent", "15")
      .option("--subagent-max-children <n>", "subagents one session may run in total", "8")
      .option("--skills <dir>", "directory of markdown skills; earlier dirs shadow later (repeatable)", collect, [])
      .option(
        "--shell <path>",
        "shell for the `bash` tool (default: /bin/sh; on Windows, Git Bash then PowerShell then cmd)",
      );
  }

  // AGENTRIG_MODEL baked into the flag default still counts as an explicit model choice
  function modelExplicit(cmd: Command): boolean {
    return cmd.getOptionValueSource("model") !== "default" || process.env.AGENTRIG_MODEL !== undefined;
  }

  /** A flag with a default is always "set"; only a typed one is worth warning about. */
  function maxTokensPerTurnExplicit(cmd: Command): boolean {
    return cmd.getOptionValueSource("maxTokensPerTurn") !== "default";
  }

  withRunOptions(
    program.command("run <task>").description("Run the agent on a task, non-interactively"),
  )
    .option("--resume <id>", "continue an existing session from its snapshot")
    .action(async (task: string, opts: RunOptions, cmd: Command) =>
      runCommand(task, {
        ...opts,
        modelExplicit: modelExplicit(cmd),
        maxTokensPerTurnExplicit: maxTokensPerTurnExplicit(cmd),
      }),
    );

  function collect(value: string, prev: string[] = []): string[] {
    return [...prev, value];
  }

  program
    .command("login <provider>")
    .description("Sign in to a subscription provider (experimental: openai-chatgpt browser OAuth)")
    .option("--export", "print the stored token bundle (to seed AGENTRIG_OPENAI_CHATGPT_TOKEN) instead of signing in")
    .option("--no-browser", "print the sign-in URL and wait, without opening a browser")
    .action(async (provider: string, opts: { export?: boolean; browser?: boolean }) =>
      // commander turns `--no-browser` into `browser: false`
      loginCommand(provider, { ...opts, ...(opts.browser === false ? { noBrowser: true } : {}) }),
    );

  const memory = program.command("memory").description("Inspect and maintain the LLM Wiki memory");
  const memoryDir = (cmd: Command): Command =>
    cmd.option("-d, --dir <dir>", "memory directory", ".agentrig");

  memoryDir(memory.command("init").description("Create the .agentrig raw/ + wiki/ layout and SCHEMA.md")).action(
    async (opts: { dir: string }) => memoryInit(opts),
  );
  memoryDir(memory.command("ls").description("List every wiki page from index.md")).action(
    async (opts: { dir: string }) => memoryLs(opts),
  );
  memoryDir(memory.command("show <path>").description("Print one wiki page")).action(
    async (path: string, opts: { dir: string }) => memoryShow(path, opts),
  );
  memoryDir(memory.command("search <query...>").description("Index ∪ BM25 search over the wiki"))
    .option("-k, --k <n>", "max results", "8")
    .action(async (query: string[], opts: { dir: string; k?: string }) => memorySearch(query.join(" "), opts));
  memoryDir(memory.command("promote <path>").description("Promote a wiki page to the backend's shared scope")).action(
    async (path: string, opts: { dir: string }) => memoryPromote(path, opts),
  );
  memoryDir(memory.command("lint").description("Dry-run dream report — structural only, no model call, no output store")).action(
    async (opts: { dir: string }) => memoryLint(opts),
  );
  withProviderOptions(
    memoryDir(memory.command("ingest <sessionId>").description("Distill a session log into the wiki")),
  ).action(async (sessionId: string, opts: MemoryIngestOptions, cmd: Command) =>
    memoryIngest(sessionId, { ...opts, modelExplicit: modelExplicit(cmd) }),
  );

  // PLAN §5: agentrig dream [--review|--auto] [--scope project|global] [--since <n>]
  withProviderOptions(
    program
      .command("dream")
      .description("Scheduled lint: writes a NEW wiki plus a change report; your wiki is untouched unless --auto"),
  )
    .option("-d, --dir <dir>", "memory directory", ".agentrig")
    .option("--review", "report only, leave the dreamt wiki on disk for inspection (default)")
    .option("--auto", "apply the dreamt wiki, keeping the previous one beside it")
    .option("--scope <scope>", "project | global", "project")
    .option("--global <dir>", "global memory directory; enables promotion proposals")
    .option("--since <n>", "cap on raw sessions scanned")
    .option("--structural-only", "skip the model-backed consolidation pass — free, no credential needed")
    .action(async (opts: DreamOptions, cmd: Command) => dreamCommand({ ...opts, modelExplicit: modelExplicit(cmd) }));

  const sessions = program.command("sessions").description("Inspect session event logs");

  withRunOptions(
    sessions
      .command("resume <id> [task...]")
      .description("Continue a session from its snapshot; the task becomes the next user message"),
  ).action(async (id: string, taskWords: string[], opts: RunOptions, cmd: Command) =>
    runCommand(taskWords.join(" ") || "Continue the task.", {
      ...opts,
      resume: id,
      modelExplicit: modelExplicit(cmd),
      maxTokensPerTurnExplicit: maxTokensPerTurnExplicit(cmd),
    }),
  );

  sessions
    .command("ls")
    .option("-r, --root <dir>", "sessions directory", DEFAULT_SESSIONS_DIR)
    .action(async (opts: { root: string }) => {
      const store = new SessionStore({ root: opts.root });
      const refs = await store.list();
      if (refs.length === 0) {
        console.log(`no sessions under ${opts.root}`);
        return;
      }
      for (const r of refs) {
        console.log(`${r.id}\t${new Date(r.updatedAt).toISOString()}\t${r.bytes} B`);
      }
    });

  sessions
    .command("show <id>")
    .option("-r, --root <dir>", "sessions directory", DEFAULT_SESSIONS_DIR)
    .option("--json", "raw JSONL instead of a timeline")
    .action(async (id: string, opts: { root: string; json?: boolean }) => {
      const store = new SessionStore({ root: opts.root });
      for await (const e of store.read(id)) {
        console.log(opts.json ? JSON.stringify(e) : renderEvent(e));
      }
    });

  /**
   * PLAN §5: bare `agentrig` is the interactive TUI.
   *
   * Registered as its own `isDefault` subcommand rather than by putting options on the root
   * program. Options on the root are consumed by Commander *wherever they appear in argv* —
   * including after a subcommand name — unless positional options are enabled. Adding them to the
   * root silently swallowed `--root`, `--model`, `--max-turns` and the rest from every shipped
   * subcommand, which then fell back to its default with no error. An explicit default subcommand
   * keeps the TUI's options on the TUI, and preserves Commander's unknown-command error (and its
   * did-you-mean suggestion) instead of dropping a typo into an interactive agent.
   */
  withRunOptions(program.command("tui", { isDefault: true, hidden: true }).description("Interactive TUI (default)"))
    .action(async (opts: RunOptions, cmd: Command) => {
      // `isDefault` catches ANY unmatched argv, so a typo'd subcommand would otherwise drop the
      // user into an interactive agent with their intended command discarded. Reject leftover
      // operands the way Commander would have, suggestion included.
      const known = program.commands
        .filter((c) => !(c as unknown as { _hidden?: boolean })._hidden)
        .map((c) => c.name());
      const complaint = describeStray(cmd.args, known);
      if (complaint !== null) {
        program.error(complaint);
        return;
      }
      await startTui({
        ...opts,
        modelExplicit: modelExplicit(cmd),
        maxTokensPerTurnExplicit: maxTokensPerTurnExplicit(cmd),
      });
    });


  return program;
}
