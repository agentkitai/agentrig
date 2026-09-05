import { mkdir, opendir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, join } from "node:path";
import { z } from "zod";
import { readBoundedFile } from "./bounded-file.js";
import { MaintenanceLimitError } from "./maintenance.js";
import { ScanBudget, type ScanOptions } from "./scan.js";
import { withMemoryLock } from "./lock.js";
import type { Attempt, DocRef, RawStore, SessionLogRef } from "./types.js";

/**
 * The immutable layer (PLAN §3.1). `raw/` is what actually happened: session logs written by
 * core, the attempts ledger, and docs a human dropped in. The agent reads it and never rewrites
 * it — every operation here either reads, or appends a new file.
 */

export const AttemptSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  ts: z.number().int(),
  hypothesis: z.string(),
  actions: z.string(),
  outcome: z.enum(["success", "failed", "abandoned", "reverted"]),
  evidence: z.array(z.string()).default([]),
  lesson: z.string().optional(),
});

export interface AttemptReadLimits {
  signal: AbortSignal;
  maxEntries: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

const INDEX_BYTES = 8 * 1024 * 1024;
const REBUILD_LIMITS = { maxEntries: 10_000, maxFileBytes: 64 * 1024, maxTotalBytes: 64 * 1024 * 1024 };
const AttemptIndexSchema = z.object({
  version: z.literal(1), token: z.string(),
  entries: z.array(z.object({ name: z.string().regex(/^[^/\\]+\.json$/), sessionId: z.string() })),
  corrupt: z.array(z.string().regex(/^[^/\\]+\.json$/)),
});
type AttemptIndex = z.infer<typeof AttemptIndexSchema>;

/**
 * Core writes `<id>.snapshot.json` and `<id>.lock` beside the session logs as its resume cache
 * and lock. They are mutable working state, not raw sources, so ingest must never treat them
 * as one (PLAN §3.1).
 */
export function isSessionLog(filename: string): boolean {
  return filename.endsWith(".jsonl") && !filename.includes(".snapshot.") && !filename.endsWith(".lock");
}

export interface FileRawStoreOptions {
  /** The `.agentrig` directory containing `raw/`. */
  root: string;
  now?: () => number;
}

export class FileRawStore implements RawStore {
  readonly root: string;
  private readonly now: () => number;

  constructor(opts: FileRawStoreOptions) {
    this.root = opts.root;
    this.now = opts.now ?? (() => Date.now());
  }

  private dir(name: "sessions" | "attempts" | "docs"): string {
    return join(this.root, "raw", name);
  }

  /** Session logs, newest first; `since` filters on mtime so a dream can scan only new work. */
  async sessions(since?: number, opts: ScanOptions = {}): Promise<SessionLogRef[]> {
    const budget = new ScanBudget(opts);
    let names: string[];
    try {
      names = await budget.names(this.dir("sessions"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return [];
    }
    const out: SessionLogRef[] = [];
    for (const name of names) {
      budget.check();
      if (!isSessionLog(name)) continue;
      const path = join(this.dir("sessions"), name);
      const s = await stat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (s === null || !s.isFile()) continue;
      if (since !== undefined && s.mtimeMs <= since) continue;
      out.push({ id: name.slice(0, -".jsonl".length), path, updatedAt: s.mtimeMs });
    }
    budget.check(); return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async docs(opts: ScanOptions = {}): Promise<DocRef[]> {
    const budget = new ScanBudget(opts);
    let names: string[];
    try {
      names = await budget.names(this.dir("docs"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return [];
    }
    const out: DocRef[] = [];
    for (const name of names) {
      budget.check();
      const path = join(this.dir("docs"), name);
      const s = await stat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (s === null || !s.isFile()) continue;
      out.push({ id: name.replace(/\.[^.]+$/, ""), path, addedAt: s.mtimeMs });
    }
    budget.check(); return out.sort((a, b) => b.addedAt - a.addedAt);
  }

  /**
   * Copy a doc into `raw/docs/`. Never overwrites: a name collision gets a numeric suffix, so an
   * existing raw source can't be silently replaced by a different file with the same name.
   */
  async addDoc(path: string): Promise<DocRef> {
    const contents = await readFile(path);
    await mkdir(this.dir("docs"), { recursive: true });
    const original = basename(path);
    const ext = /\.[^.]+$/.exec(original)?.[0] ?? "";
    const stem = ext === "" ? original : original.slice(0, -ext.length);
    let name = original;
    // exclusive create inside the loop: a stat/write gap let two concurrent addDoc calls pick
    // the same name and one silently overwrote a raw source
    for (let n = 2; ; n++) {
      try {
        const dest = join(this.dir("docs"), name);
        await writeFile(dest, contents, { flag: "wx" });
        return { id: name.replace(/\.[^.]+$/, ""), path: dest, addedAt: this.now() };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        name = `${stem}-${n}${ext}`;
      }
    }
  }

  /**
   * Append one attempt to the ledger (PLAN §3.5). Immutable: one file per attempt, and a
   * duplicate id is refused. Written temp+rename so a crash mid-write cannot leave a torn file
   * in a directory the rest of the system treats as trustworthy.
   */
  async addAttempt(attempt: Attempt): Promise<void> {
    AttemptSchema.parse(attempt);
    z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/).parse(attempt.id);
    return withMemoryLock(join(this.root, "attempt-index"), () => this.addAttemptUnlocked(attempt));
  }

  private async addAttemptUnlocked(attempt: Attempt): Promise<void> {
    await rm(join(this.root, "attempt-index.json"), { force: true });
    await mkdir(this.dir("attempts"), { recursive: true });
    const parsed = AttemptSchema.parse(attempt);
    const dest = join(this.dir("attempts"), `${parsed.id}.json`);
    // claim the id exclusively first, so the rename below can't clobber another attempt
    const claim = await writeFile(dest, "", { flag: "wx" }).then(
      () => true,
      (err: NodeJS.ErrnoException) => {
        if (err.code === "EEXIST") throw new Error(`attempt ${parsed.id} already exists; the ledger is immutable`);
        throw err;
      },
    );
    if (!claim) return;
    const tmp = `${dest}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(parsed, null, 2), "utf8");
      await rename(tmp, dest);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  /**
   * Attempts, oldest first; optionally only those for one session. A corrupt entry in an
   * immutable ledger is reported, never swallowed and never fatal — one torn file used to throw
   * a raw SyntaxError and take down every ingest for the project.
   */
  async attempts(sessionId?: string): Promise<Attempt[]> {
    const { attempts } = await this.readAttempts(sessionId);
    return attempts;
  }

  /** Explicit bounded rebuild for legacy flat ledgers. Cache is disposable; raw is never rewritten.
   * Cooperating writers serialize with this operation. External edits require an explicit rebuild. */
  async rebuildAttemptIndex(opts: AttemptReadLimits = { signal: new AbortController().signal, ...REBUILD_LIMITS }): Promise<void> {
    await withMemoryLock(join(this.root, "attempt-index"), async () => { await this.buildAttemptIndex(opts); }, { signal: opts.signal });
  }

  private async attemptToken(): Promise<string> {
    try {
      const s = await stat(this.dir("attempts"), { bigint: true });
      return `${s.dev}:${s.ino}:${s.birthtimeNs}:${s.mtimeNs}:${s.ctimeNs}`;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent"; throw error; }
  }

  private async buildAttemptIndex(opts: AttemptReadLimits): Promise<AttemptIndex> {
    const token = await this.attemptToken();
    const result = await this.scanAttempts(undefined, opts);
    const index: AttemptIndex = { version: 1, token,
      entries: result.records, corrupt: result.corrupt.map(path => basename(path)) };
    opts.signal.throwIfAborted();
    if (token !== await this.attemptToken()) throw new Error("attempt ledger changed during index rebuild; retry with writers stopped");
    const text = JSON.stringify(index);
    if (Buffer.byteLength(text) > INDEX_BYTES) throw new MaintenanceLimitError("attempt index byte limit exceeded");
    const dest = join(this.root, "attempt-index.json");
    const tmp = `${dest}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, text, { flag: "wx" });
      opts.signal.throwIfAborted();
      await rename(tmp, dest);
    } finally { await rm(tmp, { force: true }); }
    return index;
  }

  async readAttempts(sessionId?: string, opts?: AttemptReadLimits): Promise<{ attempts: Attempt[]; corrupt: string[] }> {
    if (sessionId === undefined) {
      const { attempts, corrupt } = await this.scanAttempts(undefined, opts);
      return { attempts, corrupt };
    }
    const limits = opts ?? { signal: new AbortController().signal, ...REBUILD_LIMITS };
    return withMemoryLock(join(this.root, "attempt-index"), async () => {
      let index: AttemptIndex | undefined;
      try {
        index = AttemptIndexSchema.parse(JSON.parse((await readBoundedFile(join(this.root, "attempt-index.json"), INDEX_BYTES, limits.signal)).toString("utf8")));
      } catch (error) {
        limits.signal.throwIfAborted();
        if (error instanceof MaintenanceLimitError) throw error;
        // Missing/corrupt cache is rebuilt, never interpreted as empty history.
      }
      if (index === undefined || index.token !== await this.attemptToken()) {
        index = await this.buildAttemptIndex({ signal: limits.signal, ...REBUILD_LIMITS });
      }
      const names = index.entries.filter(entry => entry.sessionId === sessionId).map(entry => entry.name);
      const result = await this.scanAttempts(sessionId, limits, names);
      return { attempts: result.attempts, corrupt: [...new Set([...result.corrupt, ...index.corrupt.map(name => join(this.dir("attempts"), name))])] };
    }, { signal: limits.signal });
  }

  private async scanAttempts(sessionId?: string, opts?: AttemptReadLimits, selectedNames?: string[]): Promise<{ attempts: Attempt[]; corrupt: string[]; records: AttemptIndex["entries"] }> {
    if (opts !== undefined) new ScanBudget({ signal: opts.signal, scanLimits: {
      maxEntries: opts.maxEntries, maxFileBytes: opts.maxFileBytes, maxTotalBytes: opts.maxTotalBytes,
    } });
    let names: string[];
    try {
      if (selectedNames !== undefined) {
        names = selectedNames;
        if (opts !== undefined && names.length > opts.maxEntries) throw new MaintenanceLimitError("attempt ledger entry limit exceeded");
      } else if (opts === undefined) names = await readdir(this.dir("attempts"));
      else {
        opts.signal.throwIfAborted();
        names = [];
        const directory = await opendir(this.dir("attempts"));
        for await (const entry of directory) {
          opts.signal.throwIfAborted();
          if (names.length >= opts.maxEntries) throw new MaintenanceLimitError("attempt ledger entry limit exceeded");
          names.push(entry.name);
        }
      }
    } catch (error) {
      if (opts !== undefined && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { attempts: [], corrupt: [], records: [] };
    }
    const out: Attempt[] = [];
    const corrupt: string[] = [];
    const records: AttemptIndex["entries"] = [];
    let bytes = 0;
    for (const name of names) {
      opts?.signal.throwIfAborted();
      if (!name.endsWith(".json")) continue;
      const path = join(this.dir("attempts"), name);
      const text = await (opts === undefined ? readFile(path, "utf8") : readBoundedFile(path, Math.min(opts.maxFileBytes, Math.max(1, opts.maxTotalBytes - bytes)), opts.signal)
        .then(buffer => {
          bytes += buffer.length;
          if (bytes > opts.maxTotalBytes) throw new MaintenanceLimitError("attempt ledger total byte limit exceeded");
          return buffer.toString("utf8");
        })).catch(error => {
          if (opts?.signal.aborted || error instanceof MaintenanceLimitError) throw error;
          return null;
        });
      if (text === null) {
        corrupt.push(path);
        continue;
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        corrupt.push(path);
        continue;
      }
      const parsed = AttemptSchema.safeParse(json);
      if (!parsed.success) {
        corrupt.push(path);
        continue;
      }
      if (sessionId !== undefined && parsed.data.sessionId !== sessionId) {
        corrupt.push(path); // A cached entry changed scope: never silently omit it.
        continue;
      }
      records.push({ name, sessionId: parsed.data.sessionId });
      const { lesson, ...rest } = parsed.data;
      out.push(lesson === undefined ? rest : { ...rest, lesson });
    }
    opts?.signal.throwIfAborted();
    return { attempts: out.sort((a, b) => a.ts - b.ts), corrupt, records };
  }
}
