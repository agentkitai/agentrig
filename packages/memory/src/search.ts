import type { IndexEntry, WikiPage } from "./types.js";

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

export interface SearchHit {
  page: WikiPage;
  score: number;
  snippet: string;
}

/** The most query-dense line of the body, as the human-readable reason this page matched. */
export function snippetFor(page: WikiPage, queryTerms: Set<string>, max = 240): string {
  let best = "";
  let bestHits = -1;
  for (const line of page.body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const hits = tokenize(trimmed).filter((t) => queryTerms.has(t)).length;
    if (hits > bestHits) {
      bestHits = hits;
      best = trimmed;
    }
  }
  if (best === "") best = page.body.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  return best.length > max ? `${best.slice(0, max)}…` : best;
}

/** Score every page against the query; returns the top `k` with a non-zero score. */
export function bm25Search(pages: WikiPage[], query: string, k = 8): SearchHit[] {
  const terms = tokenize(query);
  if (terms.length === 0 || pages.length === 0) return [];
  const queryTerms = new Set(terms);

  // a page's searchable text includes its slug and aliases, so "auth" finds `auth-module`
  const docs = pages.map((page) => {
    const text = `${page.frontmatter.slug} ${page.frontmatter.aliases.join(" ")} ${page.body}`;
    const tokens = tokenize(text);
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

/** Index rows whose slug, aliases, or summary match the query — the index-first selection. */
export function selectFromIndex(entries: IndexEntry[], query: string): IndexEntry[] {
  const terms = new Set(tokenize(query));
  if (terms.size === 0) return [];
  return entries.filter((e) => {
    const hay = new Set(tokenize(`${e.slug} ${e.summary}`));
    for (const t of terms) if (hay.has(t)) return true;
    return false;
  });
}

export interface UnionHit extends SearchHit {
  /** Why this page is in the result: index selection, BM25, or both. */
  via: "index" | "bm25" | "both";
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

  for (const entry of selectFromIndex(entries, query)) {
    const page = byPath.get(entry.path);
    if (page === undefined) continue;
    out.set(page.path, { page, score: Number.POSITIVE_INFINITY, snippet: snippetFor(page, queryTerms), via: "index" });
  }
  for (const hit of bm25Search(pages, query, k)) {
    const existing = out.get(hit.page.path);
    if (existing === undefined) out.set(hit.page.path, { ...hit, via: "bm25" });
    else out.set(hit.page.path, { ...existing, score: hit.score, via: "both" });
  }

  return [...out.values()].sort((a, b) => {
    // index picks first (both counts as index), then BM25 by score
    const rank = (h: UnionHit) => (h.via === "bm25" ? 1 : 0);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.score !== b.score) return b.score - a.score;
    return a.page.path.localeCompare(b.page.path);
  });
}
