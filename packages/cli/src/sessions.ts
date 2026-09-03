import { SessionStore, type HarnessEvent } from "@agentkitai/agentrig-core";
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

/** One node of a session tree: a session and, when it is a fork, where in its parent it branched. */
export interface SessionTreeNode {
  id: string;
  /** Present when this session opened with `session.fork`. */
  atSeq?: number;
  children: SessionTreeNode[];
}

export interface SessionTree {
  /** The oldest ancestor reachable from the named session. */
  root: SessionTreeNode;
  /** Root first, the named session last. */
  ancestry: string[];
  /** Ancestors named by a fork marker whose log is not in the store. */
  missing: string[];
}

/** The first event of a session's own log, or null when the log is absent. Reads one line. */
async function firstEvent(store: SessionStore, id: string): Promise<HarnessEvent | null> {
  try {
    for await (const event of store.read(id)) return event;
    return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Ancestry and descendants of one session, from `session.fork` markers alone (R3c). The parent's
 * log records nothing about its forks — it is never written — so children are found by reading
 * the first event of every log in the store, one line each.
 */
export async function sessionTree(store: SessionStore, id: string): Promise<SessionTree> {
  const ancestry: string[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = id;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    ancestry.unshift(cursor);
    const first = await firstEvent(store, cursor);
    if (first === null && cursor !== id) missing.push(cursor);
    cursor = first?.type === "session.fork" ? first.parent : null;
  }

  const byParent = new Map<string, Array<{ id: string; atSeq: number }>>();
  for (const ref of await store.list()) {
    const first = await firstEvent(store, ref.id);
    if (first?.type !== "session.fork") continue;
    const siblings = byParent.get(first.parent) ?? [];
    siblings.push({ id: ref.id, atSeq: first.atSeq });
    byParent.set(first.parent, siblings);
  }

  const build = (nodeId: string, atSeq: number | undefined, path: Set<string>): SessionTreeNode => {
    const children = (byParent.get(nodeId) ?? [])
      .filter((c) => !path.has(c.id))
      .sort((a, b) => a.atSeq - b.atSeq || a.id.localeCompare(b.id))
      .map((c) => build(c.id, c.atSeq, new Set([...path, nodeId])));
    return { id: nodeId, ...(atSeq === undefined ? {} : { atSeq }), children };
  };
  const rootId = ancestry[0]!;
  return { root: build(rootId, undefined, new Set()), ancestry, missing };
}

/** The tree as indented lines, the named session marked. Shared with R3d's live view. */
export function renderSessionTree(tree: SessionTree, current: string): string[] {
  const lines: string[] = [];
  const walk = (node: SessionTreeNode, prefix: string, last: boolean, depth: number): void => {
    const branch = depth === 0 ? "" : `${prefix}${last ? "└─ " : "├─ "}`;
    const where = node.atSeq === undefined ? "" : ` (forked at seq ${node.atSeq})`;
    const gone = tree.missing.includes(node.id) ? " (log missing)" : "";
    const marker = node.id === current ? "  ← you are here" : "";
    lines.push(`${branch}${node.id}${where}${gone}${marker}`);
    const next = depth === 0 ? "" : `${prefix}${last ? "   " : "│  "}`;
    node.children.forEach((child, i) => walk(child, next, i === node.children.length - 1, depth + 1));
  };
  walk(tree.root, "", true, 0);
  return lines;
}
