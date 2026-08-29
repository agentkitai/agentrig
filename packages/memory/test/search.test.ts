import { describe, expect, it } from "vitest";
import { bm25Search, selectFromIndex, tokenize, unionRetrieve } from "@agentkitai/agentrig-memory";
import type { IndexEntry, WikiPage } from "@agentkitai/agentrig-memory";

const page = (slug: string, body: string, aliases: string[] = []): WikiPage => ({
  path: `concepts/${slug}.md`,
  frontmatter: { type: "concept", slug, aliases, sources: [], updated: "2026-08-29", confidence: "high" },
  body,
  updatedAt: 0,
});

const pages = [
  page("retry-policy", "- [stated] Retries apply per request, not per batch. Backoff is exponential."),
  page("auth-module", "- [stated] The auth module issues tokens and refreshes them.", ["auth"]),
  page("cli-shape", "- [stated] The CLI stays thin; logic belongs in a package."),
];

describe("tokenize", () => {
  it("drops stopwords and keeps identifier-ish tokens", () => {
    expect(tokenize("The retry_policy is in max_tokens and gpt-5.6")).toEqual([
      "retry_policy",
      "max_tokens",
      "gpt-5.6",
    ]);
  });
});

describe("bm25Search", () => {
  it("ranks the page that actually discusses the query first", () => {
    const hits = bm25Search(pages, "retry backoff");
    expect(hits[0]!.page.frontmatter.slug).toBe("retry-policy");
    expect(hits[0]!.snippet).toContain("Retries apply");
  });

  it("matches on slug and aliases, not just body", () => {
    expect(bm25Search(pages, "auth")[0]!.page.frontmatter.slug).toBe("auth-module");
  });

  it("returns nothing for a query with no content words", () => {
    expect(bm25Search(pages, "the and of")).toEqual([]);
  });

  it("is deterministic for tied scores", () => {
    const a = bm25Search(pages, "stated").map((h) => h.page.path);
    const b = bm25Search(pages, "stated").map((h) => h.page.path);
    expect(a).toEqual(b);
  });
});

const entries: IndexEntry[] = [
  { slug: "retry-policy", path: "concepts/retry-policy.md", type: "concept", status: "active", summary: "how retries work" },
  { slug: "auth-module", path: "concepts/auth-module.md", type: "concept", status: "active", summary: "token issuance" },
  { slug: "cli-shape", path: "concepts/cli-shape.md", type: "concept", status: "active", summary: "the CLI stays thin" },
];

describe("unionRetrieve — additive, never regresses below index-only", () => {
  it("keeps an index-selected page even when BM25 would not rank it", () => {
    // "token issuance" matches the index summary; the body says "issues tokens"
    const hits = unionRetrieve(entries, pages, "issuance");
    const paths = hits.map((h) => h.page.path);
    expect(paths).toContain("concepts/auth-module.md");
    expect(hits.find((h) => h.page.path === "concepts/auth-module.md")!.via).toBe("index");
  });

  it("adds BM25 recall the index summary alone would miss", () => {
    // "backoff" appears only in the body, not in any index summary
    expect(selectFromIndex(entries, "backoff")).toEqual([]);
    const hits = unionRetrieve(entries, pages, "backoff");
    expect(hits.map((h) => h.page.path)).toContain("concepts/retry-policy.md");
    expect(hits[0]!.via).toBe("bm25");
  });

  it("marks a page found by both and never duplicates it", () => {
    const hits = unionRetrieve(entries, pages, "retries retry-policy");
    const retry = hits.filter((h) => h.page.path === "concepts/retry-policy.md");
    expect(retry).toHaveLength(1);
    expect(retry[0]!.via).toBe("both");
  });

  it("ranks index-matched pages above pages only BM25 found", () => {
    const hits = unionRetrieve(entries, pages, "how retries work token issuance", 8);
    const firstBm25Only = hits.findIndex((h) => h.via === "bm25");
    const lastIndexed = hits.map((h) => h.via !== "bm25").lastIndexOf(true);
    if (firstBm25Only !== -1) expect(lastIndexed).toBeLessThan(firstBm25Only);
  });

  it("bounds the index side too, ranked by term overlap rather than truncated arbitrarily", () => {
    // an unbounded index side made `k` meaningless: one shared common word dragged in every
    // page whose summary mentioned it, flooding the model's context
    const many: IndexEntry[] = Array.from({ length: 300 }, (_, i) => ({
      slug: `p${i}`,
      path: `concepts/p${i}.md`,
      type: "concept",
      status: "active",
      summary: "the module does things",
    }));
    const manyPages = many.map((e) => ({
      path: e.path,
      frontmatter: { type: "concept" as const, slug: e.slug, aliases: [], sources: [], updated: "2026-08-29", confidence: "high" as const },
      body: "- [stated] the module does things",
      updatedAt: 0,
    }));
    expect(unionRetrieve(many, manyPages, "module", 8).length).toBeLessThanOrEqual(16);
  });

  it("prefers the page both index and BM25 matched over one only the index matched", () => {
    const twoEntries: IndexEntry[] = [
      { slug: "aaa", path: "concepts/aaa.md", type: "concept", status: "active", summary: "retries mentioned here" },
      { slug: "bbb", path: "concepts/bbb.md", type: "concept", status: "active", summary: "retries mentioned here" },
    ];
    const twoPages = [
      page("aaa", "- [stated] nothing much at all"),
      page("bbb", "- [stated] a deep discussion of retries and retries and retries"),
    ].map((p, i) => ({ ...p, path: twoEntries[i]!.path }));
    const hits = unionRetrieve(twoEntries, twoPages, "retries", 8);
    expect(hits[0]!.page.path).toBe("concepts/bbb.md");
    expect(hits[0]!.via).toBe("both");
  });
});
