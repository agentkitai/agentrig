import { spawn } from "node:child_process";
import { resolveShell, syntaxHint } from "./shell.js";
import { z } from "zod";
import type { Tool, ToolResult } from "../tool.js";
import { bound } from "./shared.js";
import type { JobRegistry } from "./background-jobs.js";

const BashInput = z.object({
  command: z.string().min(1).describe("The shell command to run"),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(600_000)
    .optional()
    .describe("Kill the command after this many milliseconds (default 120000). Ignored when background is true."),
  background: z
    .boolean()
    .optional()
    .describe(
      "Start the command as a background job and return its id immediately instead of waiting. " +
        "No timeout applies; poll or stop it with the bash_job tool. Use for anything long-running " +
        "(external reviewers, builds, watchers) or to run several commands concurrently.",
    ),
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
  /** An explicit shell — a path or a bare name. Defaults per platform; see `resolveShell`. */
  shell?: string;
  /** Defaults to `existsSync`, for probing the Windows candidates. */
  shellExists?: (path: string) => boolean;
  env?: NodeJS.ProcessEnv;
  /** Where `background: true` jobs live. Without one, background requests are refused honestly. */
  jobs?: JobRegistry;
}

export function bashTool(opts: BashToolOptions = {}): Tool<BashInput, BashOutput> {
  const platform = opts.platform ?? process.platform;
  const isWindows = platform === "win32";
  const killTree = opts.killTree ?? defaultKillTree;
  const shell = resolveShell({
    ...(opts.shell === undefined ? {} : { shell: opts.shell }),
    platform,
    ...(opts.shellExists === undefined ? {} : { exists: opts.shellExists }),
    ...(opts.env === undefined ? {} : { env: opts.env }),
  });
  return {
    name: "bash",
    // The tool is called `bash` for the same reason it always was — permission rules and every
    // trajectory ever recorded name it — but what actually runs the command is named here, along
    // with the syntax to write. A model told nothing writes bash at `cmd.exe` and is simply wrong.
    description:
      `Run a shell command in the working directory using ${shell.label}, and return its stdout, ` +
      `stderr, and exit code. Write ${syntaxHint(shell.family)}. ` +
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
      if (input.background === true) {
        const empty: BashOutput = { exitCode: null, stdout: "", stderr: "", timedOut: false };
        if (opts.jobs === undefined) {
          return { output: empty, display: "background jobs are not available here", isError: true };
        }
        // timeoutMs is ACCEPTED AND IGNORED here, with a note — a reversal of the original
        // "refuse, because a set timeout must not mean nothing" design, made on field evidence:
        // across two independent dogfood runs, the model on the openai-chatgpt backend inserted
        // timeoutMs into every bash call and could not drop it even when the refusal named the
        // exact fix (15 identical retries in the second run — likely constrained decoding).
        // Auto-killing at the deadline instead would quietly resurrect the ten-minute review
        // massacre this feature exists to end, since the inserted values are capped at 600s.
        // The note keeps the ignore honest; a model that truly wants a bound has bash_job kill.
        const { id, pid } = opts.jobs.start({
          command: input.command,
          shellPath: shell.path,
          cwd: ctx.cwd,
          isWindows,
          killTree,
          signal: ctx.signal,
        });
        const timeoutNote =
          input.timeoutMs === undefined
            ? ""
            : " (note: timeoutMs is ignored for background jobs — they have no deadline; use bash_job to kill one)";
        return {
          output: empty,
          display: `started background job ${id}${pid === undefined ? "" : ` (pid ${pid})`} — check it with bash_job {"id":"${id}","action":"status"}${timeoutNote}`,
        };
      }
      // detached puts the shell in its own process group, so kill reaches the
      // command's children too — a plain child.kill orphans them and they keep
      // the stdio pipes (and the session) open past any timeout.
      const child = spawn(input.command, {
        shell: shell.path,
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
          // no process exists after a failed spawn, and child.kill() on Node's uninitialized
          // handle can issue kill(0) — SIGKILL to our own process group (see background-jobs.ts)
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
      const fullDisplay = parts.filter(Boolean).join("\n").trim() || "(no output)";
      const { display, truncated } = bound(fullDisplay);
      const result: ToolResult<BashOutput> = { output, display };
      if (truncated) {
        result.truncated = true;
        result.fullDisplay = fullDisplay;
      }
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
