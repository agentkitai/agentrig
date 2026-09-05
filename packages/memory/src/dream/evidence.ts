import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { RawStore, SessionLogRef } from "../types.js";
import { ScanBudget, type ScanOptions } from "../scan.js";
import { MaintenanceLimitError } from "../maintenance.js";

export interface PromotionWitness {
  /** Citation being checked, and the actual owner of an inherited event. */
  citation: string;
  sessionId: string;
  family: string;
  seq: number;
  field: "output" | "display";
  from: number;
  to: number;
  excerpt: string;
  /** SHA-256 of JSON.stringify(JSON.parse(raw JSONL record)), preserving raw key order. */
  eventHash: string;
  observationHash: string;
}

interface Observation {
  sessionId: string;
  seq: number;
  field: "output" | "display";
  text: string;
  tool: string;
  eventHash: string;
  observationHash: string;
}
interface LoadedSession {
  family: string;
  own: Observation[];
  inherited: Observation[];
  ownInputs: Array<{ seq: number; text: string }>;
  inheritedInputs: Array<{ seq: number; text: string }>;
  eventCount: number;
  error?: string;
}

/** An opaque runtime capability, not a serializable page/model assertion. */
export interface PromotionEvidenceIndex { readonly kind: "runtime-session-evidence" }
const indexes = new WeakMap<PromotionEvidenceIndex, Map<string, LoadedSession>>();
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const normalized = (text: string) => text.replace(/\s+/g, " ").trim();
/** Built-in receipt/view names; custom/MCP semantics cannot be inferred from a logged name. */
export const NON_OBSERVATION_TOOLS: readonly string[] = Object.freeze(["write_file", "edit_file", "memory_write", "memory_file_analysis",
  "attempt_log", "memory_ingest", "memory_read", "memory_search", "update_plan", "subagent", "skill"]);
const NON_OBSERVATIONS = new Set(NON_OBSERVATION_TOOLS);

function inputText(input: unknown): string {
  const pending = [input];
  const parts: string[] = [];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") parts.push(String(value));
    else if (Array.isArray(value)) { for (const item of value) pending.push(item); }
    else if (typeof value === "object" && value !== null) {
      for (const [key, item] of Object.entries(value)) { parts.push(key); pending.push(item); }
    }
  }
  return normalized(parts.join("\n"));
}

export interface EvidenceLimits extends ScanOptions {
  maxSessions?: number;
  maxLogBytes?: number;
  maxTotalBytes?: number;
}

/** Load only cited sessions and their ancestors, with hard read/allocation bounds. Paths come
 * from the trusted raw store, never from page-written citations. No raw record is rewritten. */
export async function loadPromotionEvidence(raw: Pick<RawStore, "sessions">, sessionIds: Iterable<string>, limits: EvidenceLimits = {}): Promise<PromotionEvidenceIndex> {
  const budget = new ScanBudget(limits);
  const maxSessions = limits.maxSessions ?? 128;
  const maxLogBytes = Math.min(limits.maxLogBytes ?? 8 * 1024 * 1024, limits.scanLimits?.maxFileBytes ?? Infinity);
  const maxTotalBytes = Math.min(limits.maxTotalBytes ?? 32 * 1024 * 1024, limits.scanLimits?.maxTotalBytes ?? Infinity);
  for (const limit of [maxSessions, maxLogBytes, maxTotalBytes]) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("promotion evidence limits must be positive integers");
  }
  const refs = new Map<string, SessionLogRef>();
  const duplicates = new Set<string>();
  let refCount = 0;
  for (const ref of await raw.sessions(undefined, limits)) {
    budget.check();
    if (++refCount > budget.limits.maxEntries) throw new MaintenanceLimitError("evidence session enumeration limit exceeded");
    if (refs.has(ref.id)) duplicates.add(ref.id);
    refs.set(ref.id, ref);
  }
  budget.check();
  const sessions = new Map<string, LoadedSession>();
  let bytesRead = 0;
  let filesRead = 0;
  const failed = (id: string, error: string): LoadedSession => ({ family: id, own: [], inherited: [], ownInputs: [], inheritedInputs: [], eventCount: 0, error });

  async function readLog(ref: SessionLogRef): Promise<Array<Record<string, unknown>>> {
    budget.check();
    if (++filesRead > maxSessions) throw new Error("session validation limit exceeded");
    const cap = Math.min(maxLogBytes, maxTotalBytes - bytesRead);
    if (cap <= 0) throw new Error("total evidence byte limit exceeded");
    const info = await lstat(ref.path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("session log is not a regular non-symlink file");
    if (info.size > cap) throw new Error("session evidence byte limit exceeded");
    // NOFOLLOW/NONBLOCK are POSIX hardening; Windows relies on the lstat check above.
    const handle = await open(ref.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let text: string;
    try {
      if (!(await handle.stat()).isFile()) throw new Error("session log changed file type");
      const buffer = Buffer.alloc(cap + 1);
      let length = 0;
      while (length < buffer.length) {
        budget.check();
        const read = await handle.read(buffer, length, buffer.length - length, length);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      bytesRead += length;
      if (length > cap) throw new Error("session evidence byte limit exceeded");
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
    } finally { await handle.close(); }
    const events: Array<Record<string, unknown>> = [];
    for (const line of text.split("\n")) {
      budget.check();
      if (line.trim() === "") continue;
      const event: unknown = JSON.parse(line);
      if (typeof event !== "object" || event === null || Array.isArray(event)) throw new Error("invalid session event");
      const e = event as Record<string, unknown>;
      if (e.sessionId !== ref.id || e.seq !== events.length || typeof e.type !== "string"
        || typeof e.ts !== "number" || !Number.isFinite(e.ts)) {
        throw new Error("session identity or sequence mismatch");
      }
      if (events.length > 0 && (e.type === "session.start" || e.type === "session.fork")) throw new Error("multiple session lineage roots");
      events.push(e);
    }
    if (events[0]?.type !== "session.start" && events[0]?.type !== "session.fork") throw new Error("missing session start/fork record");
    return events;
  }

  async function load(id: string, ancestry = new Set<string>()): Promise<LoadedSession> {
    budget.check();
    if (ancestry.has(id) || ancestry.size >= 32) return failed(id, "cyclic or excessive session ancestry");
    const cached = sessions.get(id);
    if (cached !== undefined) return cached;
    let result: LoadedSession;
    try {
      if (!ID.test(id)) throw new Error("invalid session ID");
      if (duplicates.has(id)) throw new Error("ambiguous duplicate session ID");
      const ref = refs.get(id);
      if (ref === undefined) throw new Error("session does not exist in the raw store");
      const events = await readLog(ref);
      const first = events[0]!;
      result = { family: id, own: [], inherited: [], ownInputs: [], inheritedInputs: [], eventCount: events.length };
      if (first.parent !== undefined) {
        if (typeof first.parent !== "string" || !ID.test(first.parent)) throw new Error("invalid session parent");
        const parent = await load(first.parent, new Set([...ancestry, id]));
        if (parent.error !== undefined) throw new Error(`unverified parent: ${parent.error}`);
        result.family = parent.family;
        if (first.type === "session.fork") {
          if (!Number.isSafeInteger(first.atSeq) || Number(first.atSeq) < 0 || Number(first.atSeq) >= parent.eventCount) throw new Error("invalid fork point");
          result.inherited = [...parent.inherited, ...parent.own.filter(o => o.seq <= Number(first.atSeq))];
          result.inheritedInputs = [...parent.inheritedInputs, ...parent.ownInputs.filter(input => input.seq <= Number(first.atSeq))];
        } else result.inheritedInputs = [...parent.inheritedInputs, ...parent.ownInputs];
      } else if (first.type === "session.fork") throw new Error("missing fork parent");
      const tools = new Map<string, string>();
      for (const event of events) {
        budget.check();
        if (event.type === "tool.call" && typeof event.id === "string" && typeof event.name === "string") {
          tools.set(event.id, event.name);
          result.ownInputs.push({ seq: Number(event.seq), text: inputText(event.input) });
        }
        if (event.type !== "tool.result") continue;
        if (typeof event.id !== "string" || typeof event.ok !== "boolean" || typeof event.display !== "string"
          || (event.output !== undefined && typeof event.output !== "string")
          || (event.truncated !== undefined && typeof event.truncated !== "boolean")
          || (event.outputIncomplete !== undefined && typeof event.outputIncomplete !== "boolean")) throw new Error("malformed tool result");
        if (event.outputIncomplete === true || (event.truncated === true && typeof event.output !== "string")) continue;
        if (typeof event.output !== "string" && /(?:^|\n)(?:…|\.{3}) \[truncated \d+ (?:UTF-16 code units|chars)\]\s*$/.test(event.display)) continue;
        const tool = tools.get(event.id) ?? "";
        if (NON_OBSERVATIONS.has(tool)) continue;
        const field = typeof event.output === "string" ? "output" : "display";
        const text = String(event[field]);
        result.own.push({ sessionId: id, seq: Number(event.seq), field, text, tool,
          eventHash: hash(JSON.stringify(event)), observationHash: hash(normalized(text)) });
      }
    } catch (err) {
      budget.check(); // Cancellation must not be converted into an ordinary evidence rejection.
      result = failed(id, err instanceof Error ? err.message : String(err));
    }
    sessions.set(id, result);
    return result;
  }
  const requested = new Set<string>();
  let citationCount = 0;
  for (const id of sessionIds) {
    budget.check();
    if (++citationCount > budget.limits.maxEntries) throw new MaintenanceLimitError("evidence citation limit exceeded");
    requested.add(id);
  }
  for (const id of [...requested].sort()) await load(id);
  budget.check();
  const index: PromotionEvidenceIndex = Object.freeze({ kind: "runtime-session-evidence" });
  indexes.set(index, sessions);
  return index;
}

/** Exact, located textual support only. This does not judge semantic truth or generality. */
export function witnessesForClaim(index: PromotionEvidenceIndex | undefined, sessionId: string, claim: string): { witnesses: PromotionWitness[]; error?: string } {
  const session = index === undefined ? undefined : indexes.get(index)?.get(sessionId);
  if (session === undefined) return { witnesses: [], error: "no runtime-validated evidence for this session" };
  if (session.error !== undefined) return { witnesses: [], error: session.error };
  const needle = normalized(claim);
  if (claim !== "" && [...session.inheritedInputs, ...session.ownInputs].some(input => input.text.includes(needle))) {
    return { witnesses: [], error: "claim occurs in agent tool input; self-authored text is not corroboration" };
  }
  const witnesses: PromotionWitness[] = [];
  for (const observation of [...session.inherited, ...session.own]) {
    let offset = 0;
    for (const rawLine of observation.text.split("\n")) {
      const line = observation.tool === "read_file" ? rawLine.replace(/^\s*\d+\t/, "") : rawLine;
      if (line.trim() === claim && claim !== "") {
        const from = offset + rawLine.indexOf(claim);
        witnesses.push({ citation: `session:${sessionId}`, sessionId: observation.sessionId, family: session.family,
          seq: observation.seq, field: observation.field, from, to: from + claim.length, excerpt: claim,
          eventHash: observation.eventHash, observationHash: observation.observationHash });
      }
      offset += rawLine.length + 1;
    }
  }
  return { witnesses };
}
