import { profileChildEnv, resolveChildEnv, reviewerHome } from "./child-env.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseConfigText } from "./config.js";
import { fileURLToPath } from "node:url";
import { runTrain, trainStatus } from "@agentkitai/agentrig-core";
import { resolveTrainTestTimeout } from "./project-checks.js";
import type { Command } from "commander";

/** Queue policy and execution live in the SDK; the CLI only wires I/O. */
export function registerTrainCommand(program: Command): void {
  program.command("train <dir>")
    .description("Drain validated queue rows through headless ship; stop on an unverified landing")
    .option("--status", "show queue counts and per-row/session usage without dispatch")
    .action(async (directory: string, flags: { status?: boolean }) => {
      if (flags.status) { console.log(JSON.stringify(await trainStatus(directory))); return; }
      const result = await runTrain(directory, {
        childEnv: resolveTrainChildEnv,
        testTimeout: resolveTrainTestTimeout,
        cli: fileURLToPath(new URL("./index.js", import.meta.url)),
        status: status => { process.stdout.write(JSON.stringify({ type: "train.status", ...status }) + "\n"); },
      });
      process.stdout.write(JSON.stringify({ type: "train.end", reason: result }) + "\n");
      if (result === "halted") process.exitCode = 1;
    });
}

/** Resolve only user identity settings; project config contributes slot requirements, not homes. */
export async function resolveTrainChildEnv(checkout: string, profile?: string, home?: string, inherited: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  const env = resolveChildEnv(await profileChildEnv(checkout, profile, home), inherited);
  let text: string;
  try { text = await readFile(join(checkout, ".agentrig/config.json"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return env; throw error; }
  const config = parseConfigText(join(checkout, ".agentrig/config.json"), text);
  for (const [slot, binding] of Object.entries(config.reviewers ?? {})) {
    try { reviewerHome(binding.adapter, env); } catch (error) { throw new Error(`reviewers:${slot}: ${(error as Error).message}`); }
  }
  return env;
}
