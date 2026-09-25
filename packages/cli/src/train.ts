import { fileURLToPath } from "node:url";
import { runTrain, trainStatus } from "@agentkitai/agentrig-core";
import { resolveTrainTestTimeout } from "./project-checks.js";
import { join } from "node:path";
import { loadRunConfig, readConfigFile, type LoadRunConfigOptions } from "./config.js";
import { requireReviewerHomes } from "./child-env.js";
import { Command } from "commander";

export async function trainChildEnvironment(checkout: string, profile?: string, options: LoadRunConfigOptions = {}): Promise<NodeJS.ProcessEnv> {
  const env = { ...(options.env ?? process.env) };
  await loadRunConfig(new Command("train"), { profile }, { ...options, cwd: checkout, env, interactive: false });
  // Reviewer declarations are inspected, not executed; profile overrides come only from trusted config.
  const project = await readConfigFile(join(checkout, ".agentrig", "config.json"));
  requireReviewerHomes(project?.reviewers ?? {}, env);
  return env;
}

/** Queue policy and execution live in the SDK; the CLI only wires I/O. */
export function registerTrainCommand(program: Command): void {
  program.command("train <dir>")
    .description("Drain validated queue rows through headless ship; stop on an unverified landing")
    .option("--status", "show queue counts and per-row/session usage without dispatch")
    .action(async (directory: string, flags: { status?: boolean }) => {
      if (flags.status) { console.log(JSON.stringify(await trainStatus(directory))); return; }
      const result = await runTrain(directory, {
        childEnvironment: trainChildEnvironment,
        testTimeout: resolveTrainTestTimeout,
        cli: fileURLToPath(new URL("./index.js", import.meta.url)),
        status: status => { process.stdout.write(JSON.stringify({ type: "train.status", ...status }) + "\n"); },
      });
      process.stdout.write(JSON.stringify({ type: "train.end", reason: result }) + "\n");
      if (result === "halted") process.exitCode = 1;
    });
}
