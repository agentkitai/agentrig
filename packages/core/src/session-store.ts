import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { z } from "zod";
import { type EventPayload, type HarnessEvent, Usage, parseEvent, serializeEvent } from "./events.js";
import { MessageSchema, type ContentBlock, type Message } from "./messages.js";

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
  /** Ids observed on disk or allocated here, including logs whose next sequence is not cached. */
  private readonly knownIds = new Set<string>();
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
      if (this.knownIds.has(id) || this.seqs.has(id) || this.claimed.has(id)) continue;
      this.knownIds.add(id);
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
    this.knownIds.add(assertSessionId(sessionId));
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

  /**
   * Create an append-only child whose sole initial event points at an event in the parent's own
   * log. No parent bytes or snapshots are copied: ancestry is resolved only when materialized.
   */
  async fork(parent: string, atSeq: number): Promise<string> {
    assertSessionId(parent);
    if (!Number.isInteger(atSeq) || atSeq < 0) {
      throw new Error(`invalid fork atSeq ${atSeq}: expected a non-negative integer`);
    }
    const parentEvents = await this.readAll(parent);
    if (parentEvents[atSeq]?.seq !== atSeq) {
      throw new Error(`cannot fork session ${parent} atSeq ${atSeq}: parent log ends at seq ${parentEvents.length - 1}`);
    }

    const child = await this.reserveSessionLog();
    try {
      await this.append(child, { type: "session.fork", parent, atSeq });
      return child;
    } catch (err) {
      this.knownIds.delete(child);
      this.seqs.delete(child);
      await rm(this.pathFor(child), { force: true });
      throw err;
    }
  }

  /** Atomically reserve a fresh on-disk log name so reopened stores cannot reuse an existing id. */
  private async reserveSessionLog(): Promise<string> {
    await mkdir(this.root, { recursive: true });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = assertSessionId(this.newId());
      if (this.knownIds.has(id) || this.seqs.has(id) || this.claimed.has(id)) continue;
      try {
        const handle = await open(this.pathFor(id), "wx");
        await handle.close();
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          this.knownIds.add(id);
          continue;
        }
        throw err;
      }
      this.knownIds.add(id);
      this.seqs.set(id, 0);
      return id;
    }
    throw new Error("could not allocate an unused session id in 100 attempts");
  }

  /**
   * Resolve a session tree into recorded events. `atSeq` always addresses the named session's own
   * physical log; a fork marker recursively supplies the inherited prefix. Events retain their
   * original envelopes, so callers can distinguish inherited records from child records.
   */
  async materialize(sessionId: string, atSeq?: number): Promise<HarnessEvent[]> {
    assertSessionId(sessionId);
    return this.materializeFrom(sessionId, atSeq, new Set());
  }

  /**
   * Fold a materialized event stream into the provider-neutral conversation it records. This is a
   * pure replay: in particular, `tool.result` records become tool_result blocks and no tool is
   * looked up or executed.
   */
  async materializeMessages(sessionId: string, atSeq?: number): Promise<Message[]> {
    return messagesFromEvents(await this.materialize(sessionId, atSeq));
  }

  /**
   * A resume snapshot derived from the log, for a fork child that has not completed a turn of its
   * own (R3c). A fork writes only its `session.fork` marker, so it has no snapshot to resume from
   * until its first turn ends; without this, a forked conversation could be replayed but never
   * continued. Null for anything that is not a fork: a plain session with no snapshot stays an
   * error, because "died before its first turn.end" must not silently become "resumable from an
   * empty conversation". Pure replay — recorded tool results are folded in, nothing executes.
   */
  async materializeSnapshot(sessionId: string): Promise<SessionSnapshot | null> {
    assertSessionId(sessionId);
    let first: HarnessEvent | undefined;
    try {
      for await (const event of this.read(sessionId)) {
        first = event;
        break;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    if (first?.type !== "session.fork") return null;

    const events = await this.materialize(sessionId);
    let task = "";
    let cwd = "";
    let turns = 0;
    const usage: Usage = { input: 0, output: 0 };
    for (const event of events) {
      if (event.type === "session.start") {
        if (task === "") task = event.task;
        cwd = event.cwd;
      } else if (event.type === "session.resume") {
        cwd = event.cwd;
      } else if (event.type === "turn.end") {
        turns = Math.max(turns, event.n);
      } else if (event.type === "model.response") {
        usage.input += event.usage.input;
        usage.output += event.usage.output;
        if (event.usage.cacheRead !== undefined) usage.cacheRead = (usage.cacheRead ?? 0) + event.usage.cacheRead;
        if (event.usage.cacheWrite !== undefined) usage.cacheWrite = (usage.cacheWrite ?? 0) + event.usage.cacheWrite;
      }
    }
    return {
      sessionId,
      task,
      cwd,
      turns,
      usage,
      messages: messagesFromEvents(events),
      ts: this.now(),
    };
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

  private async materializeFrom(
    sessionId: string,
    atSeq: number | undefined,
    ancestors: Set<string>,
  ): Promise<HarnessEvent[]> {
    if (ancestors.has(sessionId)) {
      throw new Error(`session fork cycle detected at ${sessionId}`);
    }
    if (atSeq !== undefined && (!Number.isInteger(atSeq) || atSeq < 0)) {
      throw new Error(`invalid materialization atSeq ${atSeq}: expected a non-negative integer`);
    }

    const own = await this.readAll(sessionId);
    if (atSeq !== undefined && own[atSeq]?.seq !== atSeq) {
      throw new Error(`cannot materialize session ${sessionId} atSeq ${atSeq}: log ends at seq ${own.length - 1}`);
    }
    const prefix = atSeq === undefined ? own : own.slice(0, atSeq + 1);
    const misplacedFork = own.slice(1).findIndex((event) => event.type === "session.fork");
    if (misplacedFork >= 0) {
      throw new Error(`session ${sessionId}: session.fork must be the first event`);
    }
    const first = prefix[0];
    if (first?.type !== "session.fork") return prefix;

    const nextAncestors = new Set(ancestors);
    nextAncestors.add(sessionId);
    const inherited = await this.materializeFrom(first.parent, first.atSeq, nextAncestors);
    return [...inherited, ...prefix];
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

function messagesFromEvents(events: readonly HarnessEvent[]): Message[] {
  const messages: Message[] = [];
  let streamedText = "";
  let activeAssistant: Message | undefined;

  const pushUserText = (text: string): void => {
    messages.push({ role: "user", content: [{ type: "text", text }] });
    activeAssistant = undefined;
  };
  const latestToolResult = (id: string): Extract<ContentBlock, { type: "tool_result" }> | undefined => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      for (const block of messages[i]!.content) {
        if (block.type === "tool_result" && block.toolUseId === id) return block;
      }
    }
    return undefined;
  };

  let authoritativeMessages = false;
  for (const event of events) {
    if (event.type === "message.append") {
      if (!authoritativeMessages && event.message.role === "assistant" && messages.at(-1)?.role === "assistant") {
        messages.pop();
      }
      messages.push(structuredClone(event.message));
      streamedText = "";
      activeAssistant = undefined;
      authoritativeMessages = true;
      continue;
    }
    if (event.type === "context.compact" && event.messages !== undefined) {
      messages.splice(0, messages.length, ...structuredClone(event.messages));
      streamedText = "";
      activeAssistant = undefined;
      authoritativeMessages = true;
      continue;
    }
    if (
      authoritativeMessages &&
      (event.type === "model.request" || event.type === "model.delta" || event.type === "model.response" ||
        event.type === "tool.call" || event.type === "tool.result" || event.type === "tool.result.patched")
    ) continue;

    switch (event.type) {
      case "session.start":
        pushUserText(event.task);
        break;
      case "session.resume":
        if (event.task !== "") pushUserText(event.task);
        break;
      case "steer":
        pushUserText(event.message);
        break;
      case "model.request":
        activeAssistant = undefined;
        break;
      case "model.delta":
        streamedText += event.text;
        break;
      case "model.response": {
        if (streamedText !== "") {
          activeAssistant = { role: "assistant", content: [{ type: "text", text: streamedText }] };
          messages.push(activeAssistant);
        } else {
          activeAssistant = undefined;
        }
        streamedText = "";
        break;
      }
      case "tool.call": {
        if (activeAssistant === undefined) {
          activeAssistant = { role: "assistant", content: [] };
          messages.push(activeAssistant);
        }
        activeAssistant.content.push({ type: "tool_use", id: event.id, name: event.name, input: event.input });
        break;
      }
      case "tool.result": {
        const block: Extract<ContentBlock, { type: "tool_result" }> = {
          type: "tool_result",
          toolUseId: event.id,
          content: event.display,
          ...(!event.ok ? { isError: true } : {}),
        };
        const last = messages.at(-1);
        if (last?.role === "user" && last.content.every((item) => item.type === "tool_result")) {
          last.content.push(block);
        } else {
          messages.push({ role: "user", content: [block] });
        }
        activeAssistant = undefined;
        break;
      }
      case "tool.result.patched": {
        const block = latestToolResult(event.id);
        if (block === undefined) break;
        if (event.mode === "inject") {
          const prior = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
          block.content = `${prior}\n\n${event.display}`;
        } else {
          block.content = event.display;
        }
        break;
      }
      default:
        break;
    }
  }
  return messages;
}

/** Stable content hash used for `tool.call.inputHash` and `file.changed.contentHash`. */
export function contentHash(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
