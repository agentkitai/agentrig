import { lstat, open, type FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { parseEvent, type HarnessEvent } from "./events.js";
import { MessageSchema, type Message } from "./messages.js";
import { messagesFromEvents, SessionStore } from "./session-store.js";

export const EXPORT_READ_LIMITS = Object.freeze({ bytes: 32 * 1024 * 1024, events: 50_000, ancestors: 32, lineBytes: 4 * 1024 * 1024 });
export class SessionExportError extends Error {}
function fail(message: string): never { throw new SessionExportError(message); }

/** Reject deep JSON before recursive schema validation; strings are not structure. */
export function checkExportJsonDepth(text: string): void {
  let depth = 0, quoted = false, escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") { if (++depth > 64) fail("export JSON exceeds the nesting bound"); }
    else if (char === "}" || char === "]") depth--;
  }
}

/** Export cannot silently drop unknown content fields (including future opaque signatures). */
export function validateExportMessage(value: unknown): Message {
  const parsed = MessageSchema.safeParse(value);
  if (!parsed.success || !isDeepStrictEqual(parsed.data, value)) fail("export contains unsupported message content");
  return parsed.data;
}

/**
 * Read the actual fork/compaction transcript, never snapshots. Every physical log must be
 * finished and stable, including ancestors. Bounds apply before parsing/allocation growth.
 * Stat checks detect observed edits, not a transaction against arbitrary external writers.
 */
export async function materializeExportMessages(
  store: SessionStore, id: string,
  options: { signal?: AbortSignal; limits?: Partial<typeof EXPORT_READ_LIMITS> } = {},
): Promise<Message[]> {
  try {
    const limits = { ...EXPORT_READ_LIMITS, ...options.limits };
    for (const key of Object.keys(EXPORT_READ_LIMITS) as (keyof typeof EXPORT_READ_LIMITS)[]) {
      if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > EXPORT_READ_LIMITS[key]) fail("invalid export read bounds");
    }
    const check = (): void => { if (options.signal?.aborted) fail("session export cancelled"); };
    const seen = new Set<string>();
    const files: { path: string; stamp: string }[] = [];
    const stamp = (s: Awaited<ReturnType<FileHandle["stat"]>>): string => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
    let bytes = 0, count = 0;
    const load = async (session: string, atSeq?: number): Promise<HarnessEvent[]> => {
      check();
      if (seen.has(session) || seen.size >= limits.ancestors) fail("session export fork cycle or ancestry bound exceeded");
      seen.add(session);
      const path = store.pathFor(session);
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink()) fail("session export requires regular log files");
      if (before.size > limits.bytes - bytes) fail("session export exceeds the cumulative byte bound");
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const events: HarnessEvent[] = [];
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || stamp(opened) !== stamp(before)) fail("session log changed while exporting");
        const chunks: Buffer[] = [];
        while (true) {
          check();
          const buffer = Buffer.alloc(64 * 1024);
          const read = await handle.read(buffer, 0, buffer.length, null);
          if (read.bytesRead === 0) break;
          bytes += read.bytesRead;
          if (bytes > limits.bytes) fail("session export exceeds the cumulative byte bound");
          chunks.push(buffer.subarray(0, read.bytesRead));
        }
        const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
        for (const line of text.split("\n")) {
          check();
          if (line.trim() === "") continue;
          if (++count > limits.events || Buffer.byteLength(line) > limits.lineBytes) fail("session export exceeds the event or line bound");
          checkExportJsonDepth(line);
          const raw = JSON.parse(line) as Record<string, unknown>;
          if (raw.type === "message.append") validateExportMessage(raw.message);
          if (raw.type === "context.compact" && raw.messages !== undefined) {
            if (!Array.isArray(raw.messages)) fail("export contains unsupported message content");
            raw.messages.forEach(validateExportMessage);
          }
          const event = parseEvent(line);
          if (event.sessionId !== session || event.seq !== events.length) fail("session export requires ordered matching log identities");
          if ("context" in raw && !isDeepStrictEqual(raw.context, (event as unknown as Record<string, unknown>).context)) fail("export contains unsupported context");
          events.push(event);
        }
        if (stamp(await handle.stat()) !== stamp(before) || stamp(await lstat(path)) !== stamp(before)) fail("session log changed while exporting");
      } finally { await handle.close(); }
      files.push({ path, stamp: stamp(before) });
      if (events.at(-1)?.type !== "session.end") fail("session export requires finished logs ending with session.end");
      if (events.slice(1).some(e => e.type === "session.fork")) fail("session export contains a misplaced fork marker");
      if (atSeq !== undefined && (!Number.isSafeInteger(atSeq) || atSeq < 0 || events[atSeq]?.seq !== atSeq)) fail("session export fork sequence is unavailable");
      const prefix = atSeq === undefined ? events : events.slice(0, atSeq + 1);
      const first = prefix[0];
      return first?.type === "session.fork" ? [...await load(first.parent, first.atSeq), ...prefix] : prefix;
    };
    const events = await load(id);
    for (const file of files) {
      check();
      if (stamp(await lstat(file.path)) !== file.stamp) fail("session log changed while exporting");
    }
    return messagesFromEvents(events).map(validateExportMessage);
  } catch (error) {
    if (error instanceof SessionExportError) throw error;
    // JSON, schema, filesystem and ID errors can contain transcript secrets or secret paths.
    throw new SessionExportError("cannot export session: invalid, unavailable or unsupported log input");
  }
}
