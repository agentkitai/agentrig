import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileMemoryStore, FileRawStore, factLines, parsePage, serializePage, type Attempt, type PageFrontmatter } from "@agentkitai/agentrig-memory";
import { applyConsolidation } from "../src/dream/apply.js";

vi.mock("node:crypto", async original => {
  const actual = await original<typeof import("node:crypto")>();
  return { ...actual, randomBytes: vi.fn(actual.randomBytes) };
});

let root: string;
const fm: PageFrontmatter = { type: "entity", slug: "x", aliases: [], sources: [], updated: "2026-09-05", confidence: "high" };
const metadata = '# human context\nowner: "Team: A"\ncustom:\n  type: not-a-page-type\n  tags: [one, two]\nnotes: |\n  keep this: exactly\n  and this';
const fact = '- [stated] First line\n  continued text\n  (session:s1, doc:d1)';
const empty = { contradictions: [], superseded: [], merged: [], removed: [] };
const attempt = (id: string, sessionId = "s1"): Attempt => ({ id, sessionId, ts: 1, hypothesis: id, actions: "test", outcome: "success", evidence: [] });
const limits = () => ({ signal: new AbortController().signal, maxEntries: 1, maxFileBytes: 1024, maxTotalBytes: 1024 });
beforeEach(async () => { vi.mocked(crypto.randomBytes).mockReset(); root = await mkdtemp(join(tmpdir(), "agentrig-persistence-")); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe("lossless wiki persistence", () => {
  async function setup() {
    const store = new FileMemoryStore({ root: join(root, "wiki") });
    await store.init();
    await store.write("entities/x.md", { path: "entities/x.md", frontmatter: fm, body: fact, extraFrontmatter: metadata });
    return store;
  }

  it("retains unknown scalar/block metadata without interpreting nested schema keys", () => {
    const parsed = parsePage(serializePage(fm, fact, {}, metadata));
    expect(parsed.frontmatter).toEqual(fm);
    expect(parsed.extraFrontmatter).toBe(metadata);
    expect(serializePage(parsed.frontmatter, parsed.body, {}, parsed.extraFrontmatter)).toContain(metadata);
    const quoted = { ...fm, aliases: ['a "quoted", name', 'C:\\folder', ' spaced '] };
    expect(parsePage(serializePage(quoted, fact)).frontmatter).toEqual(quoted);
    expect(parsePage(serializePage(fm, fact).replace("slug: x", "  slug: x")).frontmatter).toEqual(fm);
  });

  it("preserves metadata even when update and CAS callers only return known fields", async () => {
    const store = await setup();
    await store.update("entities/x.md", current => ({ path: current!.path, frontmatter: current!.frontmatter, body: `${current!.body}\n\nupdated` }));
    const current = (await store.read("entities/x.md"))!;
    expect(current.extraFrontmatter).toBe(metadata);
    expect(await store.compareAndSwap(current.path, { path: current.path, frontmatter: fm, body: fact }, current.version!)).toMatchObject({ ok: true });
    expect((await store.read(current.path))!.extraFrontmatter).toBe(metadata);
    await store.update(current.path, page => ({ ...page!, extraFrontmatter: "" }));
    expect((await store.read(current.path))!.extraFrontmatter).toBe("");
  });

  it("counts opaque metadata against write bounds and preserves the target on failure", async () => {
    const store = await setup();
    const current = (await store.read("entities/x.md"))!;
    const size = Buffer.byteLength(serializePage(fm, fact, {}, metadata));
    await expect(store.update(current.path, p => ({ ...p!, body: `${p!.body}${"x".repeat(size)}` }), { maxFileBytes: size + 5 })).rejects.toThrow(/limit/);
    expect((await store.read(current.path))!.version).toBe(current.version);
  });

  it("extracts all continuation text/references but not fenced example facts", () => {
    expect(factLines(`${fact}\n\n\`\`\`md\n- [observed] example (session:fake)\n\`\`\``)).toEqual([
      { tag: "stated", text: "First line\n  continued text\n  (session:s1, doc:d1)", refs: ["session:s1", "doc:d1"] },
    ]);
    expect(factLines("- [inferred] Reserved by ingest; content pending ingest.\ncontinued bookkeeping")).toEqual([]);
  });

  it("refuses partial multiline deletion; whole-fact deletion preserves unknown metadata", async () => {
    const store = await setup();
    const partial = await applyConsolidation(store, { ...empty, removed: [{ page: "entities/x.md", line: "First line", reason: "duplicate" }] }, { today: fm.updated });
    expect(partial.removedLines).toEqual([]);
    expect(partial.unmatchedRemovals).toHaveLength(1);
    expect((await store.read("entities/x.md"))!.body.trim()).toBe(fact);
    const complete = await applyConsolidation(store, { ...empty, removed: [{ page: "entities/x.md", line: fact, reason: "duplicate" }] }, { today: fm.updated });
    expect(complete.removedLines).toHaveLength(1);
    const result = (await store.read("entities/x.md"))!;
    expect(result.body.trim()).toBe("");
    expect(result.extraFrontmatter).toBe(metadata);
  });

  it("annotates a full multiline fact and retains metadata-bearing merge sources", async () => {
    const store = await setup();
    await store.write("entities/y.md", { path: "entities/y.md", frontmatter: { ...fm, slug: "y" }, body: "- [observed] target" });
    const result = await applyConsolidation(store, { ...empty,
      superseded: [{ page: "entities/x.md", old: fact, new: "replacement", source: "session:s2" }],
      merged: [{ from: ["entities/x.md"], to: "entities/y.md" }],
    }, { today: fm.updated });
    expect(result.supersededMarked).toHaveLength(1);
    expect(result.mergedPages).toEqual([]);
    const source = (await store.read("entities/x.md"))!;
    expect(source.body).toContain(`${fact} — superseded`);
    expect(source.extraFrontmatter).toBe(metadata);
  });
});

describe("scoped immutable attempts", () => {
  it("rebuilds legacy history with a separate budget, then reads only the requested session", async () => {
    const raw = new FileRawStore({ root });
    await raw.addAttempt(attempt("wanted"));
    for (let i = 0; i < 8; i++) await raw.addAttempt(attempt(`other${i}`, "other"));
    const before = await readFile(join(root, "raw/attempts/wanted.json"), "utf8");
    expect((await raw.readAttempts("s1", limits())).attempts.map(a => a.id)).toEqual(["wanted"]);
    expect(await readFile(join(root, "raw/attempts/wanted.json"), "utf8")).toBe(before);
    await expect(raw.readAttempts("other", limits())).rejects.toThrow(/entry limit/);
    expect((await new FileRawStore({ root }).readAttempts("s1", limits())).attempts).toHaveLength(1);
  });

  it("invalidates after new writers and serializes concurrent immutable appends", async () => {
    const raw = new FileRawStore({ root });
    expect(await raw.readAttempts("s1", limits())).toEqual({ attempts: [], corrupt: [] });
    await Promise.all([raw.addAttempt(attempt("a")), new FileRawStore({ root }).addAttempt(attempt("b"))]);
    expect((await raw.readAttempts("s1", { ...limits(), maxEntries: 2 })).attempts.map(a => a.id).sort()).toEqual(["a", "b"]);
    await expect(raw.addAttempt(attempt("a"))).rejects.toThrow(/immutable/);
    await expect(raw.addAttempt(attempt("../escape"))).rejects.toThrow();
  });

  it("bounds explicit rebuilds, does not rewrite raw, and recovers a corrupt cache", async () => {
    const raw = new FileRawStore({ root });
    await raw.addAttempt(attempt("a"));
    await raw.addAttempt(attempt("b", "other"));
    await expect(raw.rebuildAttemptIndex(limits())).rejects.toThrow(/entry limit/);
    await raw.rebuildAttemptIndex({ ...limits(), maxEntries: 2 });
    await writeFile(join(root, "attempt-index.json"), "broken cache");
    expect((await raw.readAttempts("s1", limits())).attempts.map(a => a.id)).toEqual(["a"]);
    expect(JSON.parse(await readFile(join(root, "raw/attempts/a.json"), "utf8"))).toEqual(attempt("a"));
  });

  it("keeps corrupt legacy entries visible for every scoped query", async () => {
    const raw = new FileRawStore({ root });
    await mkdir(join(root, "raw/attempts"), { recursive: true });
    await writeFile(join(root, "raw/attempts/broken.json"), "{");
    const result = await raw.readAttempts("s1", limits());
    expect(result.attempts).toEqual([]);
    expect(result.corrupt).toEqual([join(root, "raw/attempts/broken.json")]);
  });

  it("refuses oversized new records before claiming an id and tolerates oversized legacy records", async () => {
    const raw = new FileRawStore({ root });
    const large = { ...attempt("large", "other"), evidence: ["x".repeat(70 * 1024)] };
    await expect(raw.addAttempt(large)).rejects.toThrow(/64 KiB/);
    await expect(readFile(join(root, "raw/attempts/large.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await raw.addAttempt(attempt("small"));
    const legacy = join(root, "raw/attempts/large.json");
    const original = JSON.stringify(large);
    await writeFile(legacy, original);
    expect(await raw.readAttempts("s1", limits())).toMatchObject({ attempts: [{ id: "small" }], corrupt: [legacy] });
    await raw.rebuildAttemptIndex({ ...limits(), maxEntries: 10, maxFileBytes: 128 * 1024, maxTotalBytes: 256 * 1024 });
    expect((await raw.readAttempts("other", { ...limits(), maxFileBytes: 128 * 1024, maxTotalBytes: 256 * 1024 })).attempts).toEqual([large]);
    await raw.addAttempt(attempt("new", "new-session"));
    expect(await raw.readAttempts("s1", limits())).toMatchObject({ attempts: [{ id: "small" }], corrupt: [legacy] });
    expect(await readFile(legacy, "utf8")).toBe(original);
  });

  it("still stops when failed oversized reads exhaust the rebuild aggregate budget", async () => {
    const raw = new FileRawStore({ root });
    await mkdir(join(root, "raw/attempts"), { recursive: true });
    for (const name of ["a", "b"]) await writeFile(join(root, `raw/attempts/${name}.json`), "x".repeat(100));
    await expect(raw.rebuildAttemptIndex({ ...limits(), maxEntries: 2, maxFileBytes: 64, maxTotalBytes: 100 })).rejects.toThrow(/exceeds/);
    await expect(readFile(join(root, "attempt-index.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("pre-abort leaves the cache absent and query byte caps remain enforced", async () => {
    const raw = new FileRawStore({ root });
    await raw.addAttempt(attempt("a"));
    await expect(raw.readAttempts("s1", { ...limits(), signal: AbortSignal.abort() })).rejects.toThrow();
    await expect(readFile(join(root, "attempt-index.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(raw.readAttempts("s1", { ...limits(), maxTotalBytes: 1 })).rejects.toThrow(/exceeds/);
  });

  it("never removes an existing cache temp when exclusive creation collides", async () => {
    const raw = new FileRawStore({ root });
    await raw.addAttempt(attempt("a"));
    const temp = join(root, "attempt-index.json.000000000000.tmp");
    await writeFile(temp, "another owner's artifact");
    vi.mocked(crypto.randomBytes).mockImplementation((() => Buffer.alloc(6)) as typeof crypto.randomBytes);
    await expect(raw.rebuildAttemptIndex()).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(temp, "utf8")).toBe("another owner's artifact");
    expect(JSON.parse(await readFile(join(root, "raw/attempts/a.json"), "utf8"))).toEqual(attempt("a"));
  });
});
