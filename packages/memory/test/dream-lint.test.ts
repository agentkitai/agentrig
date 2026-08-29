import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IndexEntry, WikiPage } from "@agentkitai/agentrig-memory";
import {
  gatherFromAttempts,
  isClean,
  orient,
  proposedPath,
  rebuildIndex,
  resolveLink,
  selectForPromotion,
  sessionEvidence,
  structuralLint,
  dropUnknownPages,
} from "@agentkitai/agentrig-memory";

function page(path: string, body: string, fm: Partial<WikiPage["frontmatter"]> = {}): WikiPage {
  return {
    path,
    body,
    updatedAt: 0,
    frontmatter: {
      type: "concept",
      slug: path.replace(/^.*\//, "").replace(/\.md$/, ""),
      aliases: [],
      sources: ["session:s1"],
      updated: "2026-08-01",
      confidence: "high",
      ...fm,
    },
  };
}

const entry = (path: string, over: Partial<IndexEntry> = {}): IndexEntry => ({
  slug: path.replace(/^.*\//, "").replace(/\.md$/, ""),
  path,
  type: "concept",
  summary: "s",
  status: "active",
  ...over,
});

describe("structuralLint: orphans", () => {
  it("flags a page nothing links to and the index does not list", async () => {
    const pages = [page("concepts/a.md", "- [stated] alpha (session:s1)\n")];
    const f = await structuralLint(pages, []);
    expect(f.orphans).toEqual(["concepts/a.md"]);
  });

  it("a page the index lists is not an orphan", async () => {
    const pages = [page("concepts/a.md", "- [stated] alpha (session:s1)\n")];
    const f = await structuralLint(pages, [entry("concepts/a.md")]);
    expect(f.orphans).toEqual([]);
  });

  it("a page another page links to is not an orphan", async () => {
    const pages = [
      page("concepts/a.md", "- [stated] see [[b]] (session:s1)\n"),
      page("concepts/b.md", "- [stated] beta (session:s1)\n"),
    ];
    const f = await structuralLint(pages, []);
    expect(f.orphans).toEqual(["concepts/a.md"]);
  });

  it("a page linking only to itself is still an orphan", async () => {
    const pages = [page("concepts/a.md", "- [stated] see [[a]] (session:s1)\n")];
    expect((await structuralLint(pages, [])).orphans).toEqual(["concepts/a.md"]);
  });
});

describe("structuralLint: missing pages", () => {
  it("reports a wikilink with no page behind it, and who mentioned it", async () => {
    const pages = [
      page("concepts/a.md", "- [stated] uses [[retry-policy]] (session:s1)\n"),
      page("concepts/b.md", "- [stated] also [[retry-policy]] (session:s1)\n"),
    ];
    const f = await structuralLint(pages, []);
    expect(f.missingPages).toEqual([
      { concept: "retry-policy", mentionedIn: ["concepts/a.md", "concepts/b.md"] },
    ]);
  });

  it("resolves a link by slug, by path, or by alias", () => {
    const pages = [page("concepts/retry.md", "x", { slug: "retry", aliases: ["backoff"] })];
    expect(resolveLink("retry", pages)?.path).toBe("concepts/retry.md");
    expect(resolveLink("concepts/retry.md", pages)?.path).toBe("concepts/retry.md");
    expect(resolveLink("backoff", pages)?.path).toBe("concepts/retry.md");
    expect(resolveLink("RETRY", pages)?.path).toBe("concepts/retry.md");
    expect(resolveLink("nope", pages)).toBeUndefined();
  });

  it("proposes a concrete path for a missing concept", () => {
    expect(proposedPath("Retry Policy")).toBe("concepts/retry-policy.md");
    expect(proposedPath("  ")).toBe("concepts/unnamed.md");
  });
});

describe("structuralLint: index drift", () => {
  it("reports rows whose page is gone and pages the index never lists", async () => {
    const pages = [page("concepts/a.md", "x")];
    const f = await structuralLint(pages, [entry("concepts/ghost.md")]);
    expect(f.indexDrift.danglingRows).toEqual(["concepts/ghost.md"]);
    expect(f.indexDrift.unlisted).toEqual(["concepts/a.md"]);
  });

  it("reports reserved-but-never-filled placeholders", async () => {
    const f = await structuralLint([], [entry("concepts/p.md", { status: "planned" })]);
    expect(f.unfilled).toEqual(["concepts/p.md"]);
  });
});

describe("structuralLint: text hygiene", () => {
  it("flags relative dates that will read wrong later", async () => {
    const pages = [page("concepts/a.md", "- [stated] we fixed it yesterday (session:s1)\n")];
    const f = await structuralLint(pages, []);
    expect(f.relativeDates).toHaveLength(1);
    expect(f.relativeDates[0]!.phrase).toBe("yesterday");
  });

  it("does not flag an absolute date", async () => {
    const pages = [page("concepts/a.md", "- [stated] fixed on 2026-08-01 (session:s1)\n")];
    expect((await structuralLint(pages, [])).relativeDates).toEqual([]);
  });

  it("flags a fact line with no source", async () => {
    const pages = [page("concepts/a.md", "- [stated] this came from nowhere\n")];
    const f = await structuralLint(pages, []);
    expect(f.unsourced).toHaveLength(1);
  });

  it("accepts any of the provenance namespaces as a source", async () => {
    const pages = [
      page(
        "concepts/a.md",
        "- [stated] a (session:s1)\n- [stated] b (doc:d1)\n- [stated] c (human)\n- [stated] d (dream:2026-08-01)\n- [stated] e (lore:m1)\n",
      ),
    ];
    expect((await structuralLint(pages, [])).unsourced).toEqual([]);
  });
});

describe("structuralLint: stale file references", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agentrig-lint-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "real.ts"), "x", "utf8");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("flags a reference to a file that no longer exists", async () => {
    const pages = [page("concepts/a.md", "- [stated] see `src/gone.ts` (session:s1)\n")];
    const f = await structuralLint(pages, [], { cwd: root });
    expect(f.staleFileRefs).toEqual([{ page: "concepts/a.md", ref: "src/gone.ts" }]);
  });

  it("does not flag a file that exists", async () => {
    const pages = [page("concepts/a.md", "- [stated] see `src/real.ts` (session:s1)\n")];
    expect((await structuralLint(pages, [], { cwd: root })).staleFileRefs).toEqual([]);
  });

  it("skips the check entirely with no cwd, rather than reporting everything as stale", async () => {
    const pages = [page("concepts/a.md", "- [stated] see `src/gone.ts` (session:s1)\n")];
    expect((await structuralLint(pages, [])).staleFileRefs).toEqual([]);
  });
});

describe("isClean", () => {
  it("is true only when nothing at all was found", async () => {
    expect(isClean(await structuralLint([], []))).toBe(true);
    expect(isClean(await structuralLint([page("concepts/a.md", "x")], []))).toBe(false);
  });
});

describe("promotion is structurally gated (PLAN §3.4, §7)", () => {
  it("never promotes a page derived from a single session", () => {
    const { promote, rejected } = selectForPromotion([
      page("concepts/a.md", "- [stated] alpha (session:s1)\n", { sources: ["session:s1"] }),
    ]);
    expect(promote).toEqual([]);
    expect(rejected[0]!.reason).toContain("derived from 1 session(s)");
  });

  it("promotes a page corroborated by two independent sessions", () => {
    const { promote } = selectForPromotion([
      page("concepts/a.md", "- [stated] alpha (session:s1)\n- [stated] again (session:s2)\n", {
        sources: ["session:s1", "session:s2"],
      }),
    ]);
    expect(promote).toHaveLength(1);
    expect(promote[0]!.evidence).toEqual(["session:s1", "session:s2"]);
  });

  it("counts distinct sessions, so one session cited five times is still one", () => {
    const { promote, rejected } = selectForPromotion([
      page("concepts/a.md", "- [stated] a (session:s1)\n- [stated] b (session:s1)\n- [stated] c (session:s1)\n", {
        sources: ["session:s1", "session:s1"],
      }),
    ]);
    expect(promote).toEqual([]);
    expect(rejected[0]!.evidence).toEqual(["session:s1"]);
  });

  it("gathers evidence from fact lines as well as frontmatter", () => {
    const { promote } = selectForPromotion([
      page("concepts/a.md", "- [stated] alpha (session:s2, lore:m0)\n", { sources: ["session:s1"] }),
    ]);
    expect(promote[0]!.evidence).toEqual(["session:s1", "session:s2"]);
  });

  it("rejects a page with no provenance at all", () => {
    const { rejected } = selectForPromotion([page("concepts/a.md", "- [stated] alpha\n", { sources: [] })]);
    expect(rejected[0]!.reason).toBe("no session provenance at all");
  });

  it("refuses to drop the floor below two, whatever the caller asks", () => {
    const one = page("concepts/a.md", "- [stated] alpha (session:s1)\n", { sources: ["session:s1"] });
    expect(selectForPromotion([one], { minSessions: 1 }).promote).toEqual([]);
    expect(selectForPromotion([one], { minSessions: 0 }).promote).toEqual([]);
  });

  it("holds back a low-confidence page even with enough sessions", () => {
    const { promote, rejected } = selectForPromotion([
      page("concepts/a.md", "- [stated] a (session:s1)\n- [stated] b (session:s2)\n", {
        sources: ["session:s1", "session:s2"],
        confidence: "low",
      }),
    ]);
    expect(promote).toEqual([]);
    expect(rejected[0]!.reason).toContain('confidence "low"');
  });

  it("sessionEvidence dedupes and sorts", () => {
    const p = page("concepts/a.md", "- [stated] x (session:b)\n- [stated] y (session:a)\n", {
      sources: ["session:b"],
    });
    expect(sessionEvidence(p)).toEqual(["session:a", "session:b"]);
  });
});

describe("phase 2: gather signal", () => {
  const attempt = (over: Record<string, unknown>) => ({
    id: "a", sessionId: "s1", ts: 0, hypothesis: "h", actions: "x",
    outcome: "failed" as const, evidence: [], ...over,
  });

  it("lifts an attempt's lesson without a model call", () => {
    const signals = gatherFromAttempts([attempt({ lesson: "retries are per request" })]);
    expect(signals).toContainEqual({ kind: "lesson", text: "retries are per request", sources: ["session:s1"] });
  });

  it("merges one lesson learned in two sessions into a single signal", () => {
    const signals = gatherFromAttempts([
      attempt({ lesson: "same lesson", sessionId: "s1" }),
      attempt({ lesson: "same lesson", sessionId: "s2" }),
    ]).filter((s) => s.kind === "lesson");
    expect(signals).toHaveLength(1);
    expect(signals[0]!.sources).toEqual(["session:s1", "session:s2"]);
  });

  it("calls a failure recurring only when it spans two sessions", () => {
    const once = gatherFromAttempts([attempt({ hypothesis: "try X", sessionId: "s1" })]);
    expect(once.filter((s) => s.kind === "recurring_error")).toHaveLength(0);

    const twice = gatherFromAttempts([
      attempt({ hypothesis: "try X", sessionId: "s1" }),
      attempt({ hypothesis: "try X", sessionId: "s2" }),
    ]);
    expect(twice.filter((s) => s.kind === "recurring_error")).toHaveLength(1);
  });

  it("does not treat a success as a recurring error", () => {
    const signals = gatherFromAttempts([
      attempt({ hypothesis: "try X", sessionId: "s1", outcome: "success" }),
      attempt({ hypothesis: "try X", sessionId: "s2", outcome: "success" }),
    ]);
    expect(signals.filter((s) => s.kind === "recurring_error")).toHaveLength(0);
  });
});

describe("phase 1 and 4 are model-free", () => {
  it("orient bounds its digest", () => {
    const index = Array.from({ length: 500 }, (_, i) => entry(`concepts/p${i}.md`, { summary: "x".repeat(80) }));
    const o = orient(index, "schema", "overview");
    expect(o.pageCount).toBe(500);
    expect(o.summary.length).toBeLessThanOrEqual(6100);
    expect(o.summary).toContain("truncated");
  });

  it("rebuildIndex takes each page's first fact line as its summary and drops stale rows", () => {
    const pages = [page("concepts/a.md", "- [stated] alpha holds per request (session:s1)\n")];
    const rebuilt = rebuildIndex(pages, [entry("concepts/gone.md"), entry("concepts/a.md", { summary: "old" })]);
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]!.path).toBe("concepts/a.md");
    expect(rebuilt[0]!.summary).toContain("alpha holds per request");
    expect(rebuilt[0]!.status).toBe("active");
  });

  it("rebuildIndex clips a long summary", () => {
    const pages = [page("concepts/a.md", `- [stated] ${"x".repeat(400)} (session:s1)\n`)];
    expect(rebuildIndex(pages, [], 50)[0]!.summary.length).toBeLessThanOrEqual(50);
  });
});

describe("dropUnknownPages", () => {
  it("keeps only findings whose pages all exist", () => {
    const pages = [page("concepts/a.md", "x"), page("concepts/b.md", "y")];
    const filtered = dropUnknownPages(
      {
        contradictions: [
          { pages: ["concepts/a.md", "concepts/b.md"], claims: ["c"], resolution: "r" },
          { pages: ["concepts/a.md", "concepts/ghost.md"], claims: ["c"], resolution: "r" },
        ],
        superseded: [{ page: "concepts/ghost.md", old: "o", new: "n", source: "s" }],
        merged: [{ from: ["concepts/a.md"], to: "concepts/b.md" }],
        removed: [{ page: "concepts/a.md", line: "l", reason: "r" }],
      },
      pages,
    );
    expect(filtered.contradictions).toHaveLength(1);
    expect(filtered.superseded).toHaveLength(0);
    // a "merge" of one page is not a merge
    expect(filtered.merged).toHaveLength(0);
    expect(filtered.removed).toHaveLength(1);
  });
});
