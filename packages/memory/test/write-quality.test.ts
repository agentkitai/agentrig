import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FileMemoryStore, FileRawStore, DistilledFact, factLines, findingCount, ingestSession, isClean, renderReport, runDream, structuralLint, writeQualityLint, type IndexEntry, type WikiPage } from "@agentkitai/agentrig-memory";
import type { ModelProvider } from "@agentkitai/agentrig-core";

function page(slug: string, body: string, type: WikiPage["frontmatter"]["type"] = "concept", aliases: string[] = []): WikiPage {
  return { path: `${type === "source" ? "sources" : "concepts"}/${slug}.md`, body, updatedAt: 0,
    frontmatter: { slug, type, aliases, sources: ["session:s1"], updated: "2026-09-06", confidence: "medium" } };
}
const entry = (p: WikiPage): IndexEntry => ({ path: p.path, slug: p.frontmatter.slug, type: p.frontmatter.type, status: "active", summary: "fixture" });
const roots: string[] = [];
it("reports only the handwritten parent and identifies legacy summary regrowth without rewriting tags", () => {
  expect(writeQualityLint([page("nested", "- Parent claim\n  - Supporting detail\n\t* More detail")]).filter(f => f.kind === "missing-provenance")).toHaveLength(1);
  const legacy = "- [observed] Retries help (session:s1)\n- [inferred] Model synthesis: Retries help (session:s1)";
  expect(writeQualityLint([page("history", legacy, "source")])).toMatchObject([{ kind: "restated-claim", reason: expect.stringContaining("legacy") }]);
  expect(writeQualityLint([page("history", legacy.replace("Retries help (session:s1)\n", "Retries fail (session:s1)\n"), "source")])).toEqual([]);
});
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it.each([
  ["inference-as-fact", "- [inferred] Retry isolation prevents the fault (session:s1)", "- [inferred] Retry isolation may prevent the fault (session:s1)"],
  ["status-noise", "- [observed] CI is green (session:s1)", "- [stated] CI must verify the retry contract (doc:policy)"],
  ["thin-generalization", "- [observed] Retries always succeed (session:s1, session:s1)", "- [observed] Retry succeeded for the fixture input (session:s1)"],
  ["missing-provenance", "- The cache expires per request (session:s1)", "- [stated] The cache expires per request (doc:design)"],
])("flags %s with a matched negative control", (kind, bad, good) => {
  expect(writeQualityLint([page("bad", bad!)]).map(f => f.kind)).toContain(kind);
  expect(writeQualityLint([page("good", good!)])).toEqual([]);
});

it("reports repetition across tags/citations, not distinct facts or source narrative", () => {
  const pages = [page("a", "- [stated] Retries are per request (session:s1)"),
    page("b", "- [observed] Retries are per request (session:s2)"),
    page("c", "- [stated] Retries are per batch (session:s1)"),
    page("history", "- [observed] Retries are per request (session:s1)\n- [observed] CI is green (session:s1)", "source")];
  expect(writeQualityLint(pages)).toMatchObject([{ kind: "restated-claim", page: "concepts/b.md", relatedPage: "concepts/a.md" }]);
  expect(writeQualityLint([...pages].reverse())).toEqual(writeQualityLint(pages));
  expect(writeQualityLint([page("a", "- [stated] Keep `(session:a)` literal (doc:a)"), page("b", "- [stated] Keep `(session:b)` literal (doc:b)")])).toEqual([]);
});

it("routes only explicit leading subject links to one existing page, including aliases", () => {
  const auth = page("auth", "", "concept", ["login"]);
  expect(writeQualityLint([auth, page("cache", "- [stated] [[login]] validates credentials (doc:auth)")])).toMatchObject([
    { kind: "subject-routing", page: "concepts/cache.md", relatedPage: "concepts/auth.md" },
  ]);
  for (const text of ["[[cache]] stores entries", "Uses [[login]] for auth", "[[missing]] validates inputs"]) {
    expect(writeQualityLint([auth, page("cache", `- [stated] ${text} (doc:auth)`)])).toEqual([]);
  }
  expect(writeQualityLint([auth, page("other", "", "concept", ["login"]), page("cache", "- [stated] [[login]] validates credentials (doc:auth)")])).toEqual([]);
});

it("ignores fenced examples, reservations and quoted/inline-code wording", () => {
  const body = "```md\n- [inferred] Definitely true\n```\n~~~md\n- no tag\n~~~\n" +
    "- [inferred] Reserved by session:s1; content pending ingest.\n" +
    '- [observed] The command contains `always` and the literal "CI is green" (session:s1)';
  expect(writeQualityLint([page("examples", body)])).toEqual([]);
  const ac = new AbortController(); ac.abort();
  expect(() => writeQualityLint([], ac.signal)).toThrow();
});

it("preserves legacy report compatibility and makes quality visible to clean/count/render", async () => {
  const p = page("retry", "- [inferred] Retries prevent faults (session:s1)");
  const structural = await structuralLint([p], [entry(p)]);
  expect(isClean(structural)).toBe(false);
  const report = { contradictions: [], superseded: [], orphans: [], missingPages: [], merged: [], removed: [], promoted: [], pinsAffected: [] };
  expect(findingCount(report, structural)).toBe(1);
  expect(renderReport(report, { structural })).toContain("[inference-as-fact]");
  expect(renderReport(report, { structural })).toContain("semantic truth not assessed");
  const { writeQuality: _quality, ...legacy } = structural;
  expect(isClean(legacy)).toBe(true); expect(findingCount(report, legacy)).toBe(0);
  const skipped = { ...report, skippedMerges: [{ from: "concepts/a.md", into: "concepts/b.md", reason: "opaque metadata retained" }] };
  expect(renderReport(skipped)).toContain("concepts/a.md → concepts/b.md: opaque metadata retained");
  expect(findingCount(skipped)).toBe(1);
});

it("round-trips ingest provenance without calling model summaries observations or changing raw logs", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrig-quality-")); roots.push(root);
  const store = new FileMemoryStore({ root: join(root, "wiki") }); await store.init();
  const logPath = join(root, "session.jsonl");
  const raw = JSON.stringify({ type: "session.start", task: "test provenance", cwd: "/fixture" }) + "\n";
  await writeFile(logPath, raw);
  const provider: ModelProvider = { id: "fixture", model: "fixture", capabilities: { tools: false, parallelTools: false, caching: false, contextWindow: 10000 },
    async *stream() {
      yield { type: "text_delta", text: JSON.stringify({ summary: "The model concluded retries help", facts: [
        { pageType: "concept", slug: "retry", tag: "stated", text: "Retries are per request" },
        { pageType: "concept", slug: "retry", tag: "observed", text: "The fixture succeeded" },
        { pageType: "concept", slug: "retry", tag: "inferred", text: "Retries may help" },
      ] }) };
      yield { type: "usage", usage: { input: 1, output: 1 } }; yield { type: "stop", reason: "end_turn" };
    } };
  await ingestSession({ store, sessionId: "s1", logPath, provider });
  expect(factLines((await store.read("concepts/retry.md"))!.body).map(f => f.tag)).toEqual(["stated", "observed", "inferred"]);
  const summary = factLines((await store.read("sources/session-s1.md"))!.body);
  expect(summary).toMatchObject([{ tag: "inferred", text: "Model synthesis: The model concluded retries help (session:s1)" }]);
  expect(await readFile(logPath, "utf8")).toBe(raw);
  expect(() => DistilledFact.parse({ pageType: "concept", slug: "x", text: "x", tag: "verified" })).toThrow();
});

it("runs actual model-free dream with quality findings without rewriting input or claim bodies", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentrig-quality-dream-")); roots.push(root);
  const store = new FileMemoryStore({ root: join(root, "wiki") }); await store.init();
  await mkdir(join(root, "raw", "sessions"), { recursive: true });
  const p = page("retry", "- [inferred] Retries prevent faults (session:s1)");
  await store.write(p.path, p); await store.upsertIndex(entry(p));
  const before = await readFile(join(store.root, p.path), "utf8");
  const result = await runDream({ wiki: store, raw: new FileRawStore({ root }), structuralOnly: true });
  try {
    expect(result.structural.writeQuality?.map(f => f.kind)).toEqual(["inference-as-fact"]);
    expect(result.auxiliary?.calls).toEqual([]);
    expect(await readFile(join(store.root, p.path), "utf8")).toBe(before);
    expect((await new FileMemoryStore({ root: result.outputRoot }).read(p.path))?.body).toBe((await store.read(p.path))?.body);
  } finally { await result.workspace.dispose(); }
});
