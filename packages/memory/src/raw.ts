import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
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
  async sessions(since?: number): Promise<SessionLogRef[]> {
    let names: string[];
    try {
      names = await readdir(this.dir("sessions"));
    } catch {
      return [];
    }
    const out: SessionLogRef[] = [];
    for (const name of names) {
      if (!isSessionLog(name)) continue;
      const path = join(this.dir("sessions"), name);
      const s = await stat(path).catch(() => null);
      if (s === null) continue;
      if (since !== undefined && s.mtimeMs <= since) continue;
      out.push({ id: name.slice(0, -".jsonl".length), path, updatedAt: s.mtimeMs });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async docs(): Promise<DocRef[]> {
    let names: string[];
    try {
      names = await readdir(this.dir("docs"));
    } catch {
      return [];
    }
    const out: DocRef[] = [];
    for (const name of names) {
      const path = join(this.dir("docs"), name);
      const s = await stat(path).catch(() => null);
      if (s === null || !s.isFile()) continue;
      out.push({ id: name.replace(/\.[^.]+$/, ""), path, addedAt: s.mtimeMs });
    }
    return out.sort((a, b) => b.addedAt - a.addedAt);
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
    for (let n = 2; ; n++) {
      const candidate = join(this.dir("docs"), name);
      const exists = await stat(candidate).then(() => true, () => false);
      if (!exists) break;
      name = `${stem}-${n}${ext}`;
    }
    const dest = join(this.dir("docs"), name);
    await writeFile(dest, contents);
    return { id: name.replace(/\.[^.]+$/, ""), path: dest, addedAt: this.now() };
  }

  /** Append one attempt to the ledger (PLAN §3.5). Immutable: one file per attempt. */
  async addAttempt(attempt: Attempt): Promise<void> {
    await mkdir(this.dir("attempts"), { recursive: true });
    const parsed = AttemptSchema.parse(attempt);
    await writeFile(join(this.dir("attempts"), `${parsed.id}.json`), JSON.stringify(parsed, null, 2), {
      encoding: "utf8",
      flag: "wx",
    });
  }

  /** Attempts, oldest first; optionally only those for one session. */
  async attempts(sessionId?: string): Promise<Attempt[]> {
    let names: string[];
    try {
      names = await readdir(this.dir("attempts"));
    } catch {
      return [];
    }
    const out: Attempt[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const text = await readFile(join(this.dir("attempts"), name), "utf8").catch(() => null);
      if (text === null) continue;
      const parsed = AttemptSchema.safeParse(JSON.parse(text));
      if (!parsed.success) continue;
      if (sessionId !== undefined && parsed.data.sessionId !== sessionId) continue;
      const { lesson, ...rest } = parsed.data;
      out.push(lesson === undefined ? rest : { ...rest, lesson });
    }
    return out.sort((a, b) => a.ts - b.ts);
  }
}
