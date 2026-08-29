import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelEvent, ModelProvider, ModelRequest } from "@agentkitai/agentrig-core";
import {
  FileMemoryStore,
  FileRawStore,
  applyDream,
  copyWiki,
  fingerprint,
  findingCount,
  lastDreamAt,
  renderReport,
  runDream,
  serializePage,
  WikiDreamer,
} from "@agentkitai/agentrig-memory";

/** Replies with one scripted JSON body. No network anywhere in this file. */
function scripted(body: unknown): ModelProvider & { calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  return {
    id: "fake",
    model: "fake-1",
    capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 },
    calls,
    async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
      calls.push(req);
      yield { type: "text_delta", text: JSON.stringify(body) };
      yield { type: "stop", reason: "end_turn" };
    },
  };
}

const exploding: ModelProvider = {
  id: "fake",
  model: "fake-1",
  capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 },
  // eslint-disable-next-line require-yield
  async *stream(): AsyncIterable<ModelEvent> {
    throw new Error("the model must not be called");
  },
};

let root: string;
let wikiRoot: string;
let store: FileMemoryStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentrig-dream-"));
  wikiRoot = join(root, "wiki");
  store = new FileMemoryStore({ root: wikiRoot });
  await store.init();
  await mkdir(join(root, "raw", "sessions"), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function page(path: string, body: string, extra: Record<string, unknown> = {}): Promise<void> {
  const slug = path.replace(/^.*\//, "").replace(/\.md$/, "");
  await store.write(path, {
    path,
    frontmatter: {
      type: "concept",
      slug,
      aliases: [],
      sources: ["session:s1"],
      updated: "2026-08-01",
      confidence: "high",
      ...extra,
    } as never,
    body,
  });
}

function dreamOpts(provider: ModelProvider, extra: Record<string, unknown> = {}) {
  return {
    wiki: store,
    raw: new FileRawStore({ root }),
    provider,
    now: () => 1_700_000_000_000,
    ...extra,
  };
}

describe("dreams never modify their input (PLAN §1.5)", () => {
  it("leaves the input wiki byte-identical, even while rewriting the copy", async () => {
    await page("concepts/a.md", "- [stated] alpha holds (session:s1)\n");
    await page("concepts/b.md", "- [stated] beta holds (session:s2)\n");
    const before = await fingerprint(wikiRoot);

    const result = await runDream(
      dreamOpts(
        scripted({
          contradictions: [{ pages: ["concepts/a.md", "concepts/b.md"], claims: ["alpha", "beta"], resolution: "keep a" }],
          superseded: [],
          merged: [{ from: ["concepts/a.md", "concepts/b.md"], to: "concepts/a.md" }],
          removed: [{ page: "concepts/a.md", line: "alpha holds", reason: "duplicated" }],
        }),
      ),
    );

    expect(await fingerprint(wikiRoot)).toBe(before);
    // and the dream really did write somewhere
    expect(result.outputRoot).not.toBe(wikiRoot);
    expect(await fingerprint(result.outputRoot)).not.toBe(before);
    await result.workspace.dispose();
  });

  it("the report describes findings, and the output wiki exists to be inspected", async () => {
    await page("concepts/a.md", "- [stated] alpha (session:s1)\n");
    const result = await runDream(
      dreamOpts(
        scripted({
          contradictions: [],
          superseded: [
            { page: "concepts/a.md", old: "- [stated] alpha (session:s1)", new: "alpha prime", source: "session:s9" },
          ],
          merged: [],
          removed: [],
        }),
      ),
    );
    expect(result.report.superseded).toHaveLength(1);
    // the annotation is IN the output page, not merely in the report
    const body = (await readFile(join(result.outputRoot, "concepts", "a.md"), "utf8"));
    expect(body).toContain("superseded by \"alpha prime\" (session:s9)");
    expect(await readFile(join(result.outputRoot, "index.md"), "utf8")).toContain("concepts/a.md");
    await result.workspace.dispose();
  });

  it("a dream records itself in the copy's log, not the original's", async () => {
    await page("concepts/a.md", "- [stated] alpha (session:s1)\n");
    const originalLog = await readFile(join(wikiRoot, "log.md"), "utf8");
    const result = await runDream(dreamOpts(exploding, { structuralOnly: true }));

    expect(await readFile(join(result.outputRoot, "log.md"), "utf8")).toContain("| dream |");
    expect(await readFile(join(wikiRoot, "log.md"), "utf8")).toBe(originalLog);
    await result.workspace.dispose();
  });
});

describe("structuralOnly costs nothing", () => {
  it("never calls the model", async () => {
    await page("concepts/a.md", "- [stated] alpha (session:s1)\n");
    // `exploding` throws if stream() is entered at all
    const result = await runDream(dreamOpts(exploding, { structuralOnly: true }));
    expect(result.report.contradictions).toHaveLength(0);
    await result.workspace.dispose();
  });

  it("an empty wiki does not call the model either", async () => {
    const result = await runDream(dreamOpts(exploding));
    expect(result.report.orphans).toHaveLength(0);
    await result.workspace.dispose();
  });
});

describe("consolidation findings are filtered against reality", () => {
  it("drops findings naming pages the wiki does not have", async () => {
    await page("concepts/a.md", "- [stated] alpha (session:s1)\n");
    const result = await runDream(
      dreamOpts(
        scripted({
          contradictions: [{ pages: ["concepts/a.md", "concepts/ghost.md"], claims: ["x"], resolution: "y" }],
          superseded: [{ page: "concepts/ghost.md", old: "a", new: "b", source: "s" }],
          merged: [{ from: ["concepts/ghost.md", "concepts/a.md"], to: "concepts/a.md" }],
          removed: [{ page: "concepts/a.md", line: "- [stated] alpha (session:s1)", reason: "dup" }],
        }),
      ),
    );
    // only the finding that names a real page survives
    expect(result.report.contradictions).toHaveLength(0);
    expect(result.report.superseded).toHaveLength(0);
    expect(result.report.merged).toHaveLength(0);
    expect(result.report.removed).toHaveLength(1);
    await result.workspace.dispose();
  });

  it("a model that answers with garbage yields an empty consolidation, not a crash", async () => {
    await page("concepts/a.md", "- [stated] alpha (session:s1)\n");
    const result = await runDream(dreamOpts(scripted("not json at all")));
    expect(result.report.contradictions).toHaveLength(0);
    await result.workspace.dispose();
  });
});

describe("applyDream", () => {
  it("swaps the dreamt wiki in and keeps the previous one beside it", async () => {
    await page("concepts/a.md", "- [stated] original (session:s1)\n");
    const ws = await copyWiki(wikiRoot);
    await writeFile(join(ws.outputRoot, "concepts", "a.md"), serializePage(
      { type: "concept", slug: "a", aliases: [], sources: ["session:s1"], updated: "2026-08-02", confidence: "high" },
      "- [stated] dreamt (session:s1)\n",
    ), "utf8");

    const backup = await applyDream(wikiRoot, ws.outputRoot, "stamp1");
    expect(await readFile(join(wikiRoot, "concepts", "a.md"), "utf8")).toContain("dreamt");
    expect(await readFile(join(backup, "concepts", "a.md"), "utf8")).toContain("original");
    await ws.dispose();
    await rm(backup, { recursive: true, force: true });
  });

  it("refuses to apply a wiki onto itself", async () => {
    await expect(applyDream(wikiRoot, wikiRoot, "s")).rejects.toThrow(/must write to a copy/);
  });

  it("refuses to clobber an existing backup", async () => {
    const ws = await copyWiki(wikiRoot);
    const backup = await applyDream(wikiRoot, ws.outputRoot, "same");
    const ws2 = await copyWiki(wikiRoot);
    await expect(applyDream(wikiRoot, ws2.outputRoot, "same")).rejects.toThrow(/refusing to overwrite a backup/);
    await ws.dispose();
    await ws2.dispose();
    await rm(backup, { recursive: true, force: true });
  });
});

describe("last-dream marker", () => {
  it("is written into BOTH the dreamt wiki and the live one", async () => {
    // The stamp answers "when was a dream last run", not "last applied". Writing it only into
    // the copy meant review mode never advanced it, so a scheduled trigger stayed permanently
    // due and re-dreamt on every session end — spending tokens and leaking a copy each time.
    await page("concepts/a.md", "- [stated] alpha (session:s1)\n");
    const result = await runDream(dreamOpts(exploding, { structuralOnly: true }));
    expect(await lastDreamAt(result.outputRoot)).toBe(1_700_000_000_000);
    expect(await lastDreamAt(wikiRoot)).toBe(1_700_000_000_000);
    await result.workspace.dispose();
  });

  it("the stamp is metadata, so it does not count as modifying the input's content", async () => {
    await page("concepts/a.md", "- [stated] alpha (session:s1)\n");
    const before = await fingerprint(wikiRoot);
    const result = await runDream(dreamOpts(exploding, { structuralOnly: true }));
    // §1.5 is about wiki CONTENT; the dream's own bookkeeping is excluded from the fingerprint
    expect(await fingerprint(wikiRoot)).toBe(before);
    await result.workspace.dispose();
  });
});

describe("WikiDreamer implements the narrow PLAN §3.7 contract", () => {
  it("returns just outputRoot and report", async () => {
    await page("concepts/a.md", "- [stated] alpha (session:s1)\n");
    const dreamer = new WikiDreamer({ structuralOnly: true });
    const result = await dreamer.dream({ wiki: store, raw: new FileRawStore({ root }), provider: exploding });
    expect(Object.keys(result).sort()).toEqual(["outputRoot", "report"]);
    await rm(result.outputRoot, { recursive: true, force: true });
  });
});

describe("renderReport", () => {
  it("says plainly that the wiki was not touched in review mode", () => {
    const text = renderReport(
      { contradictions: [], superseded: [], orphans: [], missingPages: [], merged: [], removed: [], promoted: [], pinsAffected: [] },
      { outputRoot: "/tmp/x", applied: false },
    );
    expect(text).toContain("Not applied");
    expect(text).toContain("your wiki is untouched");
  });

  it("reports a clean wiki as clean rather than as an empty document", () => {
    const text = renderReport({
      contradictions: [], superseded: [], orphans: [], missingPages: [], merged: [], removed: [], promoted: [], pinsAffected: [],
    });
    expect(text).toContain("Nothing to report");
  });

  it("counts findings so a caller can pick an exit code", () => {
    const report = {
      contradictions: [{ pages: ["a"], claims: ["c"], resolution: "r" }],
      superseded: [], orphans: ["b.md"], missingPages: [], merged: [], removed: [],
      promoted: [], pinsAffected: [{ pin: "p", status: "kept" as const }],
    };
    // a kept pin is not a finding
    expect(findingCount(report)).toBe(2);
  });
});
