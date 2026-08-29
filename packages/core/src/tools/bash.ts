import { spawn } from "node:child_process";
import { z } from "zod";
import type { Tool, ToolResult } from "../tool.js";
import { bound } from "./shared.js";

const BashInput = z.object({
  command: z.string().min(1).describe("The shell command to run"),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(600_000)
    .optional()
    .describe("Kill the command after this many milliseconds (default 120000)"),
});
type BashInput = z.infer<typeof BashInput>;

export interface BashOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function bashTool(): Tool<BashInput, BashOutput> {
  return {
    name: "bash",
    description:
      "Run a shell command in the working directory and return its stdout, stderr, and exit code. " +
      "Non-zero exits are reported as errors with the output attached.",
    inputSchema: BashInput,
    permission: "exec",
    async execute(input, ctx): Promise<ToolResult<BashOutput>> {
      const timeoutMs = input.timeoutMs ?? 120_000;
      const child = spawn(input.command, {
        shell: true,
        cwd: ctx.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      const onAbort = () => child.kill("SIGKILL");
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      const exitCode = await new Promise<number | null>((res, rej) => {
        child.on("error", rej);
        child.on("close", (code) => res(code));
      }).finally(() => {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
      });

      const output: BashOutput = { exitCode, stdout, stderr, timedOut };
      const parts = [stdout];
      if (stderr) parts.push(stderr ? `[stderr]\n${stderr}` : "");
      if (timedOut) parts.push(`[killed: timed out after ${timeoutMs}ms]`);
      if (exitCode !== 0) parts.push(`[exit code ${exitCode ?? "none"}]`);
      const { display, truncated } = bound(parts.filter(Boolean).join("\n").trim() || "(no output)");
      const result: ToolResult<BashOutput> = { output, display };
      if (truncated) result.truncated = true;
      if (exitCode !== 0 || timedOut) result.isError = true;
      return result;
    },
  };
}
