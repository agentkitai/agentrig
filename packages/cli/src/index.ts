#!/usr/bin/env node
import { Command } from "commander";
import { SessionStore } from "@agentkitai/agentrig-core";
import { renderEvent } from "./render.js";
import { DEFAULT_ANTHROPIC_MODEL, DEFAULT_SESSIONS_DIR, runCommand, type RunOptions } from "./run.js";
import { loginCommand } from "./login.js";
import { dreamCommand, type DreamOptions } from "./dream.js";
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
    .option("--memory <dir>", "inject this memory wiki's index into the system prompt", ".agentrig")
    .option("-r, --root <dir>", "sessions directory", DEFAULT_SESSIONS_DIR)
    .option("--system <prompt>", "override the system prompt")
    .option(
      "--allow <rule>",
      "allow a tool name or permission class, confined to the cwd for paths; append :anywhere to lift (repeatable)",
      collect,
      [],
    )
    .option("--deny <rule>", "deny a tool name or permission class (repeatable)", collect, [])
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
    .option("--dream-structural-only", "the scheduled dream skips the model-backed pass — free, no tokens");
}

// AGENTRIG_MODEL baked into the flag default still counts as an explicit model choice
function modelExplicit(cmd: Command): boolean {
  return cmd.getOptionValueSource("model") !== "default" || process.env.AGENTRIG_MODEL !== undefined;
}

withRunOptions(
  program.command("run <task>").description("Run the agent on a task (headless; the interactive TUI lands in M7)"),
)
  .option("--resume <id>", "continue an existing session from its snapshot")
  .action(async (task: string, opts: RunOptions, cmd: Command) =>
    runCommand(task, { ...opts, modelExplicit: modelExplicit(cmd) }),
  );

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

program
  .command("login <provider>")
  .description("Sign in to a subscription provider (experimental: openai-chatgpt device-code OAuth)")
  .option("--export", "print the stored token bundle (to seed AGENTRIG_OPENAI_CHATGPT_TOKEN) instead of signing in")
  .action(async (provider: string, opts: { export?: boolean }) => loginCommand(provider, opts));

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
  runCommand(taskWords.join(" ") || "Continue the task.", { ...opts, resume: id, modelExplicit: modelExplicit(cmd) }),
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

program.parseAsync(process.argv);
