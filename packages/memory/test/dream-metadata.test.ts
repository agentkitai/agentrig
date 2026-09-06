import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyDream, copyWiki, FileMemoryStore, FileRawStore, lastDreamAt, markDreamed, resetDreamStamp, runDream, withMemoryLock } from "@agentkitai/agentrig-memory";

vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, link: vi.fn(actual.link), unlink: vi.fn(actual.unlink), lstat: vi.fn(actual.lstat) };
});
let root: string; let wiki: FileMemoryStore; let stamp: string;
beforeEach(async () => {
  vi.mocked(fs.link).mockReset(); vi.mocked(fs.unlink).mockReset(); vi.mocked(fs.lstat).mockReset();
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "agentrig-dream-metadata-")));
  wiki = new FileMemoryStore({ root: join(root, "wiki") }); await wiki.init(); stamp = join(wiki.root, ".last-dream");
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

it("archives an oversized stamp byte-for-byte outside the scan tree, then allows dreaming again", async () => {
  const bytes = Buffer.alloc(8192, 0xab); await fs.writeFile(stamp, bytes);
  await expect(lastDreamAt(wiki.root)).rejects.toThrow("exceeds 4096 bytes");
  const before = await fs.stat(stamp);
  const result = await resetDreamStamp(wiki.root);
  expect(result.status).toBe("reset"); if (result.status !== "reset") throw new Error("missing backup");
  expect(result.backup.startsWith(wiki.root + ".last-dream-before-reset-")).toBe(true);
  expect(await fs.readFile(result.backup)).toEqual(bytes);
  expect((await fs.stat(result.backup)).mode).toBe(before.mode);
  expect(await lastDreamAt(wiki.root)).toBeUndefined();
  expect(await resetDreamStamp(wiki.root)).toEqual({ status: "absent" });
  const dream = await runDream({ wiki, raw: new FileRawStore({ root }), structuralOnly: true, scanLimits: { maxFileBytes: 4096 } });
  expect(dream.auxiliary?.calls).toEqual([]); await dream.workspace.dispose();
  expect(await lastDreamAt(wiki.root)).toBeGreaterThan(0);
  expect(await fs.readFile(result.backup)).toEqual(bytes);
});

it.skipIf(process.platform === "win32")("resets a no-read-permission regular stamp without opening its content", async () => {
  await fs.writeFile(stamp, "private-corrupt"); await fs.chmod(stamp, 0);
  const result = await resetDreamStamp(wiki.root);
  expect(result.status).toBe("reset"); if (result.status !== "reset") throw new Error("missing backup");
  expect((await fs.stat(result.backup)).mode & 0o777).toBe(0);
  await fs.chmod(result.backup, 0o600); expect(await fs.readFile(result.backup, "utf8")).toBe("private-corrupt");
});

it("applying a retained review copy does not resurrect a stamp explicitly reset on the live wiki", async () => {
  await markDreamed(wiki.root, 1000);
  const workspace = await copyWiki(wiki.root, join(root, "review"));
  await markDreamed(workspace.outputRoot, 2000);
  const reset = await resetDreamStamp(wiki.root); expect(reset.status).toBe("reset");
  await applyDream(wiki.root, workspace.outputRoot, "after-reset");
  expect(await lastDreamAt(wiki.root)).toBeUndefined();
  expect(await lastDreamAt(workspace.outputRoot)).toBe(2000); // Original review artifact is intact.
  if (reset.status === "reset") expect(await fs.readFile(reset.backup, "utf8")).toBe("1000\n");
  await workspace.dispose();
});

it("refuses a stamp symlink and directory, preserving unrelated targets", async () => {
  const other = join(root, "other"); await fs.mkdir(other); await fs.writeFile(join(other, "keep"), "sentinel");
  await fs.symlink(other, stamp, process.platform === "win32" ? "junction" : "dir");
  await expect(resetDreamStamp(wiki.root)).rejects.toThrow("not a regular file");
  expect((await fs.lstat(stamp)).isSymbolicLink()).toBe(true);
  await fs.unlink(stamp); await fs.mkdir(stamp);
  await expect(resetDreamStamp(wiki.root)).rejects.toThrow("not a regular file");
  expect(await fs.readFile(join(other, "keep"), "utf8")).toBe("sentinel");
  expect(await fs.readdir(root)).toEqual(expect.arrayContaining(["wiki", "other"]));
  expect((await fs.readdir(root)).some(name => name.includes("before-reset"))).toBe(false);
});

it("does not initialize a missing wiki or change a pre-aborted stamp", async () => {
  await expect(resetDreamStamp(join(root, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  await fs.writeFile(stamp, "old"); const controller = new AbortController(); controller.abort();
  await expect(resetDreamStamp(wiki.root, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(await fs.readFile(stamp, "utf8")).toBe("old"); expect(await fs.readdir(root)).toEqual(["wiki"]);
});

it("refuses an active lock without stealing or archiving anything", async () => {
  await fs.writeFile(stamp, "old");
  await withMemoryLock(wiki.root, async () => {
    const owner = await fs.readFile(wiki.root + ".write.lock", "utf8");
    await expect(resetDreamStamp(wiki.root, { timeoutMs: 5 })).rejects.toThrow("timed out waiting");
    expect(await fs.readFile(wiki.root + ".write.lock", "utf8")).toBe(owner);
    expect(await fs.readFile(stamp, "utf8")).toBe("old");
    expect((await fs.readdir(root)).some(name => name.includes("before-reset"))).toBe(false);
  });
});

it("checks the root identity again after acquiring its lock", async () => {
  await fs.writeFile(stamp, "old");
  const actual = await vi.importActual<typeof fs>("node:fs/promises"); let rootChecks = 0;
  vi.mocked(fs.lstat).mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
    if (args[0] === wiki.root && ++rootChecks === 2) {
      await fs.rename(wiki.root, join(root, "old-wiki")); await fs.mkdir(wiki.root); await fs.writeFile(stamp, "replacement");
    }
    return actual.lstat(...args);
  });
  await expect(resetDreamStamp(wiki.root)).rejects.toThrow("wiki root replaced");
  expect(await fs.readFile(stamp, "utf8")).toBe("replacement");
  expect(await fs.readFile(join(root, "old-wiki/.last-dream"), "utf8")).toBe("old");
});

it("leaves the original untouched when backup creation fails", async () => {
  await fs.writeFile(stamp, "old");
  vi.mocked(fs.link).mockRejectedValueOnce(Object.assign(new Error("backup exists"), { code: "EEXIST" }));
  await expect(resetDreamStamp(wiki.root)).rejects.toThrow("requires filesystem hard-link support and permission");
  expect(await fs.readFile(stamp, "utf8")).toBe("old"); expect(fs.unlink).not.toHaveBeenCalled();
});

it("names and preserves both files if unlink fails after exclusive backup creation", async () => {
  await fs.writeFile(stamp, "old"); vi.mocked(fs.unlink).mockRejectedValueOnce(new Error("busy"));
  const error = await resetDreamStamp(wiki.root).catch(error => error as Error);
  expect(error).toBeInstanceOf(Error);
  const backup = (await fs.readdir(root)).find(name => name.includes("before-reset"))!;
  expect(String(error)).toContain(join(root, backup)); expect(String(error)).toContain("reset incomplete");
  expect(await fs.readFile(join(root, backup), "utf8")).toBe("old"); expect(await fs.readFile(stamp, "utf8")).toBe("old");
});

it("finishes the reset after backup creation even if cancellation arrives then", async () => {
  await fs.writeFile(stamp, "old"); const controller = new AbortController();
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.link).mockImplementationOnce(async (src, dest) => { await actual.link(src, dest); controller.abort(); });
  const result = await resetDreamStamp(wiki.root, { signal: controller.signal });
  expect(result.status).toBe("reset"); expect(await lastDreamAt(wiki.root)).toBeUndefined();
  if (result.status === "reset") expect(await fs.readFile(result.backup, "utf8")).toBe("old");
});

it.each([undefined, "# Lo", "# Log\n\nAppend-only chron", "human résumé🙂"])("preflights the same header recovery and UTF-8 framing as append: %s", async existing => {
  const log = join(wiki.root, "log.md");
  if (existing === undefined) await fs.rm(log); else await fs.writeFile(log, existing);
  const entry = "fixture é🙂";
  // Independent oracle: actual append result, not duplicated preflight arithmetic.
  await wiki.appendLog(entry); const expected = await fs.readFile(log); const cap = expected.length;
  if (existing === undefined) await fs.rm(log); else await fs.writeFile(log, existing);
  const entryBytes = Buffer.byteLength(entry + "\n");
  await expect(wiki.checkLogCapacity(entryBytes, { maxFileBytes: cap - 1 })).rejects.toThrow("preflight");
  await wiki.checkLogCapacity(entryBytes, { maxFileBytes: cap });
  await wiki.appendLog(entry, { maxFileBytes: cap }); expect(await fs.readFile(log)).toEqual(expected);
});
