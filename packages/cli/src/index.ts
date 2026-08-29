#!/usr/bin/env node
import { Command } from "commander";
import { SessionStore } from "@agentkitai/agentrig-core";
import { renderEvent } from "./render.js";
import { runCommand, type RunOptions } from "./run.js";

const program = new Command();
program.name("agentrig").description("AgentRig — agentic harness with a built-in supervisor loop and LLM Wiki memory");

function withRunOptions(cmd: Command): Command {
  return cmd
    .option("--headless", "never prompt; `ask` permissions resolve to deny (also implied when stdin is not a TTY)")
    .option("--json", "emit raw event JSONL to stdout")
    .option("-p, --provider <provider>", "model provider: anthropic | openai (OpenAI-compatible)", "anthropic")
    .option("-m, --model <model>", "model id", process.env.AGENTRIG_MODEL ?? "claude-sonnet-5")
    .option("--base-url <url>", "OpenAI-compatible server URL (e.g. http://localhost:11434/v1)")
    .option("-r, --root <dir>", "sessions directory", ".agentrig/sessions")
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
    .option("--max-tokens-per-turn <n>", "max_tokens per model response", "8192");
}

withRunOptions(
  program.command("run <task>").description("Run the agent on a task (headless; the interactive TUI lands in M7)"),
)
  .option("--resume <id>", "continue an existing session from its snapshot")
  .action(async (task: string, opts: RunOptions) => runCommand(task, opts));

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

const sessions = program.command("sessions").description("Inspect session event logs");

withRunOptions(
  sessions
    .command("resume <id> [task...]")
    .description("Continue a session from its snapshot; the task becomes the next user message"),
).action(async (id: string, taskWords: string[], opts: RunOptions) =>
  runCommand(taskWords.join(" ") || "Continue the task.", { ...opts, resume: id }),
);

sessions
  .command("ls")
  .option("-r, --root <dir>", "sessions directory", ".agentrig/sessions")
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
  .option("-r, --root <dir>", "sessions directory", ".agentrig/sessions")
  .option("--json", "raw JSONL instead of a timeline")
  .action(async (id: string, opts: { root: string; json?: boolean }) => {
    const store = new SessionStore({ root: opts.root });
    for await (const e of store.read(id)) {
      console.log(opts.json ? JSON.stringify(e) : renderEvent(e));
    }
  });

program.parseAsync(process.argv);
