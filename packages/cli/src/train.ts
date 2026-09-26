import type { Command } from "commander";
import { fileURLToPath } from "node:url";
import { createTrain } from "@agentkitai/agentrig-train";
import { harnessTrainRuntime } from "@agentkitai/agentrig-train/runtime";
import { shipTrainStages } from "@agentkitai/agentrig-ship/train";
import { createTrainHost } from "@agentkitai/agentrig-ship/train-host";
import { resolveConfiguredChildEnvironment } from "./child-env.js";
import { resolveProjectChecks } from "./project-checks.js";

// Snapshot before a row selects its profile; Git/gh/pnpm gates use the launcher account.
export const trainLauncherEnvironment: NodeJS.ProcessEnv = { ...process.env };

export const { runTrain, trainStatus, trainCommand } = createTrain(harnessTrainRuntime, shipTrainStages);
export const { trainChildEnvironment, resolveTrainTestTimeout } = createTrainHost({
  childConfiguration: resolveConfiguredChildEnvironment, projectChecks: resolveProjectChecks,
});

/** Queue policy and execution live in the SDK; the CLI only wires I/O. */
export function registerTrainCommand(program: Command): void {
  program.command("train <dir>")
    .description("Drain validated queue rows through headless ship; stop on an unverified landing")
    .option("--status", "show queue counts and per-row/session usage without dispatch")
    .action(async (directory: string, flags: { status?: boolean }) => {
      if (flags.status) { console.log(JSON.stringify(await trainStatus(directory, { testTimeout: resolveTrainTestTimeout, childEnvironment: trainChildEnvironment }))); return; }
      const result = await runTrain(directory, {
        testTimeout: resolveTrainTestTimeout, childEnvironment: trainChildEnvironment, projectChecks: resolveProjectChecks,
        launcherEnvironment: trainLauncherEnvironment,
        cli: fileURLToPath(new URL("./index.js", import.meta.url)),
        status: status => { process.stdout.write(JSON.stringify({ type: "train.status", ...status }) + "\n"); },
      });
      process.stdout.write(JSON.stringify({ type: "train.end", reason: result }) + "\n");
      if (result === "halted") process.exitCode = 1;
    });
}
