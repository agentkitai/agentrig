import { SessionStore, type ChildNode, type SessionTree, type SessionTreeNode } from "@agentkitai/agentrig-core";
import { bm25Search, type WikiPage } from "@agentkitai/agentrig-memory";
import { renderEvent } from "./render.js";

export interface SessionSearchHit {
  id: string;
  score: number;
  snippet: string;
}

/** Fork at an explicit physical sequence, or at the current end of the parent's own log. */
export async function forkSession(store: SessionStore, parent: string, atSeq?: number): Promise<string> {
  return (await forkSessionAt(store, parent, atSeq)).id;
}

/** `forkSession`, also reporting the sequence it resolved — the TUI says where it branched. */
export async function forkSessionAt(
  store: SessionStore,
  parent: string,
  atSeq?: number,
): Promise<{ id: string; atSeq: number }> {
  let resolved = atSeq;
  if (resolved === undefined) {
    const events = await store.readAll(parent);
    const last = events.at(-1);
    if (last === undefined) throw new Error(`cannot fork empty session ${parent}`);
    resolved = last.seq;
  }
  return { id: await store.fork(parent, resolved), atSeq: resolved };
}

/** Render the materialized tree, optionally stopping at a sequence in the named session's own log. */
export async function replaySession(store: SessionStore, id: string, until?: number): Promise<string[]> {
  return (await store.materialize(id, until)).map(renderEvent);
}

/** BM25 over the same rendered, materialized transcript that `sessions replay` prints. */
export async function searchSessions(
  store: SessionStore,
  query: string,
  limit = 8,
): Promise<SessionSearchHit[]> {
  const refs = await store.list();
  const pages: WikiPage[] = await Promise.all(refs.map(async (ref) => ({
    path: ref.id,
    frontmatter: {
      type: "source",
      slug: ref.id,
      aliases: [],
      sources: [`session:${ref.id}`],
      updated: new Date(ref.updatedAt).toISOString(),
      confidence: "high",
    },
    body: (await replaySession(store, ref.id)).join("\n"),
    updatedAt: ref.updatedAt,
  })));

  return bm25Search(pages, query, limit).map((hit) => ({
    id: hit.page.frontmatter.slug,
    score: hit.score,
    snippet: hit.snippet,
  }));
}

/**
 * One indented tree, drawn the same way for `/tree` (R3c) and `/children` (R3d): the two differ
 * only in what a node's label says, so they share the drawing and cannot drift apart.
 */
export function renderTreeLines<T>(
  roots: readonly T[],
  label: (node: T) => string,
  kids: (node: T) => readonly T[],
): string[] {
  const lines: string[] = [];
  const walk = (node: T, prefix: string, last: boolean, depth: number): void => {
    const branch = depth === 0 ? "" : `${prefix}${last ? "└─ " : "├─ "}`;
    lines.push(`${branch}${label(node)}`);
    const next = depth === 0 ? "" : `${prefix}${last ? "   " : "│  "}`;
    const children = kids(node);
    children.forEach((child, i) => walk(child, next, i === children.length - 1, depth + 1));
  };
  roots.forEach((root, i) => walk(root, "", i === roots.length - 1, 0));
  return lines;
}

/** The tree as indented lines, the named session marked. */
export function renderSessionTree(tree: SessionTree, current: string): string[] {
  const lines = renderTreeLines<SessionTreeNode>(
    [tree.root],
    (node) => {
      const where = node.atSeq === undefined ? "" : ` (forked at seq ${node.atSeq})`;
      const gone = tree.missing.includes(node.id) ? " (log missing)" : "";
      const marker = node.id === current ? "  ← you are here" : "";
      return `${node.id}${where}${gone}${marker}`;
    },
    (node) => node.children,
  );
  if (tree.unreadable.length > 0) {
    lines.push(`(skipped ${tree.unreadable.length} unreadable log(s): ${tree.unreadable.join(", ")})`);
  }
  return lines;
}

/** 65_000 → "1m05s"; under a minute → "12s". Floored, never overstating. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1_000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

/** One line per child: turn, current tool, latest plan item, elapsed — or how it finished. */
export function renderChildLine(node: ChildNode, now: number): string {
  const head = `${node.id} · ${oneLine(node.task, 48)}`;
  if (node.error !== undefined) return `${head} · log unreadable right now (${oneLine(node.error, 60)})`;
  const s = node.status;
  if (s === null || s.startedAt === null) {
    return node.reason === undefined ? `${head} · starting` : `${head} · ${node.reason} before writing a log`;
  }
  const finished = node.reason ?? s.ended?.reason;
  if (finished !== undefined) {
    const endTs = s.ended?.ts ?? s.lastTs ?? s.startedAt;
    return `${head} · ${finished} after ${s.turns} turn(s) · ${formatElapsed(endTs - s.startedAt)}`;
  }
  const parts = [`turn ${s.turns}`];
  if (s.tool !== null) parts.push(`${s.tool.name} ${formatElapsed(now - s.tool.sinceTs)}`);
  else parts.push("thinking");
  if (s.plan !== null) parts.push(`plan: ${oneLine(s.plan, 48)}`);
  parts.push(formatElapsed(now - s.startedAt));
  return `${head} · ${parts.join(" · ")}`;
}

/** The live children tree — `/tree` with live state — as lines. */
export function renderChildren(nodes: readonly ChildNode[], now: number): string[] {
  return renderTreeLines<ChildNode>(nodes, (n) => renderChildLine(n, now), (n) => n.children);
}
