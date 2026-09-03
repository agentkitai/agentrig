import type { HarnessEvent } from "./events.js";
import type { SessionStore } from "./session-store.js";

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
  /** Set when the child's log could not be read (a line still being written, a corrupt line). */
  error?: string;
  /** The child's own children, recursively — `/tree` with live state. */
  children: ChildNode[];
}

/**
 * The live tree under one parent: each child's log is read (never written) and its own
 * `subagent.spawn` records lead to grandchildren. Bounded by the ids already visited, so a
 * forged or looping spawn record cannot recurse forever.
 */
export async function liveChildren(
  store: SessionStore,
  spawned: ReadonlyArray<{ id: string; task: string; reason?: string }>,
  visited: Set<string> = new Set(),
): Promise<ChildNode[]> {
  const nodes: ChildNode[] = [];
  for (const child of spawned) {
    if (visited.has(child.id)) continue;
    visited.add(child.id);
    const node: ChildNode = {
      id: child.id,
      task: child.task,
      ...(child.reason === undefined ? {} : { reason: child.reason }),
      status: null,
      children: [],
    };
    let events: HarnessEvent[] | null = null;
    try {
      events = await store.readAll(child.id);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        node.error = err instanceof Error ? err.message : String(err);
      }
    }
    if (events !== null) {
      node.status = summarizeSession(child.id, events);
      node.children = await liveChildren(store, node.status.children, visited);
    }
    nodes.push(node);
  }
  return nodes;
}
