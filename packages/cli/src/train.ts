import { fileURLToPath } from "node:url";
import { runTrain } from "@agentkitai/agentrig-core";
import type { Command } from "commander";

/** Queue policy and execution live in the SDK; the CLI only wires I/O. */
export function registerTrainCommand(program: Command): void {
  program.command("train <dir>")
    .description("Drain validated queue rows through headless ship; stop on an unverified landing")
    .action(async (directory: string) => {
      const result = await runTrain(directory, {
        cli: fileURLToPath(new URL("./index.js", import.meta.url)),
        status: status => { process.stdout.write(JSON.stringify({ type: "train.status", ...status }) + "\n"); },
      });
      process.stdout.write(JSON.stringify({ type: "train.end", reason: result }) + "\n");
      if (result === "halted") process.exitCode = 1;
    });
}
