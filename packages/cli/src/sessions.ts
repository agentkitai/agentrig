import { SessionStore, type SessionTree, type SessionTreeNode } from "@agentkitai/agentrig-core";
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
  if (tree.unreadable.length > 0) {
    lines.push(`(skipped ${tree.unreadable.length} unreadable log(s): ${tree.unreadable.join(", ")})`);
  }
  return lines;
}
