import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelEvent, ModelProvider } from "@agentkitai/agentrig-core";
import {
  FileMemoryStore,
  FileRawStore,
  addPin,
  extractJson,
  indexInjection,
  ingestSession,
  memoryTools,
  parsePage,
  planCoverage,
  readPins,
  serializePage,
  tokenize,
  indexTokens,
} from "@agentkitai/agentrig-memory";
import type { Attempt, Pin } from "@agentkitai/agentrig-memory";

let root: string;
let store: FileMemoryStore;
const at = () => Date.parse("2026-08-29T00:00:00Z");

const reply = (obj: unknown): ModelProvider => ({
  id: "fake",
  model: "f",
  capabilities: { tools: false, parallelTools: false, caching: false, contextWindow: 100_000 },
  async *stream(): AsyncIterable<ModelEvent> {
    yield { type: "text_delta", text: typeof obj === "string" ? obj : JSON.stringify(obj) };
    yield { type: "stop", reason: "end_turn" };
  },
});

async function writeLog(id: string, events: unknown[]): Promise<string> {
  const path = join(root, "raw", "sessions", `${id}.jsonl`);
  await mkdir(join(root, "raw", "sessions"), { recursive: true });
  await writeFile(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return path;
}

const baseEvents = [
  { type: "session.start", task: "t", cwd: "/w" },
  { type: "tool.result", ok: true, display: "did a thing" },
];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentrig-regr-"));
  store = new FileMemoryStore({ root: join(root, "wiki"), now: at });
  await store.init();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("index.md is not a lost-update race (C1)", () => {
  it("keeps every row when many upserts run concurrently", async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.upsertIndex({
          slug: `p${i}`,
          path: `concepts/p${i}.md`,
          type: "concept",
          status: "active",
          summary: `page ${i}`,
        }),
      ),
    );
    expect(await store.index()).toHaveLength(10);
  });

  it("keeps every claim when many reservations race for different slugs", async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.reserve(`slug-${i}`, `session:${i}`, "entity")),
    );
    expect(outcomes.every((o) => o === "created")).toBe(true);
    expect(await store.index()).toHaveLength(10);
  });

  it("two concurrent ingests both end up in the catalog", async () => {
    const l1 = await writeLog("s1", [{ type: "session.start", task: "one", cwd: "/w" }]);
    const l2 = await writeLog("s2", [{ type: "session.start", task: "two", cwd: "/w" }]);
    const facts = (slug: string) => ({
      nothingDurable: false,
      summary: `did ${slug}`,
      facts: [{ pageType: "concept", slug, tag: "stated", text: `about ${slug}` }],
    });
    await Promise.all([
      ingestSession({ store, provider: reply(facts("alpha-thing")), sessionId: "s1", logPath: l1, now: at }),
      ingestSession({ store, provider: reply(facts("beta-thing")), sessionId: "s2", logPath: l2, now: at }),
    ]);
    const slugs = (await store.index()).map((e) => e.slug).sort();
    expect(slugs).toEqual(["alpha-thing", "beta-thing", "session-s1", "session-s2"]);
  });

  it("re-adopts a page whose index row went missing (M7)", async () => {
    await store.reserve("orphan", "session:a", "entity");
    await store.writeIndex([]); // simulate a crash between page create and upsert
    expect(await store.reserve("orphan", "session:b", "entity")).toBe("exists");
    expect((await store.index()).map((e) => e.slug)).toContain("orphan");
  });
});

describe("the wiki root is a confinement boundary (C10)", () => {
  it("refuses to read outside the wiki, through the store and the tool", async () => {
    await writeFile(join(root, "outside.md"), serializePage(
      { type: "concept", slug: "secret", aliases: [], sources: [], updated: "2026-08-29", confidence: "high" },
      "- [stated] SECRET",
    ));
    await expect(store.read("../outside.md")).rejects.toThrow(/escapes the wiki root/);

    const read = memoryTools({ store }).find((t) => t.name === "memory_read")!;
    const r = await read.execute({ path: "../outside.md" }, {
      cwd: root,
      sessionId: "s",
      emit: () => {},
      signal: new AbortController().signal,
    });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.output ?? "")).not.toContain("SECRET");
  });
});

describe("ingest keeps its coverage promise (C2, C3)", () => {
  it("writes source-typed facts instead of counting and discarding them", async () => {
    const logPath = await writeLog("s1", baseEvents);
    const result = await ingestSession({
      store,
      provider: reply({
        nothingDurable: false,
        summary: "",
        facts: [{ pageType: "source", slug: "session-s1", tag: "observed", text: "the parser was rewritten" }],
      }),
      sessionId: "s1",
      logPath,
      now: at,
    });
    expect(result.factCount).toBe(1);
    expect((await store.read("sources/session-s1.md"))!.body).toContain("the parser was rewritten");
  });

  it("refuses to call an unexplained empty response 'covered'", async () => {
    const logPath = await writeLog("s1", baseEvents);
    // the most likely degenerate/truncated reply: valid JSON, no facts, no explicit close
    await expect(
      ingestSession({ store, provider: reply({}), sessionId: "s1", logPath, now: at }),
    ).rejects.toThrow(/without explicitly reporting nothingDurable/);
  });

  it("accepts an explicit nothingDurable as real coverage", async () => {
    const logPath = await writeLog("s1", baseEvents);
    const r = await ingestSession({
      store,
      provider: reply({ nothingDurable: true, summary: "", facts: [] }),
      sessionId: "s1",
      logPath,
      now: at,
    });
    expect(r.coverage.every((c) => c.outcome === "nothing-durable")).toBe(true);
  });

  it("never discards a summary the model did provide", async () => {
    const logPath = await writeLog("s1", baseEvents);
    const r = await ingestSession({
      store,
      provider: reply({ nothingDurable: true, summary: "explored the parser but kept nothing", facts: [] }),
      sessionId: "s1",
      logPath,
      now: at,
    });
    expect(r.factCount).toBe(0);
    const body = (await store.read("sources/session-s1.md"))!.body;
    expect(body).toContain("explored the parser but kept nothing");
    expect(body).not.toContain("no durable findings");
  });
});

describe("unique content is never deleted (C4)", () => {
  it("merges a diverged re-ingest instead of overwriting the source page", async () => {
    const logPath = await writeLog("s1", baseEvents);
    await ingestSession({
      store,
      provider: reply({ nothingDurable: false, summary: "IRREPLACEABLE narrative about the parser", facts: [] }),
      sessionId: "s1",
      logPath,
      now: at,
    });
    // a different (not prefix-superset) transcript for the same session
    await writeLog("s1", [{ type: "session.start", task: "something else", cwd: "/w" }]);
    const second = await ingestSession({
      store,
      provider: reply({ nothingDurable: true, summary: "", facts: [] }),
      sessionId: "s1",
      logPath,
      now: at,
    });

    expect(second.supersededPrevious).toBe(false);
    const body = (await store.read("sources/session-s1.md"))!.body;
    expect(body).toContain("IRREPLACEABLE narrative about the parser");
    expect((await store.index()).find((e) => e.slug === "session-s1")!.summary).toContain("IRREPLACEABLE");
  });
});

describe("pins are re-checked wherever a page is regenerated (C12)", () => {
  const pin: Pin = {
    page: "concepts/retry-policy.md",
    kind: "correction",
    claim: "Retries apply per request, not per batch",
    anchor: "",
    provenance: "human",
    created: "2026-08-29",
    status: "active",
  };

  it("memory_write surfaces a pin its rewrite just broke", async () => {
    const write = memoryTools({ store }).find((t) => t.name === "memory_write")!;
    const ctx = { cwd: root, sessionId: "s", emit: () => {}, signal: new AbortController().signal };
    await write.execute(
      { type: "concept", slug: "retry-policy", body: "- [stated] Retries apply per request, not per batch" },
      ctx,
    );
    await addPin(store.root, pin);

    const r = await write.execute(
      { type: "concept", slug: "retry-policy", body: "- [stated] Retries do NOT apply per request; they are batched",
        if_version: (await store.read("concepts/retry-policy.md"))!.version },
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.display).toContain("pinned human correction");
    expect((await readPins(store.root))[0]!.status).toBe("conflict");
  });

  it("ingest reports pin conflicts on pages it touched", async () => {
    const logPath = await writeLog("s1", baseEvents);
    await store.write("concepts/retry-policy.md", {
      path: "concepts/retry-policy.md",
      frontmatter: { type: "concept", slug: "retry-policy", aliases: [], sources: [], updated: "2026-08-29", confidence: "high" },
      body: "- [stated] Retries do NOT apply per request",
    });
    await addPin(store.root, pin);
    const r = await ingestSession({
      store,
      provider: reply({
        nothingDurable: false,
        summary: "touched retries",
        facts: [{ pageType: "concept", slug: "retry-policy", tag: "stated", text: "batching is the default" }],
      }),
      sessionId: "s1",
      logPath,
      now: at,
    });
    expect(r.pinConflicts).toHaveLength(1);
    expect(r.pinConflicts[0]!.claim).toBe(pin.claim);
  });
});

describe("raw/ is immutable in practice (C8, C9)", () => {
  it("concurrent addDoc of the same name never overwrites", async () => {
    const raw = new FileRawStore({ root, now: at });
    const a = join(root, "a.md");
    await writeFile(a, "one");
    const [d1, d2] = await Promise.all([raw.addDoc(a), raw.addDoc(a)]);
    expect(d1.path).not.toBe(d2.path);
    expect((await raw.docs()).length).toBe(2);
  });

  it("one torn attempt file is reported, not thrown and not silently swallowed", async () => {
    const raw = new FileRawStore({ root, now: at });
    const attempt: Attempt = {
      id: "good",
      sessionId: "s1",
      ts: 1,
      hypothesis: "h",
      actions: "a",
      outcome: "success",
      evidence: [],
    };
    await raw.addAttempt(attempt);
    await writeFile(join(root, "raw", "attempts", "torn.json"), '{"id":"torn","sessionId":');

    await expect(raw.attempts("s1")).resolves.toHaveLength(1); // no throw
    const { attempts, corrupt } = await raw.readAttempts("s1");
    expect(attempts).toHaveLength(1);
    expect(corrupt).toHaveLength(1);
    expect(corrupt[0]).toContain("torn.json");
  });
});

describe("assorted robustness (M-series)", () => {
  it("extractJson survives a braced preamble (M10)", () => {
    expect(extractJson('Note: use {} for defaults. {"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });

  it("coverage spans report original transcript line numbers (M11)", () => {
    const spans = planCoverage("a\n\n\nb", 1000);
    expect(spans[0]!.from).toBe(0);
    expect(spans[0]!.to).toBe(3); // 'b' is line 3 in the original, not line 1
  });

  it("frontmatter list items survive a comma, and unknown keys survive a rewrite (M4)", () => {
    const fm = {
      type: "entity" as const,
      slug: "x",
      aliases: ["Acme, Inc", "auth"],
      sources: [],
      updated: "2026-08-29",
      confidence: "high" as const,
    };
    const text = serializePage(fm, "- [stated] body", { owner: "amit" });
    const parsed = parsePage(text);
    expect(parsed.frontmatter.aliases).toEqual(["Acme, Inc", "auth"]);
    expect(parsed.extra).toEqual({ owner: "amit" });
    // round-trips again with the extra key preserved
    expect(parsePage(serializePage(parsed.frontmatter, parsed.body, parsed.extra)).extra).toEqual({ owner: "amit" });
  });

  it("a hyphenated slug is findable by its parts (M2)", () => {
    expect(tokenize("auth-module")).toEqual(["auth-module"]); // query side stays exact
    expect(indexTokens("auth-module")).toContain("auth"); // document side expands
  });

  it("the capture marker is neither searchable nor quotable (M3)", async () => {
    const logPath = await writeLog("s1", baseEvents);
    await ingestSession({
      store,
      provider: reply({ nothingDurable: false, summary: "did a thing", facts: [] }),
      sessionId: "s1",
      logPath,
      now: at,
    });
    expect(await store.search("capture prefix")).toEqual([]);
    const hits = await store.search("did a thing");
    expect(hits[0]!.snippet).not.toContain("capture:prefix");
  });

  it("indexInjection's cap bounds the whole injection, header included (M8)", async () => {
    for (let i = 0; i < 100; i++) {
      await store.upsertIndex({
        slug: `p${i}`,
        path: `concepts/p${i}.md`,
        type: "concept",
        status: "active",
        summary: "x".repeat(80),
      });
    }
    expect((await indexInjection(store, 1000)).length).toBeLessThanOrEqual(1000);
  });
});
