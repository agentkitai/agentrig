import { spawn } from "node:child_process";
import { z } from "zod";
import type { Tool, ToolResult } from "../tool.js";
import { bound } from "./shared.js";

/**
 * Background jobs for the `bash` tool.
 *
 * Why this exists: the foreground tool holds the whole agent loop while a command runs, so it has
 * a hard 10-minute ceiling — and a real dogfood run watched that ceiling kill a 12-minute external
 * code review at minute ten. Anything long (an external reviewer, a build farm, a watcher) either
 * blocks every other tool call or dies. A background job starts, returns a handle immediately, and
 * the model polls it with `bash_job` between other work — two reviews run concurrently and the
 * wall-clock cost is the slower one, not the sum.
 *
 * Lifecycle: a job survives across turns (that is the point), dies with the session's abort
 * signal (an aborted session must not leave invisible work running and billing), and is reaped at
 * process exit as a last resort. Output accumulates in a bounded buffer and is handed over
 * INCREMENTALLY — each status call returns what arrived since the previous one, so polling does
 * not resend the transcript-so-far every time (the same context economy eviction bought).
 */

/** Unread output kept per job. Beyond it the OLDEST unread bytes drop, counted, never silently. */
const MAX_UNREAD_BYTES = 512 * 1024;

interface JobSpawnOptions {
  command: string;
  shellPath: string;
  cwd: string;
  isWindows: boolean;
  killTree: (pid: number) => void;
  /** The session abort signal of the starting call; the job dies with it. */
  signal: AbortSignal;
}

interface JobRecord {
  id: string;
  command: string;
  pid: number | undefined;
  unread: string;
  droppedBytes: number;
  exited: boolean;
  exitCode: number | null;
  killGroup: () => void;
  /** Resolves when the pipes close; `wait` races it against its deadline. */
  done: Promise<void>;
  detachAbort: () => void;
}

/** Registries whose jobs are still live, for the one process-exit reaper. */
const liveRegistries = new Set<JobRegistry>();
let reaperInstalled = false;
function installReaper(): void {
  if (reaperInstalled) return;
  reaperInstalled = true;
  // 'exit' allows only synchronous work; killGroup is a synchronous process.kill
  process.on("exit", () => {
    for (const registry of liveRegistries) registry.disposeAll();
  });
}

export class JobRegistry {
  private readonly jobs = new Map<string, JobRecord>();
  private nextId = 1;

  start(opts: JobSpawnOptions): { id: string; pid: number | undefined } {
    const id = `job-${this.nextId++}`;
    const child = spawn(opts.command, {
      shell: opts.shellPath,
      cwd: opts.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      // same grouping rationale as the foreground path: kill must reach the command's children
      detached: !opts.isWindows,
      windowsHide: true,
    });

    const killGroup = (): void => {
      const pid = child.pid;
      if (pid === undefined) {
        child.kill("SIGKILL");
        return;
      }
      if (opts.isWindows) {
        opts.killTree(pid);
        return;
      }
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };

    const record: JobRecord = {
      id,
      command: opts.command,
      pid: child.pid,
      unread: "",
      droppedBytes: 0,
      exited: false,
      exitCode: null,
      killGroup,
      done: Promise.resolve(),
      detachAbort: () => {},
    };

    const append = (chunk: Buffer): void => {
      record.unread += chunk.toString("utf8");
      const over = Buffer.byteLength(record.unread, "utf8") - MAX_UNREAD_BYTES;
      if (over > 0) {
        // drop the oldest unread output, but never silently — the count reaches the next status
        record.droppedBytes += over;
        record.unread = record.unread.slice(-MAX_UNREAD_BYTES);
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    // a background child must never crash the harness; the error shows up as a dead job instead
    child.on("error", () => {});

    const onAbort = (): void => killGroup();
    opts.signal.addEventListener("abort", onAbort, { once: true });
    record.detachAbort = () => opts.signal.removeEventListener("abort", onAbort);

    record.done = new Promise<void>((res) => {
      let code: number | null = null;
      child.on("exit", (c) => {
        code = c;
        // same grace-then-sever as the foreground path: a daemonized grandchild holding the
        // pipes must not keep the job "running" forever
        setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
        }, 200).unref();
      });
      child.on("close", () => {
        record.exited = true;
        record.exitCode = code;
        record.detachAbort();
        res();
      });
    });

    this.jobs.set(id, record);
    liveRegistries.add(this);
    installReaper();
    return { id, pid: child.pid };
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  ids(): string[] {
    return [...this.jobs.keys()];
  }

  /** Hands over everything unread and resets the buffer — each poll sees only what is new. */
  read(id: string): { output: string; droppedBytes: number } | undefined {
    const record = this.jobs.get(id);
    if (record === undefined) return undefined;
    const output = record.unread;
    const droppedBytes = record.droppedBytes;
    record.unread = "";
    record.droppedBytes = 0;
    return { output, droppedBytes };
  }

  kill(id: string): boolean {
    const record = this.jobs.get(id);
    if (record === undefined) return false;
    if (!record.exited) record.killGroup();
    return true;
  }

  /** Kills every job still running. Synchronous, so the process-exit reaper can call it. */
  disposeAll(): void {
    for (const record of this.jobs.values()) {
      if (!record.exited) record.killGroup();
      record.detachAbort();
    }
    liveRegistries.delete(this);
  }
}

const BashJobInput = z.object({
  id: z.string().min(1).describe("The job id returned when the command was started with background: true"),
  action: z.enum(["status", "kill"]).describe("status: report state and NEW output since the last status; kill: stop the job"),
  waitMs: z
    .number()
    .int()
    .positive()
    .max(300_000)
    .optional()
    .describe("With status: block up to this long for the job to exit before reporting (returns early on exit)"),
});
type BashJobInput = z.infer<typeof BashJobInput>;

export interface BashJobOutput {
  id: string;
  running: boolean;
  exitCode: number | null;
  /** Output that arrived since the previous status call. */
  output: string;
  /** Unread bytes that overflowed the buffer and were dropped, oldest first. */
  droppedBytes: number;
}

export function bashJobTool(registry: JobRegistry): Tool<BashJobInput, BashJobOutput> {
  return {
    name: "bash_job",
    description:
      "Manage a background job started by `bash` with background: true. " +
      "`status` reports whether it is running, its exit code once done, and the output that arrived " +
      "since the last status call (pass waitMs to block until it exits, up to 5 minutes per call); " +
      "`kill` stops the job and its process group.",
    inputSchema: BashJobInput,
    permission: "exec",
    async execute(input, ctx): Promise<ToolResult<BashJobOutput>> {
      const record = registry.get(input.id);
      if (record === undefined) {
        const known = registry.ids();
        return {
          output: { id: input.id, running: false, exitCode: null, output: "", droppedBytes: 0 },
          display: `no such job: ${input.id}${known.length === 0 ? "" : ` (known: ${known.join(", ")})`}`,
          isError: true,
        };
      }

      if (input.action === "kill") {
        registry.kill(input.id);
        // collect what the job managed to say before dying, so a kill is not also a data loss
        await record.done.catch(() => {});
        const drained = registry.read(input.id)!;
        const output: BashJobOutput = {
          id: input.id,
          running: false,
          exitCode: record.exitCode,
          output: drained.output,
          droppedBytes: drained.droppedBytes,
        };
        const { display, truncated } = bound(
          [`killed ${input.id}`, drained.output].filter(Boolean).join("\n"),
        );
        const result: ToolResult<BashJobOutput> = { output, display };
        if (truncated) result.truncated = true;
        return result;
      }

      if (input.waitMs !== undefined && !record.exited) {
        // race the job against the deadline; the session abort also releases the wait, because a
        // status call must never wedge shutdown
        await Promise.race([
          record.done,
          new Promise<void>((res) => {
            const timer = setTimeout(res, input.waitMs);
            timer.unref?.();
            ctx.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              res();
            }, { once: true });
          }),
        ]);
      }

      const drained = registry.read(input.id)!;
      const running = !record.exited;
      const output: BashJobOutput = {
        id: input.id,
        running,
        exitCode: record.exitCode,
        output: drained.output,
        droppedBytes: drained.droppedBytes,
      };
      const headline = running
        ? `${input.id} running`
        : `${input.id} exited with code ${record.exitCode ?? "none"}`;
      const parts = [headline];
      if (drained.droppedBytes > 0) parts.push(`[${drained.droppedBytes} bytes of older output dropped]`);
      if (drained.output !== "") parts.push(drained.output);
      else parts.push("(no new output)");
      const { display, truncated } = bound(parts.join("\n").trim());
      const result: ToolResult<BashJobOutput> = { output, display };
      if (truncated) result.truncated = true;
      // a non-zero exit is the job's outcome, not a tool failure: the model asked for status and
      // got an honest one; isError here would push a retry reflex at a finished job
      return result;
    },
  };
}
