import { SessionStore } from "@agentkitai/agentrig-core";
import { bm25Search, type WikiPage } from "@agentkitai/agentrig-memory";
import { renderEvent } from "./render.js";

export interface SessionSearchHit {
  id: string;
  score: number;
  snippet: string;
}

/** Fork at an explicit physical sequence, or at the current end of the parent's own log. */
export async function forkSession(store: SessionStore, parent: string, atSeq?: number): Promise<string> {
  let resolved = atSeq;
  if (resolved === undefined) {
    const events = await store.readAll(parent);
    const last = events.at(-1);
    if (last === undefined) throw new Error(`cannot fork empty session ${parent}`);
    resolved = last.seq;
  }
  return store.fork(parent, resolved);
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
