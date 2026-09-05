import { lstat, opendir, readlink, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readBoundedFile } from "./bounded-file.js";
import { MaintenanceLimitError } from "./maintenance.js";

const positive = z.number().int().positive().max(2_147_483_647);
export const ScanLimitsSchema = z.object({
  maxEntries: positive, maxDepth: positive, maxFileBytes: positive, maxTotalBytes: positive,
}).strict();
export type ScanLimits = z.infer<typeof ScanLimitsSchema>;
export const DEFAULT_SCAN_LIMITS: Readonly<ScanLimits> = Object.freeze({
  maxEntries: 10_000, maxDepth: 32, maxFileBytes: 8 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024,
});
export interface ScanOptions { signal?: AbortSignal; scanLimits?: Partial<ScanLimits> }

/** One traversal's budget, counting every directory entry (even ignored names) and every byte
 * actually read. Caps fail visibly; no traversal returns a silently partial result. */
export class ScanBudget {
  readonly limits: ScanLimits;
  readonly signal: AbortSignal | undefined;
  private entries = 0;
  private bytes = 0;
  constructor(opts: ScanOptions = {}) {
    this.limits = ScanLimitsSchema.parse({ ...DEFAULT_SCAN_LIMITS, ...opts.scanLimits });
    this.signal = opts.signal;
    this.check();
  }
  check(): void { this.signal?.throwIfAborted(); }
  depth(value: number): void {
    this.check();
    if (value > this.limits.maxDepth) throw new MaintenanceLimitError("wiki scan depth limit exceeded");
  }
  async names(path: string): Promise<string[]> {
    this.check();
    const names: string[] = [];
    const directory = await opendir(path);
    for await (const entry of directory) {
      this.check();
      if (++this.entries > this.limits.maxEntries) throw new MaintenanceLimitError("scan entry limit exceeded: " + path);
      names.push(entry.name);
    }
    this.check(); return names.sort();
  }
  async read(path: string): Promise<Buffer> {
    this.check();
    const remaining = this.limits.maxTotalBytes - this.bytes;
    const bytes = await readBoundedFile(path, Math.min(this.limits.maxFileBytes, Math.max(1, remaining)), this.signal);
    this.bytes += bytes.length;
    if (this.bytes > this.limits.maxTotalBytes) throw new MaintenanceLimitError("scan total byte limit exceeded: " + path);
    this.check(); return bytes;
  }
}

export interface TreeEntry {
  path: string;
  relative: string;
  /** Mode of the directory entry itself; differs from targetMode for symlinks. */
  mode: number;
  targetMode: number;
  linkTarget?: string;
  kind: "file" | "directory";
  bytes?: Buffer;
}

/** Walks linked directories by physical ancestry, materializing linked files without reading
 * pipes/devices. Callbacks are awaited; callers can write only into an owned destination. */
export async function walkTree(root: string, budget: ScanBudget, visitor: {
  entry(entry: TreeEntry): Promise<void>;
  leaveDirectory?(entry: TreeEntry): Promise<void>;
}, excludeRootStamp = false): Promise<void> {
  const active = new Set<string>();
  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    budget.depth(depth);
    const canonical = await realpath(dir);
    if (active.has(canonical)) throw new Error("cyclic directory symlink in dream snapshot: " + dir);
    active.add(canonical);
    try {
      for (const name of await budget.names(dir)) {
        budget.check();
        if (excludeRootStamp && prefix === "" && name === ".last-dream") continue;
        const path = join(dir, name); const relative = prefix === "" ? name : prefix + "/" + name;
        const link = await lstat(path);
        const linkTarget = link.isSymbolicLink() ? await readlink(path) : undefined;
        const info = linkTarget === undefined ? link : await stat(path);
        const common = { path, relative, mode: link.mode & 0o777, targetMode: info.mode & 0o777,
          ...(linkTarget === undefined ? {} : { linkTarget }) };
        if (info.isDirectory()) {
          budget.depth(depth + 1);
          const entry: TreeEntry = { ...common, kind: "directory" };
          await visitor.entry(entry); await walk(path, relative, depth + 1);
          budget.check(); await visitor.leaveDirectory?.(entry);
        } else if (info.isFile()) {
          const bytes = await budget.read(path);
          await visitor.entry({ ...common, kind: "file", bytes });
        } else throw new Error("unsupported file in dream snapshot: " + path);
      }
    } finally { active.delete(canonical); }
  };
  await walk(root, "", 0); budget.check();
}
