import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import type { ContentBlock } from "./messages.js";
import type { TurnStrategyContext, TurnStrategyResult, TurnToolCall } from "./turn-strategy.js";

// Runtime-only bridge: a model call cannot provide scheduling metadata or skip the pipeline.
const runtimes = new WeakMap<TurnStrategyContext, (calls: readonly TurnToolCall[], limit: number) => Promise<TurnStrategyResult>>();
export function bindParallelRuntime(context: TurnStrategyContext, run: (calls: readonly TurnToolCall[], limit: number) => Promise<TurnStrategyResult>): TurnStrategyContext {
  runtimes.set(context, run); return context;
}
export function parallelRuntime(context: TurnStrategyContext) { return runtimes.get(context); }

export interface SchedulingMetadata { cwd: string; permission: string; effects: string | undefined; paths: string[] | undefined }
export interface PipelineSchedule {
  prepare(): Promise<void>;
  admit(metadata: SchedulingMetadata): Promise<void>;
  authorized(): void;
  finish(): void;
  ask<T>(work: () => Promise<T>): Promise<T>;
}
function mutex() {
  let tail = Promise.resolve();
  return async () => {
    const previous = tail; let release!: () => void;
    tail = new Promise<void>(resolve => { release = resolve; });
    await previous; return release;
  };
}
interface Target { path: string; inode?: string }
interface Hazard { write: boolean; targets: Target[] }
const pathKey = (path: string) => path.normalize("NFC").toLowerCase();
async function classify(metadata: SchedulingMetadata): Promise<Hazard | undefined> {
  const write = metadata.permission === "write" && metadata.effects === "workspace";
  if (!write && !(metadata.permission === "read" && metadata.effects === "read-only")) return undefined;
  if (!Array.isArray(metadata.paths) || metadata.paths.length === 0 || metadata.paths.length > 64) return undefined;
  const targets: Target[] = [];
  for (const path of metadata.paths) {
    if (typeof path !== "string" || path.length === 0 || path.length > 4096 || path.includes("\0")) return undefined;
    const absolute = resolve(metadata.cwd, path);
    try {
      const canonical = await realpath(absolute); const info = await stat(canonical, { bigint: true });
      // A directory traversal may read child symlinks/hardlinks outside the declared tree.
      // Its own inode is not a bounded inventory of those physical targets.
      if (!info.isFile() || info.ino === 0n) return undefined;
      targets.push({ path: pathKey(canonical), inode: `${info.dev}:${info.ino}` });
    } catch (error) {
      if (!write || (error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      // A dangling symlink is not a new ordinary file at this lexical name.
      try { await lstat(absolute); return undefined; }
      catch (missing) { if ((missing as NodeJS.ErrnoException).code !== "ENOENT") return undefined; }
      const name = basename(absolute);
      // No inode exists yet. Do not pretend lowercase is universal Windows name resolution.
      // Conservative on every platform: spelling aliases, streams and device names serialize.
      if (!/^[\x20-\x7e]+$/.test(name) || /[<>:"|?*]|[. ]$/.test(name) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) return undefined;
      // Missing parents may be created recursively; that effect is deliberately exclusive.
      try { targets.push({ path: pathKey(resolve(await realpath(dirname(absolute)), basename(absolute))) }); }
      catch { return undefined; }
    }
  }
  return { write, targets };
}
function conflict(a: Hazard | undefined, b: Hazard | undefined) {
  if (a === undefined || b === undefined) return true;
  if (!a.write && !b.write) return false;
  return a.targets.some(x => b.targets.some(y => x.path === y.path ||
    x.path.startsWith(y.path.endsWith(sep) ? y.path : y.path + sep) ||
    y.path.startsWith(x.path.endsWith(sep) ? x.path : x.path + sep) ||
    (x.inode !== undefined && x.inode === y.inode)));
}

/** One batch, FIFO admission. Never abandon a pipeline promise on failure/cancellation. */
export async function executeParallel(calls: readonly TurnToolCall[], signal: AbortSignal, limit: number,
  runTool: (call: TurnToolCall, schedule: PipelineSchedule) => Promise<ContentBlock>, forceExclusive: () => boolean,
): Promise<TurnStrategyResult> {
  const prepare = mutex(); const ask = mutex();
  const active = new Map<symbol, Hazard | undefined>();
  let changed = Promise.resolve(); let notify = () => {};
  const reset = () => { changed = new Promise<void>(resolve => { notify = resolve; }); };
  reset();
  let next = 0; let failed = false; let failure: unknown;
  const results: ContentBlock[] = new Array(calls.length);
  const stopped = () => signal.aborted || failed;
  const workers = Array.from({ length: Math.min(limit, calls.length) }, async () => {
    while (!stopped() && next < calls.length) {
      const index = next++; const token = Symbol(); let release: (() => void) | undefined; let exclusive = false;
      const schedule: PipelineSchedule = {
        async prepare() {
          release = await prepare();
          if (stopped()) throw signal.reason ?? new Error("parallel batch stopped");
          exclusive = forceExclusive();
          while (exclusive && active.size > 0) await changed;
          if (stopped()) throw signal.reason ?? new Error("parallel batch stopped");
        },
        async admit(metadata) {
          // Reclassify after every earlier completion: an exclusive writer may have changed aliases.
          for (;;) {
            const hazard = await classify(metadata);
            if (stopped()) throw signal.reason ?? new Error("parallel batch stopped");
            if (![...active.values()].some(other => conflict(hazard, other))) {
              active.set(token, hazard); return;
            }
            await changed;
          }
        },
        authorized() { if (!exclusive) { release?.(); release = undefined; } },
        finish() { active.delete(token); release?.(); release = undefined; notify(); reset(); },
        async ask(work) {
          const done = await ask();
          try {
            if (stopped()) throw signal.reason ?? new Error("parallel batch stopped");
            return await work();
          } finally { done(); }
        },
      };
      try { results[index] = await runTool(calls[index]!, schedule); }
      catch (error) { if (!failed) { failed = true; failure = error; } }
      finally { schedule.finish(); }
    }
  });
  await Promise.all(workers);
  if (failed && !signal.aborted) throw failure;
  return signal.aborted ? { results: [], interrupted: true } : { results, interrupted: false };
}
