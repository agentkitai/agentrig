import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { z } from "zod";
import { type EventPayload, type HarnessEvent, Usage, parseEvent, serializeEvent } from "./events.js";
import { MessageSchema } from "./messages.js";

export interface SessionRef {
  id: string;
  path: string;
  updatedAt: number;
  bytes: number;
}

/**
 * Periodic snapshot of the message array for cheap resume. Unlike the JSONL event log
 * it is overwritten in place — the log stays the source of truth; the snapshot is a cache.
 */
export const SessionSnapshot = z.object({
  sessionId: z.string(),
  task: z.string(),
  cwd: z.string(),
  turns: z.number().int().nonnegative(),
  usage: Usage,
  usd: z.number().nonnegative().optional(),
  messages: z.array(MessageSchema),
  ts: z.number().int(),
});
export type SessionSnapshot = z.infer<typeof SessionSnapshot>;

export interface SessionStoreOptions {
  /** Directory that will contain `<id>.jsonl` files. Created on first write. */
  root: string;
  now?: () => number;
  newId?: () => string;
}

/**
 * Append-only JSONL, one file per session.
 *
 * Invariants:
 * - Events are written in `seq` order with no gaps.
 * - A file is never rewritten. Compaction, resume, and dreams all read; only `append` writes.
 * - `read` validates every line; a corrupt line throws rather than being skipped.
 */
/**
 * A session id becomes a filename, so it must not be able to leave the sessions directory.
 * `--resume <id>` puts a user-controlled string here, and unvalidated it read and WROTE arbitrary
 * paths: `--resume '../../../home/user/notes'` made the session-end ingest hook read a file
 * outside `.agentrig`, feed it to the model, and distil it into the agent's persistent memory —
 * exfiltration and memory poisoning in one. Validated at the source rather than at each caller,
 * because there is no safe way for a caller to know it needed to.
 */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidSessionId(id: string): boolean {
  return SESSION_ID.test(id);
}

export function assertSessionId(id: string): string {
  if (!isValidSessionId(id)) {
    throw new Error(
      `invalid session id ${JSON.stringify(id)}: expected 1-128 characters of [A-Za-z0-9_-]`,
    );
  }
  return id;
}

export class SessionStore {
  readonly root: string;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly seqs = new Map<string, number>();
  /** Sessions a live `run()` is appending to. See `claim`. */
  private readonly claimed = new Set<string>();

  constructor(opts: SessionStoreOptions) {
    this.root = opts.root;
    this.now = opts.now ?? (() => Date.now());
    this.newId = opts.newId ?? (() => randomUUID().slice(0, 8));
  }

  /**
   * Create a session id. Nothing is written until the first append.
   *
   * Retries on an id this store has already handed out or written: ids are short (8 hex chars by
   * default), and one collision means two sessions appending to one log — `seq` restarts, and the
   * log becomes unreadable rather than merely confusing.
   */
  create(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = assertSessionId(this.newId());
      if (this.seqs.has(id) || this.claimed.has(id)) continue;
      this.seqs.set(id, 0);
      return id;
    }
    throw new Error("could not allocate an unused session id in 100 attempts");
  }

  /**
   * Marks a session as being written by a live run, so a second run cannot interleave appends
   * into the same log. In-process only, and complementary to `acquireLock`: that guards two
   * processes resuming one session, this guards two `run()` calls in one process — which a
   * caller-supplied `run({ id })` makes possible for a fresh session too.
   */
  claim(sessionId: string): () => void {
    assertSessionId(sessionId);
    if (this.claimed.has(sessionId)) {
      throw new Error(`session ${sessionId} is already being written by this process`);
    }
    this.claimed.add(sessionId);
    return () => this.claimed.delete(sessionId);
  }

  pathFor(sessionId: string): string {
    assertSessionId(sessionId);
    return join(this.root, `${sessionId}.jsonl`);
  }

  snapshotPathFor(sessionId: string): string {
    assertSessionId(sessionId);
    return join(this.root, `${sessionId}.snapshot.json`);
  }

  /** Overwrite the resume snapshot atomically (write temp, rename). */
  async writeSnapshot(snapshot: SessionSnapshot): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const path = this.snapshotPathFor(snapshot.sessionId);
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(SessionSnapshot.parse(snapshot)), "utf8");
    await rename(tmp, path);
  }

  lockPathFor(sessionId: string): string {
    assertSessionId(sessionId);
    return join(this.root, `${sessionId}.lock`);
  }

  /**
   * Advisory per-session lock so two concurrent resumes can't interleave appends and corrupt
   * the log's seq order. Throws when the lock is already held; returns the release function.
   * A crashed holder leaves the file behind — the error names it so a human can remove it.
   */
  async acquireLock(sessionId: string): Promise<() => Promise<void>> {
    await mkdir(this.root, { recursive: true });
    const path = this.lockPathFor(sessionId);
    try {
      const handle = await open(path, "wx");
      await handle.writeFile(`pid ${process.pid} at ${new Date().toISOString()}\n`, "utf8");
      await handle.close();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(
          `session ${sessionId} is locked by another process; if that process is gone, delete ${path}`,
        );
      }
      throw err;
    }
    return async () => {
      await rm(path, { force: true });
    };
  }

  /** Null when no snapshot exists; a corrupt snapshot throws rather than resuming from garbage. */
  async readSnapshot(sessionId: string): Promise<SessionSnapshot | null> {
    let text: string;
    try {
      text = await readFile(this.snapshotPathFor(sessionId), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    return SessionSnapshot.parse(JSON.parse(text));
  }

  /** Stamp the envelope and append. Returns the stored event. */
  async append(sessionId: string, payload: EventPayload): Promise<HarnessEvent> {
    const seq = await this.nextSeq(sessionId);
    const event = { ...payload, seq, sessionId, ts: this.now() } as HarnessEvent;
    await mkdir(this.root, { recursive: true });
    await appendFile(this.pathFor(sessionId), serializeEvent(event) + "\n", "utf8");
    this.seqs.set(sessionId, seq + 1);
    return event;
  }

  /** Stream a session's events in order. */
  async *read(sessionId: string): AsyncGenerator<HarnessEvent> {
    const rl = createInterface({ input: createReadStream(this.pathFor(sessionId), "utf8"), crlfDelay: Infinity });
    let expected = 0;
    for await (const line of rl) {
      if (line.trim() === "") continue;
      const event = parseEvent(line);
      if (event.seq !== expected) {
        throw new Error(`session ${sessionId}: expected seq ${expected}, got ${event.seq}`);
      }
      expected += 1;
      yield event;
    }
  }

  async readAll(sessionId: string): Promise<HarnessEvent[]> {
    const out: HarnessEvent[] = [];
    for await (const e of this.read(sessionId)) out.push(e);
    return out;
  }

  async list(): Promise<SessionRef[]> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch {
      return [];
    }
    const refs: SessionRef[] = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(this.root, name);
      const s = await stat(path);
      refs.push({ id: name.slice(0, -".jsonl".length), path, updatedAt: s.mtimeMs, bytes: s.size });
    }
    return refs.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async nextSeq(sessionId: string): Promise<number> {
    const cached = this.seqs.get(sessionId);
    if (cached !== undefined) return cached;
    // Resuming a session this process didn't create: recover seq from disk.
    let n = 0;
    try {
      for await (const _ of this.read(sessionId)) n += 1;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    this.seqs.set(sessionId, n);
    return n;
  }
}

/** Stable content hash used for `tool.call.inputHash` and `file.changed.contentHash`. */
export function contentHash(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
