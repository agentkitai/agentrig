import { PAGE_DIR } from "./page.js";
import type { IndexEntry, PageType, WikiPage } from "./types.js";

/**
 * BM25 over page bodies (PLAN §3.2). No API key, no embeddings — an `Embedder` seam can add
 * vectors later, but the default must work offline.
 *
 * The retrieval contract that matters: `unionRetrieve` returns index-selected pages ∪ BM25
 * top-k. It is *additive*, so recall can never regress below index-only selection — the failure
 * mode found in practice was BM25 replacing index picks and quietly losing the obvious page.
 */

const K1 = 1.5;
const B = 0.75;
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "is", "are", "was", "were", "be", "been", "of", "to",
  "in", "on", "for", "with", "as", "by", "at", "from", "it", "its", "this", "that", "these",
  "those", "we", "you", "they", "i", "not", "no", "do", "does", "did", "so", "if", "then",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_+#.-]+/)
    .map((t) => t.replace(/^[.\-]+|[.\-]+$/g, ""))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Tokens for indexing: the whole token plus its sub-parts, so a query for "auth" reaches
 * `auth-module` and "retry" reaches `retry_policy`. Query-side tokenization stays exact — only
 * the document side is expanded, so this adds recall without loosening what a query means.
 */
export function indexTokens(text: string): string[] {
  const out: string[] = [];
  for (const token of tokenize(text)) {
    out.push(token);
    if (!/[-_.]/.test(token)) continue;
    for (const part of token.split(/[-_.]+/)) {
      if (part.length > 1 && !STOPWORDS.has(part)) out.push(part);
    }
  }
  return out;
}

/** Internal machinery (the ingest capture marker) must not be searchable or quotable. */
export function searchableBody(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/g, " ");
}

export interface SearchHit {
  page: WikiPage;
  score: number;
  snippet: string;
}

/** The most query-dense line of the body, as the human-readable reason this page matched. */
export function snippetFor(page: WikiPage, queryTerms: Set<string>, max = 240): string {
  let best = "";
  let bestHits = -1;
  for (const line of searchableBody(page.body).split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const hits = tokenize(trimmed).filter((t) => queryTerms.has(t)).length;
    if (hits > bestHits) {
      bestHits = hits;
      best = trimmed;
    }
  }
  if (best === "") best = searchableBody(page.body).split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  return best.length > max ? `${best.slice(0, max)}…` : best;
}

/** Score every page against the query; returns the top `k` with a non-zero score. */
export function bm25Search(pages: WikiPage[], query: string, k = 8): SearchHit[] {
  const terms = tokenize(query);
  if (terms.length === 0 || pages.length === 0) return [];
  const queryTerms = new Set(terms);

  // a page's searchable text includes its slug and aliases, so "auth" finds `auth-module`
  const docs = pages.map((page) => {
    const text = `${page.frontmatter.slug} ${page.frontmatter.aliases.join(" ")} ${searchableBody(page.body)}`;
    const tokens = indexTokens(text);
    const freq = new Map<string, number>();
    for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
    return { page, freq, length: tokens.length };
  });

  const avgLen = docs.reduce((sum, d) => sum + d.length, 0) / docs.length || 1;
  const docFreq = new Map<string, number>();
  for (const term of queryTerms) {
    docFreq.set(term, docs.filter((d) => d.freq.has(term)).length);
  }

  const scored = docs.map((d) => {
    let score = 0;
    for (const term of terms) {
      const tf = d.freq.get(term) ?? 0;
      if (tf === 0) continue;
      const n = docFreq.get(term) ?? 0;
      // BM25 idf, floored at zero so a term in every page can't push scores negative
      const idf = Math.max(0, Math.log(1 + (docs.length - n + 0.5) / (n + 0.5)));
      score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * d.length) / avgLen)));
    }
    return { page: d.page, score, snippet: snippetFor(d.page, queryTerms) };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => (b.score === a.score ? a.page.path.localeCompare(b.page.path) : b.score - a.score))
    .slice(0, k);
}

/**
 * Index rows matching the query, best first. Scored by how many distinct query terms the row
 * carries: a single shared common word would otherwise drag in every page whose summary happens
 * to mention it, which makes `k` meaningless and floods the model's context.
 */
export function selectFromIndex(entries: IndexEntry[], query: string, limit?: number): IndexEntry[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];
  const scored: Array<{ entry: IndexEntry; hits: number }> = [];
  for (const e of entries) {
    const hay = new Set(indexTokens(`${e.slug} ${e.summary}`));
    const hits = terms.filter((t) => hay.has(t)).length;
    if (hits > 0) scored.push({ entry: e, hits });
  }
  scored.sort((a, b) => (b.hits === a.hits ? a.entry.path.localeCompare(b.entry.path) : b.hits - a.hits));
  return (limit === undefined ? scored : scored.slice(0, limit)).map((s) => s.entry);
}

export interface UnionHit extends SearchHit {
  /** Why this page is in the result: index selection, BM25, or both. */
  via: "index" | "bm25" | "both";
}

/** Translate a backend's `<pageType>/<slug>` tag into the wiki path it corresponds to. */
export function wikiPathForBackendPage(tag: string): string {
  const slash = tag.lastIndexOf("/");
  if (slash === -1) return tag;
  const type = tag.slice(0, slash) as PageType;
  const slug = tag.slice(slash + 1).replace(/\.md$/, "");
  const dir = PAGE_DIR[type] ?? type;
  return `${dir}/${slug}.md`;
}

/** A recall hit from an optional backend that maps to no local page (PLAN §3.8). */
export interface BackendOnlyHit {
  via: "backend";
  /** Provenance ref, e.g. `lore:<memory-id>`. */
  ref: string;
  text: string;
  score: number;
  page?: string;
}

export type RetrievalHit = UnionHit | BackendOnlyHit;

/**
 * Fold optional backend recall into a local result set (PLAN §3.8): union only, never a
 * replacement. A backend hit that names a page we already returned is dropped as a duplicate;
 * one that names an unknown page is appended as backend-only, after every local hit — so
 * enabling a backend can only add, never displace what the wiki itself found.
 */
export function withBackendRecall(
  local: UnionHit[],
  backendHits: Array<{ id: string; text: string; score: number; page?: string }>,
  backendId: string,
  k = 8,
): RetrievalHit[] {
  const seen = new Set(local.map((h) => h.page.path));
  const extra: BackendOnlyHit[] = [];
  for (const hit of backendHits) {
    // a backend page tag is `<pageType>/<slug>` (e.g. concept/retry-policy) while a wiki path is
    // `<dir>/<slug>.md` (concepts/retry-policy.md) — normalize before comparing
    if (hit.page !== undefined && seen.has(wikiPathForBackendPage(hit.page))) continue;
    const b: BackendOnlyHit = { via: "backend", ref: `${backendId}:${hit.id}`, text: hit.text, score: hit.score };
    if (hit.page !== undefined) b.page = hit.page;
    extra.push(b);
  }
  extra.sort((a, b) => b.score - a.score);
  // the backend is asked for k and never trusted with it: an enabled backend must not be able to
  // flood the model's context, which would make the tool's own k cap meaningless
  return [...local, ...extra.slice(0, Math.max(0, k))];
}

/**
 * Index ∪ BM25. Index-selected pages always survive (that is the whole point — additive only),
 * with BM25 supplying recall the catalog summary alone would miss.
 */
export function unionRetrieve(
  entries: IndexEntry[],
  pages: WikiPage[],
  query: string,
  k = 8,
): UnionHit[] {
  const byPath = new Map(pages.map((p) => [p.path, p]));
  const queryTerms = new Set(tokenize(query));
  const out = new Map<string, UnionHit>();

  // the index side is ranked and bounded too — unbounded, `k` would not be a bound at all
  for (const entry of selectFromIndex(entries, query, k)) {
    const page = byPath.get(entry.path);
    if (page === undefined) continue;
    out.set(page.path, { page, score: 0, snippet: snippetFor(page, queryTerms), via: "index" });
  }
  for (const hit of bm25Search(pages, query, k)) {
    const existing = out.get(hit.page.path);
    if (existing === undefined) out.set(hit.page.path, { ...hit, via: "bm25" });
    else out.set(hit.page.path, { ...existing, score: hit.score, via: "both" });
  }

  // index-matched pages outrank pure-BM25 ones (index-first), and within that band the page
  // BM25 also liked ranks above one it did not
  const rank = (h: UnionHit) => (h.via === "both" ? 0 : h.via === "index" ? 1 : 2);
  return [...out.values()].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.score !== b.score) return b.score - a.score;
    return a.page.path.localeCompare(b.page.path);
  });
}
