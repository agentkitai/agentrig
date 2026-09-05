import * as fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyDream, copyWiki, FileMemoryStore, FileRawStore, fingerprint, loadPromotionEvidence,
  MaintenanceLimitError, runDream, ScanBudget } from "@agentkitai/agentrig-memory";

vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), writeFile: vi.fn(actual.writeFile) };
});
let root: string; let wiki: string; let output: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "agentrig-dream-scans-")));
  wiki = join(root, "wiki"); output = join(root, "output"); await fs.mkdir(wiki);
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
const absent = (path: string) => expect(fs.lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
const textFile = (name: string, text: string) => fs.writeFile(join(wiki, name), text);

it("copies and applies exact entry/file/aggregate boundaries, including dotfiles and empty directories", async () => {
  await textFile("a", "1234"); await textFile(".hidden", "5678"); await fs.mkdir(join(wiki, "empty"));
  const scanLimits = { maxEntries: 3, maxFileBytes: 4, maxTotalBytes: 8, maxDepth: 1 };
  const before = await fingerprint(wiki, { scanLimits });
  const ws = await copyWiki(wiki, output, { scanLimits });
  expect(await fingerprint(output, { scanLimits })).toBe(before);
  const backup = await applyDream(wiki, output, "bounded", { scanLimits });
  expect(await fingerprint(backup, { scanLimits })).toBe(before);
  expect(await fs.readFile(join(wiki, ".hidden"), "utf8")).toBe("5678");
  expect((await fs.stat(join(wiki, "empty"))).isDirectory()).toBe(true); await ws.dispose();
});

it.each(["entries", "file", "aggregate", "depth"])("rejects the %s cap without leaving a partial snapshot", async kind => {
  await textFile("a", "1234"); await textFile("b", "5678");
  if (kind === "depth") await fs.mkdir(join(wiki, "one/two"), { recursive: true });
  const scanLimits = kind === "entries" ? { maxEntries: 1 } : kind === "file" ? { maxFileBytes: 3 }
    : kind === "aggregate" ? { maxTotalBytes: 7 } : { maxDepth: 1 };
  const before = await fingerprint(wiki);
  await expect(copyWiki(wiki, output, { scanLimits })).rejects.toBeInstanceOf(MaintenanceLimitError);
  expect(await fingerprint(wiki)).toBe(before);
  await absent(output); await absent(output + ".dream.json"); await absent(wiki + ".write.lock");
});

it.each([0, -1, 1.5, NaN, Infinity, 2_147_483_648])("validates a scan cap %s before creating artifacts", async maxEntries => {
  await expect(copyWiki(wiki, output, { scanLimits: { maxEntries } })).rejects.toThrow();
  await absent(output); await absent(output + ".write.lock");
});

it("rejects pre-aborted scans and raw enumeration without creating an output", async () => {
  const controller = new AbortController(); controller.abort(new Error("stop scanning"));
  await expect(copyWiki(wiki, output, { signal: controller.signal })).rejects.toThrow("stop scanning");
  await expect(new FileRawStore({ root }).sessions(undefined, { signal: controller.signal })).rejects.toThrow("stop scanning");
  await absent(output);
});

it("stops copying after an abort and cleans only its fresh output", async () => {
  await textFile("a", "original"); await textFile("b", "keep");
  const before = await fingerprint(wiki); const controller = new AbortController();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let writes = 0;
  vi.mocked(fs.writeFile).mockImplementation(async (file, data, options) => {
    writes++; await actual.writeFile(file, data, options); controller.abort(new Error("stop copy"));
  });
  await expect(copyWiki(wiki, output, { signal: controller.signal })).rejects.toThrow("stop copy");
  expect(writes).toBe(1); expect(await fingerprint(wiki)).toBe(before);
  await absent(output); await absent(output + ".dream.json");
});

it("cleans its manifest too when abort arrives during the final manifest write", async () => {
  await textFile("a", "original"); const controller = new AbortController();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let injected = false;
  vi.mocked(fs.open).mockImplementation(async (file, flags, mode) => {
    const handle = await actual.open(file, flags, mode);
    if (String(file) === output + ".dream.json" && flags === "wx") {
      const write = handle.writeFile.bind(handle);
      vi.spyOn(handle, "writeFile").mockImplementationOnce(async (...args) => {
        await write(...args); injected = true; controller.abort(new Error("stop manifest"));
      });
    }
    return handle;
  });
  await expect(copyWiki(wiki, output, { signal: controller.signal })).rejects.toThrow("stop manifest");
  expect(injected).toBe(true); await absent(output); await absent(output + ".dream.json");
  expect(await fs.readFile(join(wiki, "a"), "utf8")).toBe("original");
});

it("a proposed artifact exceeding the stage budget cannot move the live root", async () => {
  await textFile("a", "original"); const before = await fingerprint(wiki);
  const ws = await copyWiki(wiki, output); await fs.writeFile(join(output, "a"), "too much proposed content");
  await expect(applyDream(wiki, output, "oversize", { scanLimits: { maxFileBytes: 8 } })).rejects.toBeInstanceOf(MaintenanceLimitError);
  expect(await fingerprint(wiki)).toBe(before); await absent(wiki + ".before-dream-oversize");
  expect((await fs.readdir(root)).some(name => name.includes("dream-staged-"))).toBe(false);
  expect(await fs.readFile(join(output, "a"), "utf8")).toBe("too much proposed content"); await ws.dispose();
});

it.skipIf(process.platform === "win32")("rejects FIFOs without waiting for a writer", async () => {
  await promisify(execFile)("mkfifo", [join(wiki, "pipe")]);
  await expect(copyWiki(wiki, output)).rejects.toThrow("unsupported file in dream snapshot");
  await absent(output);
});

it("materializes links but rejects linked directory cycles", async () => {
  const external = join(root, "external"); await fs.mkdir(external); await fs.writeFile(join(external, "a"), "outside");
  await fs.symlink(external, join(wiki, "linked"), process.platform === "win32" ? "junction" : "dir");
  const ws = await copyWiki(wiki, output);
  expect((await fs.lstat(join(output, "linked"))).isSymbolicLink()).toBe(false);
  expect(await fs.readFile(join(output, "linked/a"), "utf8")).toBe("outside"); await ws.dispose();
  await fs.symlink(wiki, join(wiki, "cycle"), process.platform === "win32" ? "junction" : "dir");
  await expect(copyWiki(wiki, output)).rejects.toThrow("cyclic directory symlink"); await absent(output);
});

it.skipIf(process.platform === "win32")("preserves file mode bits that the process umask would remove", async () => {
  await textFile("a", "original"); await fs.chmod(join(wiki, "a"), 0o666);
  const ws = await copyWiki(wiki, output);
  expect((await fs.stat(join(output, "a"))).mode & 0o777).toBe(0o666); await ws.dispose();
});

it("bounds bytes even when a regular file grows after stat", async () => {
  const path = join(wiki, "a"); await textFile("a", "1234");
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fs.open).mockImplementationOnce(async (file, flags, mode) => {
    const handle = await actual.open(file, flags, mode); const stat = handle.stat.bind(handle);
    vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
      const before = await stat(); await actual.writeFile(path, "123456789"); return before;
    });
    return handle;
  });
  await expect(new ScanBudget({ scanLimits: { maxFileBytes: 4 } }).read(path)).rejects.toThrow("exceeds 4 bytes");
});

it("counts ignored raw-directory entries and refuses partial session or document enumeration", async () => {
  const raw = new FileRawStore({ root });
  for (const dir of ["sessions", "docs"]) {
    await fs.mkdir(join(root, "raw", dir), { recursive: true });
    await fs.writeFile(join(root, "raw", dir, "ignored.snapshot.json"), "{}");
    await fs.writeFile(join(root, "raw", dir, "s1.jsonl"), "{}");
  }
  await expect(raw.sessions(Date.now(), { scanLimits: { maxEntries: 1 } })).rejects.toThrow("entry limit");
  await expect(raw.docs({ scanLimits: { maxEntries: 1 } })).rejects.toThrow("entry limit");
  expect(await raw.sessions(undefined, { scanLimits: { maxEntries: 2 } })).toHaveLength(1);
});

it("bounded page scans propagate malformed pages and cap aggregate bytes", async () => {
  const store = new FileMemoryStore({ root: wiki }); await store.init();
  await fs.writeFile(join(wiki, "concepts/bad.md"), "---\nnot valid frontmatter\n---\nbody");
  await expect(store.pages({})).rejects.toThrow();
  await fs.rm(join(wiki, "concepts/bad.md"));
  await expect(store.pages({ scanLimits: { maxTotalBytes: 1 } })).rejects.toBeInstanceOf(MaintenanceLimitError);
});

it.each(["entries", "corrupt"])("dream rejects an incomplete %s ledger scan before model work", async kind => {
  const store = new FileMemoryStore({ root: wiki }); await store.init();
  await store.write("concepts/a.md", { path: "concepts/a.md", body: "- [stated] fact (doc:fixture)",
    frontmatter: { type: "concept", slug: "a", aliases: [], sources: ["doc:fixture"], updated: "2026-09-05", confidence: "high" } });
  await fs.mkdir(join(root, "raw/attempts"), { recursive: true });
  for (let i = 0; i < (kind === "entries" ? 13 : 1); i++) await fs.writeFile(join(root, `raw/attempts/${i}.json`), "{bad");
  const stream = vi.fn(async function* () { yield { type: "stop" as const, reason: "end_turn" as const }; });
  const before = await fingerprint(wiki);
  await expect(runDream({ wiki: store, raw: new FileRawStore({ root }), outputRoot: output, scanLimits: { maxEntries: 12 },
    provider: { id: "fixture", model: "fixture", capabilities: { tools: false, parallelTools: false, caching: false, contextWindow: 10000 }, stream } }))
    .rejects.toThrow(kind === "entries" ? "entry limit" : "corrupt attempt ledger");
  expect(stream).not.toHaveBeenCalled(); expect(await fingerprint(wiki)).toBe(before);
  await absent(output); await absent(output + ".dream.json");
});

it("bounds evidence discovery even for a custom raw store that ignores scan options", async () => {
  const raw = { sessions: async () => [{ id: "a", path: "unused", updatedAt: 1 }, { id: "b", path: "unused", updatedAt: 1 }] };
  await expect(loadPromotionEvidence(raw, [], { scanLimits: { maxEntries: 1 } })).rejects.toThrow("evidence session enumeration limit");
});

it("does not lose cancellation when evidence enumeration returns no sessions", async () => {
  const controller = new AbortController();
  const raw = { sessions: async () => { controller.abort(new Error("stop evidence")); return []; } };
  await expect(loadPromotionEvidence(raw, [], { signal: controller.signal })).rejects.toThrow("stop evidence");
});

it("counts duplicate citations as scan work instead of draining an endless iterable", async () => {
  function* citations() { while (true) yield "same"; }
  await expect(loadPromotionEvidence({ sessions: async () => [] }, citations(), { scanLimits: { maxEntries: 2 } }))
    .rejects.toThrow("evidence citation limit");
});
