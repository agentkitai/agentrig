import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileMemoryStore } from "@agentkitai/agentrig-memory";

let root: string;
let store: FileMemoryStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentrig-wiki-"));
  store = new FileMemoryStore({ root, now: () => Date.parse("2026-08-29T00:00:00Z") });
  await store.init();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("FileMemoryStore", () => {
  it("scaffolds the wiki idempotently without clobbering content", async () => {
    await store.appendLog("## [2026-08-29] ingest | session:1");
    await store.init(); // second init must not wipe anything
    const log = await store.read("log.md").catch(() => null);
    expect(log).toBeNull(); // log.md is not a page; read via fs below
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(join(root, "log.md"), "utf8")).toContain("session:1");
    expect((await stat(join(root, "entities"))).isDirectory()).toBe(true);
  });

  it("round-trips a page and the index", async () => {
    await store.write("concepts/retry-policy.md", {
      path: "concepts/retry-policy.md",
      frontmatter: {
        type: "concept",
        slug: "retry-policy",
        aliases: [],
        sources: ["session:1"],
        updated: "2026-08-29",
        confidence: "high",
      },
      body: "- [stated] Retries apply per request (session:1)",
    });
    await store.upsertIndex({
      slug: "retry-policy",
      path: "concepts/retry-policy.md",
      type: "concept",
      status: "active",
      summary: "retries are per request",
    });
    const page = await store.read("concepts/retry-policy.md");
    expect(page!.frontmatter.slug).toBe("retry-policy");
    const index = await store.index();
    expect(index).toHaveLength(1);
    expect(index[0]).toMatchObject({ slug: "retry-policy", status: "active", summary: "retries are per request" });
  });

  it("survives a summary containing a pipe character", async () => {
    await store.upsertIndex({
      slug: "cli",
      path: "entities/cli.md",
      type: "entity",
      status: "active",
      summary: "runs a | b | c pipelines",
    });
    expect((await store.index())[0]!.summary).toBe("runs a | b | c pipelines");
  });

  it("upsert replaces a row instead of duplicating it", async () => {
    const base = { slug: "x", path: "entities/x.md", type: "entity" as const, status: "active" as const };
    await store.upsertIndex({ ...base, summary: "first" });
    await store.upsertIndex({ ...base, summary: "second" });
    const index = await store.index();
    expect(index).toHaveLength(1);
    expect(index[0]!.summary).toBe("second");
  });

  it("reserve claims a slug once; a second claimant is told it exists and is recorded", async () => {
    expect(await store.reserve("auth-module", "session:a", "entity")).toBe("created");
    expect(await store.reserve("auth-module", "session:b", "entity")).toBe("exists");
    const entry = (await store.index()).find((e) => e.slug === "auth-module");
    expect(entry!.status).toBe("planned");
    expect(entry!.claimedBy).toEqual(["session:a", "session:b"]);
    // the second claim must not have overwritten the first claimant's placeholder
    const page = await store.read("entities/auth-module.md");
    expect(page!.body).toContain("session:a");
    expect(page!.body).not.toContain("session:b");
  });

  it("lists every page for search, ignoring non-markdown", async () => {
    await store.write("entities/a.md", {
      path: "entities/a.md",
      frontmatter: { type: "entity", slug: "a", aliases: [], sources: [], updated: "2026-08-29", confidence: "low" },
      body: "- [stated] thing",
    });
    const paths = (await store.pages()).map((p) => p.path).sort();
    expect(paths).toContain("entities/a.md");
    expect(paths).toContain("overview.md");
  });
});
