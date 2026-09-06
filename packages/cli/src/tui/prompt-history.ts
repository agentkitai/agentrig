import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withMemoryLock } from "@agentkitai/agentrig-memory";

export const HISTORY_LIMITS = { entries: 200, entryBytes: 16 * 1024, fileBytes: 256 * 1024 } as const;
const schema = z.object({ version: z.literal(1), entries: z.array(z.string().refine(text => Buffer.byteLength(text) <= HISTORY_LIMITS.entryBytes)).max(HISTORY_LIMITS.entries) }).strict();
const serialize = (entries: readonly string[]) => JSON.stringify({ version: 1, entries });
function bounded(entries: readonly string[]): string[] {
  const result: string[] = [];
  for (const text of entries) if (text.trim() && result.at(-1) !== text) result.push(text);
  while (result.length > HISTORY_LIMITS.entries || Buffer.byteLength(serialize(result)) > HISTORY_LIMITS.fileBytes) result.shift();
  return result;
}

/** Interactive-only local convenience state, never model context or authority. */
export class PromptHistory {
  private entries: string[] = [];
  private pending: string[] = [];
  private writing: Promise<void> | undefined;
  private path: string | undefined;
  private closed = false;
  constructor(private readonly notice: (text: string) => void = () => {}) {}
  values(): readonly string[] { return this.entries.slice(); }
  static async load(trustedProjectRoot?: string, notice?: (text: string) => void): Promise<PromptHistory> {
    const history = new PromptHistory(notice);
    if (trustedProjectRoot === undefined) return history;
    try {
      const root = await realpath(trustedProjectRoot);
      const dir = join(root, ".agentrig");
      await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
      if (!(await lstat(dir)).isDirectory() || await realpath(dir) !== dir) throw new Error("unsupported history directory");
      history.path = join(dir, "history");
      history.entries = await history.read();
    } catch { history.disable(); }
    return history;
  }
  private disable(): void {
    this.path = undefined; this.pending = [];
    this.notice("Prompt history persistence unavailable; using memory only.");
  }
  private async read(): Promise<string[]> {
    const path = this.path!;
    try {
      const dir = dirname(path);
      if (!(await lstat(dir)).isDirectory() || await realpath(dir) !== dir) throw new Error("history directory changed");
      const info = await lstat(path);
      if (!info.isFile() || info.nlink !== 1 || info.size > HISTORY_LIMITS.fileBytes) throw new Error("unsupported history file");
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const current = await file.stat();
        if (!current.isFile() || current.ino !== info.ino || current.dev !== info.dev) throw new Error("history changed");
        const data = Buffer.alloc(HISTORY_LIMITS.fileBytes + 1); let size = 0;
        while (size < data.length) { const result = await file.read(data, size, data.length - size, size); if (result.bytesRead === 0) break; size += result.bytesRead; }
        if (size > HISTORY_LIMITS.fileBytes) throw new Error("history too large");
        return schema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, size)))).entries;
      } finally { await file.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  remember(text: string): void {
    if (this.closed || !text.trim()) return;
    if (Buffer.byteLength(text) > HISTORY_LIMITS.entryBytes) { this.notice("Prompt too large for history; submitted text is unchanged."); return; }
    this.entries = bounded([...this.entries, text]);
    if (this.path === undefined) return;
    this.pending = bounded([...this.pending, text]);
    this.writing ??= this.flush().finally(() => { this.writing = undefined; });
  }
  private async flush(): Promise<void> {
    try {
      while (this.pending.length && this.path !== undefined) {
        const batch = this.pending; this.pending = [];
        const path = this.path;
        await withMemoryLock(path, async () => {
          const contents = serialize(bounded([...await this.read(), ...batch]));
          const temp = `${path}.${randomUUID()}.tmp`;
          try {
            const file = await open(temp, "wx", 0o600);
            try { await file.writeFile(contents); } finally { await file.close(); }
            await rename(temp, path);
          } finally { await rm(temp, { force: true }); }
        }, { timeoutMs: 500, onReleaseError: () => this.disable() });
      }
    } catch { this.disable(); }
  }
  async close(): Promise<void> { this.closed = true; await this.writing; }
}

/** Navigation state is separate from persisted records and from permission input. */
export class PromptRecall {
  private index: number | undefined;
  private draft = "";
  reset(): void { this.index = undefined; }
  move(direction: -1 | 1, current: string, entries: readonly string[]): string {
    if (!entries.length) return current;
    if (this.index === undefined) { if (direction === 1) return current; this.draft = current; this.index = entries.length; }
    this.index = Math.max(0, Math.min(entries.length, this.index + direction));
    return this.index === entries.length ? this.draft : entries[this.index]!;
  }
}

export function completePrompt(text: string, names: readonly string[]): { text: string; hint: string } {
  if (!/^\/[^\s/]*$/.test(text)) return { text, hint: "" };
  const prefix = text.slice(1).toLowerCase();
  const matches = names.filter(name => name.toLowerCase().startsWith(prefix)).slice(0, 256);
  if (!matches.length) return { text, hint: "No matching command or skill" };
  let common = matches[0]!;
  for (const name of matches.slice(1)) { let i = 0; while (i < common.length && common[i]!.toLowerCase() === name[i]?.toLowerCase()) i++; common = common.slice(0, i); }
  return { text: `/${common.length > prefix.length ? common : text.slice(1)}${matches.length === 1 ? " " : ""}`,
    hint: matches.length === 1 ? "" : matches.slice(0, 8).map(name => `/${name}`).join("  ") + (matches.length > 8 ? " …" : "") };
}
