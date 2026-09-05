import { fork, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyDream, copyWiki, FileMemoryStore, FileRawStore, fingerprint, markDreamed, lastDreamAt, runDream, withMemoryLock } from "@agentkitai/agentrig-memory";

vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename), cp: vi.fn(actual.cp), open: vi.fn(actual.open), writeFile: vi.fn(actual.writeFile) };
});
let root: string; let store: FileMemoryStore;
const path = "concepts/a.md";
const children: ChildProcess[] = [];
const page = (body: string) => ({ path, body, frontmatter: { type: "concept" as const, slug: "a", aliases: [], sources: ["doc:fixture"], updated: "2026-09-05", confidence: "high" as const } });
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-dream-lifecycle-")));
  store = new FileMemoryStore({ root: join(root, "wiki") }); await store.init();
  await store.write(path, page("- [observed] original fact (doc:fixture)\n"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill(); await exited;
    }
  }
  await rm(root, { recursive: true, force: true });
});
const copy = () => copyWiki(store.root, join(root, "output"));

it("persists source identity outside a fresh copy and rejects an intervening fact update", async () => {
  const ws = await copy();
  const manifest = JSON.parse(await readFile(ws.manifestPath, "utf8"));
  expect(manifest).toMatchObject({ version: 1, sourceRoot: await realpath(store.root), sourceFingerprint: await fingerprint(store.root) });
  expect(ws.manifestPath.startsWith(ws.outputRoot + ".")).toBe(true);
  await store.update(path, current => ({ ...current!, body: current!.body + "human fact\n" }));
  await expect(applyDream(store.root, ws.outputRoot, "stale")).rejects.toThrow("stale dream snapshot");
  expect((await store.read(path))!.body).toContain("human fact");
  expect(await readdir(root)).not.toContain("wiki.before-dream-stale");
  await ws.dispose(); await ws.dispose();
});

it.each(["add", "delete", "empty-directory", "nested-metadata"])("detects %s changes outside the normal page list", async kind => {
  const ws = await copy();
  if (kind === "add") await writeFile(join(store.root, "human-note.txt"), "new");
  else if (kind === "delete") await rm(join(store.root, path));
  else if (kind === "empty-directory") await mkdir(join(store.root, "empty"));
  else { await mkdir(join(store.root, "nested")); await writeFile(join(store.root, "nested/.last-dream"), "human content"); }
  await expect(applyDream(store.root, ws.outputRoot, "stale")).rejects.toThrow("stale dream snapshot");
  await ws.dispose();
});

it("rejects a replacement source directory even with identical bytes", async () => {
  const ws = await copy();
  await rename(store.root, join(root, "old-wiki"));
  await fs.cp(join(root, "old-wiki"), store.root, { recursive: true });
  expect(await fingerprint(store.root)).toBe(JSON.parse(await readFile(ws.manifestPath, "utf8")).sourceFingerprint);
  await expect(applyDream(store.root, ws.outputRoot, "replaced")).rejects.toThrow("stale dream snapshot");
  await ws.dispose();
});

it.skipIf(process.platform === "win32")("preserves root permissions and rejects intervening permission changes", async () => {
  await fs.chmod(store.root, 0o750);
  const ws = await copy();
  expect((await fs.stat(ws.outputRoot)).mode & 0o777).toBe(0o750);
  await fs.chmod(store.root, 0o700);
  await expect(applyDream(store.root, ws.outputRoot, "permissions")).rejects.toThrow("stale dream snapshot");
  await fs.chmod(store.root, 0o750);
  await applyDream(store.root, ws.outputRoot, "permissions");
  expect((await fs.stat(store.root)).mode & 0o777).toBe(0o750);
  await ws.dispose();
});

it("does not replace a symlinked live root and retains the original physical backup", async () => {
  const alias = join(root, "alias"); await symlink(store.root, alias, process.platform === "win32" ? "junction" : "dir");
  const ws = await copyWiki(alias, join(root, "output"));
  await new FileMemoryStore({ root: ws.outputRoot }).write(path, page("dreamt"));
  const backup = await applyDream(alias, ws.outputRoot, "alias");
  expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
  expect((await store.read(path))!.body).toContain("dreamt");
  expect(await readFile(join(backup, path), "utf8")).toContain("original fact");
  await ws.dispose();
});

it.each(["same", "child", "parent", "existing"])("refuses a %s output without deleting user content", async kind => {
  const dest = kind === "same" ? store.root : kind === "child" ? join(store.root, "child") : kind === "parent" ? root : join(root, "existing");
  if (kind === "existing") { await mkdir(dest); await writeFile(join(dest, "sentinel"), "keep"); }
  const before = await fingerprint(store.root);
  await expect(copyWiki(store.root, dest)).rejects.toThrow(/overlap|already exists/);
  expect(await fingerprint(store.root)).toBe(before);
  if (kind === "existing") expect(await readFile(join(dest, "sentinel"), "utf8")).toBe("keep");
});

it("refuses an alias destination pointing at the source", async () => {
  const alias = join(root, "alias"); await symlink(store.root, alias, process.platform === "win32" ? "junction" : "dir");
  await expect(copyWiki(store.root, alias)).rejects.toThrow("overlap");
  expect((await store.read(path))!.body).toContain("original fact");
});

it("rejects unregistered, tampered or replaced outputs without touching the live wiki", async () => {
  const output = join(root, "unregistered"); await mkdir(output);
  await expect(applyDream(store.root, output, "unregistered")).rejects.toMatchObject({ code: "ENOENT" });
  const ws = await copy();
  const manifest = JSON.parse(await readFile(ws.manifestPath, "utf8"));
  await writeFile(ws.manifestPath, JSON.stringify({ ...manifest, sourceRoot: root }));
  await expect(applyDream(store.root, ws.outputRoot, "tampered")).rejects.toThrow("stale dream snapshot");
  await writeFile(ws.manifestPath, JSON.stringify(manifest));
  await rename(ws.outputRoot, join(root, "original-output")); await mkdir(ws.outputRoot);
  await writeFile(join(ws.outputRoot, "sentinel"), "new owner");
  await expect(ws.dispose()).rejects.toThrow("replaced");
  await expect(applyDream(store.root, ws.outputRoot, "replaced")).rejects.toThrow("replaced");
  expect(await readFile(join(ws.outputRoot, "sentinel"), "utf8")).toBe("new owner");
});

it("preserves another manifest owner during disposal", async () => {
  const ws = await copy();
  const manifest = JSON.parse(await readFile(ws.manifestPath, "utf8"));
  await writeFile(ws.manifestPath, JSON.stringify({ ...manifest, owner: "00000000-0000-4000-8000-000000000000" }));
  await expect(ws.dispose()).rejects.toThrow("owner changed");
  expect(await readFile(join(ws.outputRoot, path), "utf8")).toContain("original fact");
});

it("keeps a pre-existing deterministic staging path and rejects path-bearing stamps", async () => {
  const ws = await copy(); const oldStage = store.root + ".dream-staged-stamp";
  await mkdir(oldStage); await writeFile(join(oldStage, "sentinel"), "not ours");
  await expect(applyDream(store.root, ws.outputRoot, "../bad")).rejects.toThrow("invalid backup stamp");
  await applyDream(store.root, ws.outputRoot, "stamp");
  expect(await readFile(join(oldStage, "sentinel"), "utf8")).toBe("not ours");
  await ws.dispose();
});

it("preserves a newer live scheduling stamp without invalidating a content snapshot", async () => {
  await markDreamed(store.root, 1000); const ws = await copy();
  await markDreamed(store.root, 3000); await markDreamed(store.root, 2000);
  await markDreamed(ws.outputRoot, 1500);
  await applyDream(store.root, ws.outputRoot, "stamp");
  expect(await lastDreamAt(store.root)).toBe(3000); await ws.dispose();
});

it("restores the original after an injected second-rename failure and removes only its stage", async () => {
  const ws = await copy(); const before = await fingerprint(store.root);
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let failed = false;
  vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    if (String(from).includes(".dream-staged-") && String(to) === store.root) { failed = true; throw new Error("injected stage rename failure"); }
    return actual.rename(from, to);
  });
  await expect(applyDream(store.root, ws.outputRoot, "restore")).rejects.toThrow("injected stage rename failure");
  expect(failed).toBe(true); expect(await fingerprint(store.root)).toBe(before);
  expect((await readdir(root)).filter(name => name.includes("dream-staged-") || name.includes("before-dream-"))).toEqual([]);
  await ws.dispose();
});

it("preserves backup and stage and names both when restore also fails", async () => {
  const ws = await copy(); const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let attempted = 0;
  vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    if (String(to) === store.root) { attempted++; throw new Error("injected destination unavailable"); }
    return actual.rename(from, to);
  });
  const error = await applyDream(store.root, ws.outputRoot, "failed").catch(error => error);
  expect(attempted).toBe(2); expect(error.message).toContain("failed AND could not restore");
  expect(error.message).toContain(store.root + ".before-dream-failed");
  expect(error.message).toContain(store.root + ".dream-staged-failed-");
  expect(await readFile(join(store.root + ".before-dream-failed", path), "utf8")).toContain("original fact");
  expect((await readdir(root)).some(name => name.startsWith("wiki.dream-staged-failed-"))).toBe(true);
  await ws.dispose();
});

it("fails before any rename when copying the proposed artifact fails", async () => {
  const ws = await copy(); const before = await fingerprint(store.root);
  vi.mocked(fs.writeFile).mockRejectedValueOnce(new Error("injected copy failure"));
  vi.mocked(fs.rename).mockClear();
  await expect(applyDream(store.root, ws.outputRoot, "copy-fail")).rejects.toThrow("injected copy failure");
  expect(fs.rename).not.toHaveBeenCalled(); expect(await fingerprint(store.root)).toBe(before);
  expect((await readdir(root)).some(name => name.includes("dream-staged-"))).toBe(false);
  await ws.dispose();
});

it.each(["before-swap", "after-original-moved"])("handles abort %s without losing the live root", async when => {
  const ws = await copy(); const controller = new AbortController();
  await new FileMemoryStore({ root: ws.outputRoot }).write(path, page("proposed fact"));
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  if (when === "before-swap") vi.mocked(fs.writeFile).mockImplementationOnce(async (file, data, options) => {
    await actual.writeFile(file, data, options); controller.abort(new Error("injected abort"));
  });
  else vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    await actual.rename(from, to);
    if (String(from) === store.root) controller.abort(new Error("injected abort"));
  });
  const applying = applyDream(store.root, ws.outputRoot, "abort", { signal: controller.signal });
  if (when === "before-swap") {
    await expect(applying).rejects.toThrow("injected abort");
    expect((await store.read(path))!.body).toContain("original fact");
    expect(await fs.lstat(store.root + ".before-dream-abort").catch(() => null)).toBeNull();
  } else {
    const backup = await applying;
    expect((await store.read(path))!.body).toContain("proposed fact");
    expect(await readFile(join(backup, path), "utf8")).toContain("original fact");
  }
  expect((await readdir(root)).some(name => name.includes("dream-staged-"))).toBe(false);
  await ws.dispose();
});

it("cleans its failed fresh copy but preserves unrelated manifest content", async () => {
  const output = join(root, "output"); const manifest = output + ".dream.json";
  await writeFile(manifest, "unrelated manifest");
  await expect(copy()).rejects.toThrow("manifest already exists");
  expect(await readFile(manifest, "utf8")).toBe("unrelated manifest");
  expect(await fs.lstat(output).catch(() => null)).toBeNull();
});

it("rejects unreadable source entries rather than silently hashing a partial tree", async () => {
  await symlink(join(root, "missing"), join(store.root, "broken"));
  await expect(copy()).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.lstat(join(root, "output")).catch(() => null)).toBeNull();
});

it("serializes against an actual separate-process store writer and rejects the now-stale apply", async () => {
  const ws = await copy();
  const child = fork(new URL("./fixtures/dream-writer.mjs", import.meta.url), [store.root, path], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  children.push(child);
  const locked = Promise.withResolvers<void>(); const done = Promise.withResolvers<void>();
  void done.promise.catch(() => {});
  child.on("error", error => { locked.reject(error); done.reject(error); });
  child.on("message", (message: { type: string; message?: string }) => {
    if (message.type === "locked") locked.resolve();
    if (message.type === "done") done.resolve();
    if (message.type === "error") { const error = new Error(message.message); locked.reject(error); done.reject(error); }
  });
  child.on("exit", code => { if (code !== 0) { const error = new Error("writer exit " + code); locked.reject(error); done.reject(error); } });
  await locked.promise;
  let settled = false;
  const applying = applyDream(store.root, ws.outputRoot, "race", { timeoutMs: 3000 }).then(
    result => { settled = true; return { result, error: undefined }; },
    (error: Error) => { settled = true; return { result: undefined, error }; });
  await new Promise(resolve => setTimeout(resolve, 30)); expect(settled).toBe(false);
  child.send("release"); await done.promise;
  const outcome = await applying;
  expect(outcome.result).toBeUndefined(); expect(outcome.error?.message).toContain("stale dream snapshot");
  expect((await store.read(path))!.body).toContain("concurrent process fact");
  await ws.dispose();
}, 20_000);

it("does not dispose a workspace while another owner holds its mutation lock", async () => {
  const ws = await copy(); const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const owner = withMemoryLock(ws.outputRoot, async () => { entered.resolve(); await release.promise; });
  await entered.promise; let finished = false;
  const disposing = ws.dispose().then(() => { finished = true; });
  await new Promise(resolve => setTimeout(resolve, 30)); expect(finished).toBe(false);
  release.resolve(); await owner; await disposing;
  expect(await fs.lstat(ws.outputRoot).catch(() => null)).toBeNull();
});

it("blocks a store writer while copying a guarded source snapshot", async () => {
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fs.writeFile).mockImplementationOnce(async (file, data, options) => {
    expect(await readFile(store.root + ".write.lock", "utf8")).toMatch(new RegExp(`^${process.pid}:`));
    entered.resolve(); await release.promise; await actual.writeFile(file, data, options);
  });
  const copying = copy();
  await entered.promise;
  let updated = false;
  const writing = store.update(path, current => ({ ...current!, body: "later write" })).then(() => { updated = true; });
  try { await new Promise(resolve => setTimeout(resolve, 30)); expect(updated).toBe(false); }
  finally { release.resolve(); }
  const ws = await copying; await writing;
  expect(await readFile(join(ws.outputRoot, path), "utf8")).toContain("original fact");
  await expect(applyDream(store.root, ws.outputRoot, "late")).rejects.toThrow("stale dream snapshot");
  await ws.dispose();
});

it("stamp writes use the mutation lock and the configured wait", async () => {
  await withMemoryLock(store.root, async () => {
    await expect(markDreamed(store.root, 1000, { timeoutMs: 0 })).rejects.toThrow("timed out waiting for memory lock");
    expect(await lastDreamAt(store.root)).toBeUndefined();
    await expect(runDream({ wiki: store, raw: new FileRawStore({ root }), structuralOnly: true,
      outputRoot: join(root, "blocked-output"), lockTimeoutMs: 0 })).rejects.toThrow("timed out waiting for memory lock");
  });
  expect(await fs.lstat(join(root, "blocked-output")).catch(() => null)).toBeNull();
});

it("alias writers retain the physical lock key while the live root is temporarily absent", async () => {
  const alias = join(root, "alias"); await symlink(store.root, alias, process.platform === "win32" ? "junction" : "dir");
  const moved = join(root, "temporarily-moved"); let settled = false;
  let writing: Promise<unknown>;
  await withMemoryLock(store.root, async () => {
    await rename(store.root, moved);
    writing = markDreamed(alias, 1234).then(() => { settled = true; }, error => { settled = true; return error; });
    try { await new Promise(resolve => setTimeout(resolve, 30)); expect(settled).toBe(false); }
    finally { await rename(moved, store.root); }
  });
  expect(await writing!).toBeUndefined(); expect(await lastDreamAt(store.root)).toBe(1234);
  expect(await fs.lstat(alias + ".write.lock").catch(() => null)).toBeNull();
});

it("reports live scheduling-stamp failures instead of silently retriggering", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    if (String(to) === join(store.root, ".last-dream")) throw new Error("injected live stamp failure");
    await actual.rename(from, to);
  });
  const warnings: Error[] = [];
  const result = await runDream({ wiki: store, raw: new FileRawStore({ root }), structuralOnly: true,
    outputRoot: join(root, "output"), now: () => 1234, onError: error => warnings.push(error) });
  expect(warnings.map(error => error.message)).toEqual([expect.stringContaining("scheduling stamp was not updated")]);
  expect(warnings[0]!.message).toContain("injected live stamp failure");
  expect(await lastDreamAt(store.root)).toBeUndefined(); expect(await lastDreamAt(result.outputRoot)).toBe(1234);
  await result.workspace.dispose();
});

it("bounds manifest reads without replacing the live wiki", async () => {
  const ws = await copy(); const before = await fingerprint(store.root);
  await expect(applyDream(store.root, ws.outputRoot, "bounded", { maxFileBytes: 8 })).rejects.toThrow("exceeds 8 bytes");
  expect(await fingerprint(store.root)).toBe(before); await ws.dispose();
});
