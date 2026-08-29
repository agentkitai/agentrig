import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "@agentkitai/agentrig-core";
import { FileMemoryStore, FileRawStore, indexInjection, memoryTools } from "@agentkitai/agentrig-memory";

let root: string;
let store: FileMemoryStore;
let raw: FileRawStore;
let ctx: ToolContext;
const at = () => Date.parse("2026-08-29T00:00:00Z");

const byName = (name: string) => {
  const t = memoryTools({ store, raw, sessionId: "s1", now: at }).find((x) => x.name === name);
  if (t === undefined) throw new Error(`no tool ${name}`);
  return t;
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentrig-tools-"));
  store = new FileMemoryStore({ root: join(root, "wiki"), now: at });
  await store.init();
  raw = new FileRawStore({ root, now: at });
  await mkdir(join(root, "raw"), { recursive: true });
  ctx = { cwd: root, sessionId: "s1", emit: () => {}, signal: new AbortController().signal };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("memory tools", () => {
  it("exposes the PLAN §3.4 tool set with sane permission classes", () => {
    const tools = memoryTools({ store, raw, sessionId: "s1" });
    expect(tools.map((t) => t.name).sort()).toEqual([
      "attempt_log",
      "memory_file_analysis",
      "memory_ingest",
      "memory_read",
      "memory_search",
      "memory_write",
    ]);
    expect(tools.find((t) => t.name === "memory_search")!.permission).toBe("read");
    expect(tools.find((t) => t.name === "memory_write")!.permission).toBe("write");
  });

  it("omits the raw-backed tools when no raw store is configured", () => {
    expect(memoryTools({ store }).map((t) => t.name)).not.toContain("attempt_log");
  });

  it("memory_write then memory_search then memory_read round-trips", async () => {
    await byName("memory_write").execute(
      { type: "concept", slug: "retry-policy", body: "- [stated] Retries apply per request (session:s1)" },
      ctx,
    );
    const search = await byName("memory_search").execute({ query: "retries per request" }, ctx);
    expect(search.display).toContain("concepts/retry-policy.md");

    const read = await byName("memory_read").execute({ path: "concepts/retry-policy.md" }, ctx);
    expect(read.display).toContain("slug: retry-policy");
    expect(read.display).toContain("Retries apply per request");
  });

  it("reports a missing page as an error, not an empty success", async () => {
    const r = await byName("memory_read").execute({ path: "concepts/nope.md" }, ctx);
    expect(r.isError).toBe(true);
  });

  it("memory_search says so plainly when nothing matches", async () => {
    const r = await byName("memory_search").execute({ query: "quantum tunnelling" }, ctx);
    expect(r.display).toContain("no memory matches");
    expect(r.isError).toBeUndefined();
  });

  it("memory_file_analysis files into analyses/ with the session as its source", async () => {
    await byName("memory_file_analysis").execute(
      { slug: "why-429", body: "- [inferred] The 429 came from a shared bucket" },
      ctx,
    );
    const page = await store.read("analyses/why-429.md");
    expect(page!.frontmatter.type).toBe("analysis");
    expect(page!.frontmatter.sources).toEqual(["session:s1"]);
  });

  it("attempt_log appends an immutable attempt including failures", async () => {
    await byName("attempt_log").execute(
      { hypothesis: "retry is per batch", actions: "read the code", outcome: "failed", evidence: ["429"] },
      ctx,
    );
    const attempts = await raw.attempts("s1");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ outcome: "failed", hypothesis: "retry is per batch" });
  });

  it("memory_ingest copies a doc into raw/docs and declares its path for permissions", async () => {
    const src = join(root, "adr.md");
    await writeFile(src, "# ADR 12");
    const tool = byName("memory_ingest");
    expect(tool.paths?.({ path: src })).toEqual([src]);
    const r = await tool.execute({ path: src }, ctx);
    expect(r.display).toContain("raw/docs");
  });

  it("rejects a non-kebab-case slug at the schema boundary", () => {
    const parsed = byName("memory_write").inputSchema.safeParse({ type: "concept", slug: "Not Kebab", body: "- [stated] x" });
    expect(parsed.success).toBe(false);
  });
});

describe("indexInjection", () => {
  it("is empty for an empty wiki", async () => {
    expect(await indexInjection(store)).toBe("");
  });

  it("lists active pages and hides planned reservations", async () => {
    await store.upsertIndex({ slug: "a", path: "concepts/a.md", type: "concept", status: "active", summary: "the A thing" });
    await store.upsertIndex({ slug: "b", path: "concepts/b.md", type: "concept", status: "planned", summary: "(reserved)" });
    const injected = await indexInjection(store);
    expect(injected).toContain("concepts/a.md — the A thing");
    expect(injected).not.toContain("concepts/b.md");
  });

  it("degrades to a pointer instead of eating the context window", async () => {
    for (let i = 0; i < 200; i++) {
      await store.upsertIndex({
        slug: `p${i}`,
        path: `concepts/p${i}.md`,
        type: "concept",
        status: "active",
        summary: "x".repeat(80),
      });
    }
    const injected = await indexInjection(store, 1000);
    expect(injected.length).toBeLessThan(1400);
    expect(injected).toMatch(/and \d+ more pages; use memory_search/);
  });
});
