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

export interface BashToolOptions {
  /** Defaults to `process.platform`. Injected so the Windows path is testable off Windows. */
  platform?: NodeJS.Platform;
  /** Defaults to `taskkill /pid <pid> /T /F`. Injected for the same reason. */
  killTree?: (pid: number) => void;
}

export function bashTool(opts: BashToolOptions = {}): Tool<BashInput, BashOutput> {
  const isWindows = (opts.platform ?? process.platform) === "win32";
  const killTree = opts.killTree ?? defaultKillTree;
  return {
    name: "bash",
    description:
      "Run a shell command in the working directory and return its stdout, stderr, and exit code. " +
      "Non-zero exits are reported as errors with the output attached.",
    inputSchema: BashInput,
    permission: "exec",
    async execute(input, ctx): Promise<ToolResult<BashOutput>> {
      const timeoutMs = input.timeoutMs ?? 120_000;
      if (ctx.signal.aborted) {
        return {
          output: { exitCode: null, stdout: "", stderr: "", timedOut: false },
          display: "aborted before the command started",
          isError: true,
        };
      }
      // detached puts the shell in its own process group, so kill reaches the
      // command's children too — a plain child.kill orphans them and they keep
      // the stdio pipes (and the session) open past any timeout.
      const child = spawn(input.command, {
        shell: true,
        cwd: ctx.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        // Windows has no process groups, and `detached` there means "survive the parent" plus a
        // console of its own — a flashing window per command, and a child that outlives the
        // session. The tree is killed with `taskkill /T` instead.
        detached: !isWindows,
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));

      const killGroup = () => {
        const pid = child.pid;
        if (pid === undefined) {
          child.kill("SIGKILL");
          return;
        }
        if (isWindows) {
          // `process.kill(-pid)` is not supported here: it throws, and the old catch fell back to
          // killing only the direct child — so `cmd.exe` died and whatever it started kept
          // running, holding the stdio pipes past the timeout that was supposed to end it
          killTree(pid);
          return;
        }
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup();
      }, timeoutMs);
      const onAbort = () => killGroup();
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      const exitCode = await new Promise<number | null>((res, rej) => {
        let code: number | null = null;
        child.on("error", rej);
        child.on("exit", (c) => {
          code = c;
          // `close` waits for the pipes to drain; a survivor outside the killed group
          // (a daemonized grandchild) could hold them forever, so after a short grace
          // period for buffered output we sever the pipes ourselves.
          setTimeout(() => {
            child.stdout.destroy();
            child.stderr.destroy();
          }, 200).unref();
        });
        child.on("close", () => res(code));
      }).finally(() => {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
      });

      const aborted = ctx.signal.aborted;
      const output: BashOutput = { exitCode, stdout, stderr, timedOut };
      const parts = [stdout];
      if (stderr) parts.push(`[stderr]\n${stderr}`);
      if (timedOut) parts.push(`[killed: timed out after ${timeoutMs}ms]`);
      if (aborted) parts.push("[killed: session aborted]");
      if (exitCode !== 0) parts.push(`[exit code ${exitCode ?? "none"}]`);
      const { display, truncated } = bound(parts.filter(Boolean).join("\n").trim() || "(no output)");
      const result: ToolResult<BashOutput> = { output, display };
      if (truncated) result.truncated = true;
      if (exitCode !== 0 || timedOut || aborted) result.isError = true;
      return result;
    },
  };
}

/**
 * Windows' equivalent of killing a process group. Best-effort and never throws into the tool: if
 * `taskkill` is missing the child is killed directly, which is what the old code did for the
 * whole tree.
 */
function defaultKillTree(pid: number): void {
  try {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    // an unhandled `error` event on a ChildProcess is fatal to the process
    killer.on("error", () => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    });
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}
