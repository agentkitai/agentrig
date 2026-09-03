import type { HarnessEvent } from "./events.js";
import { isValidSessionId, type SessionStore } from "./session-store.js";

/**
 * Live status of a child session, read from its own log (R3d). The parent's log records only
 * that a child was spawned and how it ended; everything between — which turn it is on, which
 * tool it is in, what it is working on — is in the child's log, which is on disk and is the
 * source of truth. Nothing here writes: the parent's log stays the parent's alone.
 */
export interface ChildStatus {
  id: string;
  /** From the child's `session.start`; absent while the child has not written one yet. */
  task?: string;
  /** The parent its own `session.start` names (#104); absent for logs written before that field. */
  parent?: string;
  /** Timestamp of the child's first event, or null before it has written anything. */
  startedAt: number | null;
  /** Timestamp of the latest event read. */
  lastTs: number | null;
  /** The turn the child is on (last `turn.start`), 0 before its first. */
  turns: number;
  /** A `tool.call` with no `tool.result` yet: what the child is doing right now. */
  tool: { name: string; sinceTs: number } | null;
  /** The plan item in progress (or the first pending one) from the latest `plan.updated`. */
  plan: string | null;
  /** The child's own `session.end`, once written. */
  ended: { reason: string; ts: number } | null;
  /** Children the child itself spawned, from its `subagent.spawn`/`subagent.end` records. */
  children: Array<{ id: string; task: string; reason?: string }>;
}

/** Pure fold over a child's recorded events; the same events, the same status. */
export function summarizeSession(id: string, events: readonly HarnessEvent[]): ChildStatus {
  const status: ChildStatus = {
    id,
    startedAt: null,
    lastTs: null,
    turns: 0,
    tool: null,
    plan: null,
    ended: null,
    children: [],
  };
  const open = new Map<string, { name: string; sinceTs: number }>();
  for (const e of events) {
    status.startedAt ??= e.ts;
    status.lastTs = e.ts;
    switch (e.type) {
      case "session.start":
        status.task = e.task;
        if (e.parent !== undefined) status.parent = e.parent;
        break;
      case "turn.start":
        status.turns = e.n;
        break;
      case "tool.call":
        open.set(e.id, { name: e.name, sinceTs: e.ts });
        break;
      case "tool.result":
      case "tool.denied":
        open.delete(e.id);
        break;
      case "plan.updated": {
        const current = e.items.find((i) => i.status === "in_progress") ?? e.items.find((i) => i.status === "pending");
        status.plan = current?.text ?? null;
        break;
      }
      case "subagent.spawn":
        status.children.push({ id: e.id, task: e.task });
        break;
      case "subagent.end": {
        const child = status.children.find((c) => c.id === e.id);
        if (child !== undefined) child.reason = e.reason ?? "ended";
        break;
      }
      case "session.end":
        status.ended = { reason: e.reason, ts: e.ts };
        open.clear();
        break;
      default:
        break;
    }
  }
  // the most recent open call is the one in progress; the loop runs tools sequentially today
  const latest = [...open.values()].at(-1);
  status.tool = latest ?? null;
  return status;
}

export interface ChildNode {
  id: string;
  /** What the parent recorded at spawn: the label or task. */
  task: string;
  /** The parent's `subagent.end` reason, once it has one — the authoritative "how it finished". */
  reason?: string;
  /** Read from the child's own log; null when the log does not exist yet. */
  status: ChildStatus | null;
  /** Set when the child's log could not be read at all (a corrupt line, an invalid id). */
  error?: string;
  /** The id is not a session id at all — a forged spawn record; permanent, unlike a torn log. */
  invalid?: true;
  /** The log's last line was still being written; `status` folds every line before it. */
  torn?: true;
  /** The child's own children, recursively — `/tree` with live state. */
  children: ChildNode[];
}

/**
 * The live tree under one parent: each child's log is read (never written) and its own
 * `subagent.spawn` records lead to grandchildren. The walk is breadth-first and every id found at
 * one depth is claimed — across all branches — before the next depth is read, so a record in one
 * branch cannot pull a session that belongs at the same or a shallower depth under itself, and a
 * loop is visited once. Records are model-emitted through a gated tool, but a log on disk is
 * untrusted input all the same.
 *
 * Authority (#104): a session's own `session.start.parent` is believed. A record naming a
 * session whose log names a different parent is dropped; a log without the field (written
 * before it) or not yet written cannot testify and is accepted, so the breadth-first claims are
 * the only protection for those. The limit is the pointer itself: a log that names the wrong
 * parent places the session under that parent — and only whoever spawned the session writes it
 * (the subagent tool sets it from its own session id; it is not model-controllable).
 */
export async function liveChildren(
  store: SessionStore,
  spawned: ReadonlyArray<{ id: string; task: string; reason?: string }>,
  opts: { parent?: string } = {},
): Promise<ChildNode[]> {
  const claimed = new Set<string>();
  if (opts.parent !== undefined) claimed.add(opts.parent);
  /**
   * A record is accepted only if the named session does not contradict it (#104): a log whose
   * `session.start` names a different parent belongs to that parent, whatever this record says.
   * A log that is missing (starting) or predates the field cannot testify and is accepted.
   */
  const disputed = async (id: string, claimant: string | undefined): Promise<boolean> => {
    if (claimant === undefined || !isValidSessionId(id)) return false;
    let first: HarnessEvent | null;
    try {
      first = await store.firstEvent(id);
    } catch {
      return false;
    }
    return first?.type === "session.start" && first.parent !== undefined && first.parent !== claimant;
  };
  const place = async (
    into: ChildNode[],
    records: ReadonlyArray<{ id: string; task: string; reason?: string }>,
    claimant: string | undefined,
  ): Promise<ChildNode[]> => {
    const placed: ChildNode[] = [];
    for (const r of records) {
      if (claimed.has(r.id)) continue;
      if (await disputed(r.id, claimant)) continue;
      claimed.add(r.id);
      const node: ChildNode = {
        id: r.id,
        task: r.task,
        ...(r.reason === undefined ? {} : { reason: r.reason }),
        status: null,
        children: [],
      };
      into.push(node);
      placed.push(node);
    }
    return placed;
  };

  const roots: ChildNode[] = [];
  let level = await place(roots, spawned, opts.parent);
  while (level.length > 0) {
    // read the whole depth first: what each log claims is only placed once every log at this
    // depth has been read, so the earliest record wins by depth, never by branch order — and a
    // record the named session's own log disputes is never placed at all
    for (const node of level) await fill(store, node);
    const next: ChildNode[] = [];
    for (const node of level) {
      if (node.status === null) continue;
      next.push(...(await place(node.children, node.status.children, node.id)));
    }
    level = next;
  }
  return roots;
}

/** Reads one child's own log into its node; a missing log is "starting", a torn tail is flagged. */
async function fill(store: SessionStore, node: ChildNode): Promise<void> {
  if (!isValidSessionId(node.id)) {
    node.invalid = true;
    node.error = "not a session id";
    return;
  }
  let read: { events: HarnessEvent[]; torn: boolean } | null = null;
  try {
    read = await store.readPrefix(node.id);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      node.error = err instanceof Error ? err.message : String(err);
    }
  }
  if (read === null) return;
  node.status = summarizeSession(node.id, read.events);
  if (read.torn) node.torn = true;
}
