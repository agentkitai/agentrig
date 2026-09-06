import * as fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyDream, copyWiki, FileMemoryStore, FileRawStore, fingerprint, loadPromotionEvidence,
  MaintenanceLimitError, runDream, ScanBudget, witnessesForClaim, findingCount, renderReport,
  addPin, readPins, recheckPins, applyPinChecks, writePins, type Pin } from "@agentkitai/agentrig-memory";
import { applyConsolidation } from "../src/dream/apply.ts";

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

it.skipIf(process.platform === "win32")("preserves the H5c1 fingerprint framing for saved manifests", async () => {
  // Fixed vector produced by the unmodified fingerprint at fb8201e, not by this implementation.
  await fs.chmod(wiki, 0o755);
  for (const name of ["dir", "empty"]) { await fs.mkdir(join(wiki, name)); await fs.chmod(join(wiki, name), 0o755); }
  for (const [name, bytes] of [["a", "hello\n"], ["dir/b", "world\n"], [".last-dream", "ignored"]] as const) {
    await textFile(name, bytes); await fs.chmod(join(wiki, name), 0o644);
  }
  await fs.symlink("a", join(wiki, "file-link")); await fs.symlink("dir", join(wiki, "dir-link"));
  if (process.platform === "darwin") {
    await fs.lchmod(join(wiki, "file-link"), 0o777); await fs.lchmod(join(wiki, "dir-link"), 0o777);
  }
  expect(await fingerprint(wiki)).toBe("551253ea1145289d60d2867d45fba1187332caa8d26e86e02838a3d4ef197e55");
});

it("bounds the consolidation reread before performing any proposed edits", async () => {
  const store = new FileMemoryStore({ root: wiki }); await store.init();
  await fs.writeFile(join(wiki, "concepts/bad.md"), "---\nnot valid frontmatter\n---\nbody");
  const writes = vi.spyOn(store, "write");
  const consolidation = { contradictions: [], superseded: [], merged: [], removed: [] };
  await expect(applyConsolidation(store, consolidation, { today: "2026-09-05" })).rejects.toThrow("invalid frontmatter");
  await fs.rm(join(wiki, "concepts/bad.md"));
  await expect(applyConsolidation(store, consolidation, { today: "2026-09-05", scanLimits: { maxTotalBytes: 1 } }))
    .rejects.toBeInstanceOf(MaintenanceLimitError);
  expect(writes).not.toHaveBeenCalled();
});

it("shares pin metadata and repeat page validation byte budgets without committing partial checks", async () => {
  const store = new FileMemoryStore({ root: wiki }); await store.init();
  const pin: Pin = { page: "concepts/a.md", kind: "correction", claim: "alpha", anchor: "", provenance: "human",
    created: "2026-09-05", status: "active" };
  await store.write(pin.page, { path: pin.page, body: "alpha", frontmatter: { type: "concept", slug: "a",
    aliases: [], sources: [], updated: "2026-09-05", confidence: "high" } });
  await addPin(wiki, pin);
  const original = await fs.readFile(join(wiki, "pins.json"));
  const pageBytes = (await fs.stat(join(wiki, pin.page))).size;
  const opts = { scanBudget: new ScanBudget({ scanLimits: { maxTotalBytes: original.length + pageBytes } }) };
  const pins = await readPins(wiki, opts); const checks = await recheckPins(store, pins, opts);
  await expect(applyPinChecks(store, checks, opts)).rejects.toBeInstanceOf(MaintenanceLimitError);
  // Enough for metadata but not the page revalidation inside the guarded apply.
  await expect(applyPinChecks(store, checks, { scanBudget: new ScanBudget({ scanLimits: { maxTotalBytes: original.length } }) }))
    .rejects.toBeInstanceOf(MaintenanceLimitError);
  await expect(recheckPins(store, [pin, pin], { scanBudget: new ScanBudget({ scanLimits: { maxEntries: 1 } }) }))
    .rejects.toThrow("pin entry limit");
  await expect(writePins(wiki, [pin], { maxFileBytes: 1 })).rejects.toThrow("pins output limit");
  expect(await fs.readFile(join(wiki, "pins.json"))).toEqual(original);
});

it("keeps scheduling stamps capped at 4 KiB within otherwise larger dream scans", async () => {
  const store = new FileMemoryStore({ root: wiki }); await store.init(); await textFile(".last-dream", "1".repeat(4097));
  const phases: string[] = [];
  await expect(runDream({ wiki: store, raw: new FileRawStore({ root }), outputRoot: output, structuralOnly: true,
    onPhase: phase => phases.push(phase) })).rejects.toThrow("4096 bytes");
  expect(phases).toEqual(["orient", "gather"]); await absent(output);
});

it("rejects oversized index replacements without altering the previous index", async () => {
  const store = new FileMemoryStore({ root: wiki }); await store.init();
  const before = await fs.readFile(join(wiki, "index.md"));
  await expect(store.writeIndex([], { maxFileBytes: 1 })).rejects.toBeInstanceOf(MaintenanceLimitError);
  expect(await fs.readFile(join(wiki, "index.md"))).toEqual(before);
});

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
  await expect(store.pages({})).rejects.toThrow("invalid frontmatter");
  await fs.rm(join(wiki, "concepts/bad.md"));
  await expect(store.pages({ scanLimits: { maxTotalBytes: 1 } })).rejects.toBeInstanceOf(MaintenanceLimitError);
});

it.each(["entries", "corrupt"])("dream handles %s ledger omissions without claiming a clean scan", async kind => {
  const store = new FileMemoryStore({ root: wiki }); await store.init();
  await store.write("concepts/a.md", { path: "concepts/a.md", body: "- [stated] fact (doc:fixture)",
    frontmatter: { type: "concept", slug: "a", aliases: [], sources: ["doc:fixture"], updated: "2026-09-05", confidence: "high" } });
  await fs.mkdir(join(root, "raw/attempts"), { recursive: true });
  for (let i = 0; i < (kind === "entries" ? 13 : 1); i++) await fs.writeFile(join(root, `raw/attempts/${i}.json`), "{bad");
  const stream = vi.fn(async function* () { yield { type: "stop" as const, reason: "end_turn" as const }; });
  const before = await fingerprint(wiki);
  const warnings: Error[] = [];
  const running = runDream({ wiki: store, raw: new FileRawStore({ root }), outputRoot: output, scanLimits: { maxEntries: 12 },
    onError: error => warnings.push(error),
    provider: { id: "fixture", model: "fixture", capabilities: { tools: false, parallelTools: false, caching: false, contextWindow: 10000 }, stream } });
  if (kind === "entries") await expect(running).rejects.toThrow("entry limit");
  else {
    const result = await running;
    expect(result.report.scan).toEqual({ complete: false, unreadableAttempts: [join(root, "raw/attempts/0.json")] });
    expect(warnings[0]!.message).toContain("raw scan incomplete");
    expect(findingCount(result.report)).toBeGreaterThan(0);
    expect(renderReport(result.report)).toContain("automatic apply are disabled");
    expect(renderReport(result.report)).not.toContain("wiki is clean");
    expect(await fs.readFile(join(root, "raw/attempts/0.json"), "utf8")).toBe("{bad");
    await result.workspace.dispose();
  }
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

it("does not allocate one retained buffer per short filesystem read", async () => {
  const path = join(wiki, "short-reads"); const text = "x".repeat(256); await fs.writeFile(path, text);
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const buffers = new Set<unknown>();
  vi.mocked(fs.open).mockImplementationOnce(async (file, flags, mode) => {
    const handle = await actual.open(file, flags, mode); const read = handle.read.bind(handle);
    vi.spyOn(handle, "read").mockImplementation(async (buffer, offset, length, position) => {
      buffers.add(buffer);
      return read(buffer, offset, Math.min(length, 1), position);
    });
    return handle;
  });
  const bytes = await new ScanBudget({ scanLimits: { maxFileBytes: 256 } }).read(path);
  expect(bytes.toString()).toBe(text); expect(buffers.size).toBeLessThanOrEqual(2);
});

it("grows one read buffer geometrically when a file grows within the allowed cap", async () => {
  const path = join(wiki, "growth"); await fs.writeFile(path, "x");
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const buffers = new Set<Buffer>();
  vi.mocked(fs.open).mockImplementationOnce(async (file, flags, mode) => {
    const handle = await actual.open(file, flags, mode); const stat = handle.stat.bind(handle); const read = handle.read.bind(handle);
    vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
      const before = await stat(); await actual.writeFile(path, "123456789abc"); return before;
    });
    vi.spyOn(handle, "read").mockImplementation(async (buffer, offset, length, position) => {
      buffers.add(buffer); return read(buffer, offset, length, position);
    });
    return handle;
  });
  expect((await new ScanBudget({ scanLimits: { maxFileBytes: 12 } }).read(path)).toString()).toBe("123456789abc");
  expect(buffers.size).toBeGreaterThan(1);
  expect([...buffers].every(buffer => buffer.length <= 13)).toBe(true);
  expect([...buffers].reduce((sum, buffer) => sum + buffer.length, 0)).toBeLessThanOrEqual(3 * 13);
});

it("observes cancellation arriving while closing a completed read", async () => {
  const store = new FileMemoryStore({ root: wiki }); await store.init();
  const path = "concepts/a.md"; const controller = new AbortController();
  await store.write(path, { path, body: "- [stated] original (doc:fixture)",
    frontmatter: { type: "concept", slug: "a", aliases: [], sources: ["doc:fixture"], updated: "2026-09-05", confidence: "high" } });
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fs.open).mockImplementationOnce(async (file, flags, mode) => {
    const handle = await actual.open(file, flags, mode); const close = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementationOnce(async () => { await close(); controller.abort(new Error("stop after read")); });
    return handle;
  });
  await expect(store.read(path, { signal: controller.signal, maxFileBytes: 2048 })).rejects.toThrow("stop after read");
});

it.each(["file", "aggregate"])("propagates the scan %s byte cap into evidence log reads", async kind => {
  const refs = [];
  let bytes = 0;
  for (const id of ["s1", "s2"]) {
    const path = join(root, id + ".jsonl");
    const text = JSON.stringify({ type: "session.start", sessionId: id, seq: 0, ts: 1 }) + "\n";
    bytes = Buffer.byteLength(text); await fs.writeFile(path, text); refs.push({ id, path, updatedAt: 1 });
  }
  const evidence = await loadPromotionEvidence({ sessions: async () => refs }, ["s1", "s2"], {
    scanLimits: kind === "file" ? { maxFileBytes: bytes - 1 } : { maxTotalBytes: bytes + 1 },
  });
  if (kind === "aggregate") expect(witnessesForClaim(evidence, "s1", "fact").error).toBeUndefined();
  expect(witnessesForClaim(evidence, "s2", "fact").error).toContain("byte limit");
});
