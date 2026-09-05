import { fork } from "node:child_process";
import * as fs from "node:fs/promises";
import { mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileMemoryStore, FileRawStore, memoryTools, runDream, withMemoryLock,
  type MemoryWriteResult, type PageWrite } from "@agentkitai/agentrig-memory";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

let root: string;
let store: FileMemoryStore;
const path = "concepts/shared.md";
const page = (body = "original"): PageWrite => ({ path, body,
  frontmatter: { type: "concept", slug: "shared", aliases: [], sources: [], updated: "2026-09-05", confidence: "medium" } });
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "agentrig-versions-")); store = new FileMemoryStore({ root: join(root, "wiki") }); await store.init(); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
const ctx = () => ({ cwd: root, sessionId: "fixture", signal: new AbortController().signal, emit() {} });
const tool = (name: string) => memoryTools({ store }).find(tool => tool.name === name)!;

describe("versioned memory mutations", () => {
  it("creates only when absent, then requires the exact read version", async () => {
    expect(await store.compareAndSwap(path, page(), null)).toMatchObject({ ok: true });
    const current = (await store.read(path))!;
    expect(current.version).toMatch(/^[a-f0-9]{64}$/);
    expect(await store.compareAndSwap(path, page("lost"), null)).toMatchObject({ ok: false, current });
    expect(await store.compareAndSwap(path, page("new"), current.version!)).toMatchObject({ ok: true });
    const stale = await store.compareAndSwap(path, page("lost"), current.version!);
    expect(stale).toMatchObject({ ok: false, current: { body: "new\n" } });
    expect((await store.read(path))!.body).toBe("new\n");
  });

  it("detects raw content edits even when mtime is restored", async () => {
    await store.write(path, page());
    const before = (await store.read(path))!;
    const absolute = join(store.root, path);
    await writeFile(absolute, (await readFile(absolute, "utf8")) + "\n<!-- manual edit -->\n");
    await utimes(absolute, new Date(before.updatedAt), new Date(before.updatedAt));
    const result = await store.compareAndSwap(path, page("lost"), before.version!);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.current!.body).toContain("manual edit");
  });

  it("serializes competing versions across separate store instances", async () => {
    await store.write(path, page());
    const version = (await store.read(path))!.version!;
    const other = new FileMemoryStore({ root: store.root });
    const results = await Promise.all([store.compareAndSwap(path, page("one"), version), other.compareAndSwap(path, page("two"), version)]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    const failed = results.find(r => !r.ok)!;
    expect(failed).toMatchObject({ ok: false, current: { version: (await store.read(path))!.version } });
  });

  it("serializes absent-page creation races", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      new FileMemoryStore({ root: store.root }).compareAndSwap(path, page(String(i)), null)));
    expect(results.filter(r => r.ok)).toHaveLength(1);
  });

  it("updates append-only facts under one lock without read-modify-write loss", async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => new FileMemoryStore({ root: store.root }).update(path, current =>
      page(`${current?.body ?? ""}fact-${i}\n`))));
    const body = (await store.read(path))!.body;
    for (let i = 0; i < 12; i++) expect(body.split("\n").filter(line => line === `fact-${i}`)).toHaveLength(1);
  });

  it("preserves concurrent index and log additions", async () => {
    await Promise.all(Array.from({ length: 12 }, async (_, i) => {
      const writer = new FileMemoryStore({ root: store.root });
      await writer.upsertIndex({ slug: `p${i}`, path: `concepts/p${i}.md`, type: "concept", status: "active", summary: `${i}` });
      await writer.appendLog(`entry-${i}`);
    }));
    expect(await store.index()).toHaveLength(12);
    const log = await readFile(join(store.root, "log.md"), "utf8");
    for (let i = 0; i < 12; i++) expect(log.split("\n").filter(line => line === `entry-${i}`)).toHaveLength(1);
  });

  it("enforces CAS and conserves index/log writes across actual processes", async () => {
    await store.write(path, page());
    const launch = (name: string) => {
      const child = fork(new URL("./fixtures/memory-writer.mjs", import.meta.url), [store.root, name], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
      let stderr = ""; child.stderr!.on("data", data => { stderr += data; });
      const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
      const ready = new Promise<void>((resolve, reject) => {
        child.once("message", () => resolve()); child.once("error", reject);
        child.once("exit", code => reject(new Error(`worker exited (${code}): ${stderr}`)));
      });
      const result = new Promise<MemoryWriteResult>((resolve, reject) => {
        child.on("message", message => {
          const value = message as { result?: MemoryWriteResult; error?: string };
          if (value.result !== undefined) resolve(value.result);
          if (value.error !== undefined) reject(new Error(value.error));
        });
        child.once("error", reject); child.once("exit", code => reject(new Error(`worker exited (${code}): ${stderr}`)));
      });
      // A spawn failure can reject the result while the test is still waiting for readiness.
      void result.catch(() => {});
      return { child, ready, result, exited };
    };
    const workers = [launch("first"), launch("second")];
    try {
      await Promise.all(workers.map(w => w.ready));
      for (const w of workers) w.child.send("write");
      expect((await Promise.all(workers.map(w => w.result))).filter(r => r.ok)).toHaveLength(1);
      expect((await store.index()).map(e => e.slug).sort()).toEqual(["first", "second"]);
      expect(await readFile(join(store.root, "log.md"), "utf8")).toMatch(/first|second/);
      for (const name of ["first", "second"]) expect(await readFile(join(store.root, "log.md"), "utf8")).toContain(name);
    } finally {
      for (const w of workers) if (w.child.exitCode === null) w.child.kill();
      await Promise.all(workers.map(w => w.exited));
    }
  });

  it("bounds lock waits even with a frozen content clock and never steals an old lock", async () => {
    const lock = `${store.root}.write.lock`;
    await writeFile(lock, "other owner");
    await utimes(lock, new Date(0), new Date(0));
    const blocked = new FileMemoryStore({ root: store.root, now: () => 0, lockTimeoutMs: 30 });
    await expect(blocked.write(path, page())).rejects.toThrow(/stop all writers/);
    expect(await readFile(lock, "utf8")).toBe("other owner");
    expect(await store.read(path)).toBeNull();
  });

  it("aborts while waiting and leaves another owner's lock intact", async () => {
    const lock = `${store.root}.write.lock`;
    await writeFile(lock, "owner");
    const signal = new AbortController();
    const work = store.compareAndSwap(path, page(), null, { signal: signal.signal });
    signal.abort();
    await expect(work).rejects.toMatchObject({ name: "AbortError" });
    expect(await readFile(lock, "utf8")).toBe("owner");
    expect(await store.read(path)).toBeNull();
  });

  it("releases a failed operation's lock", async () => {
    await expect(store.update(path, () => { throw new Error("transform failed"); })).rejects.toThrow("transform failed");
    expect(await store.compareAndSwap(path, page(), null)).toMatchObject({ ok: true });
  });

  it("releases its lock when writing the ownership marker fails", async () => {
    const realOpen = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open;
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await realOpen(...args);
      vi.spyOn(handle, "writeFile").mockRejectedValueOnce(new Error("marker write failed"));
      return handle;
    });
    await expect(store.write(path, page())).rejects.toThrow("marker write failed");
    expect(await store.compareAndSwap(path, page(), null)).toMatchObject({ ok: true });
  });

  it("does not remove a replacement lock owned by another process", async () => {
    await withMemoryLock(store.root, async () => {
      await rm(`${store.root}.write.lock`);
      await writeFile(`${store.root}.write.lock`, "new owner");
    });
    expect(await readFile(`${store.root}.write.lock`, "utf8")).toBe("new owner");
  });

  it("prevents a commit when cancellation arrives during the guarded transform", async () => {
    await store.write(path, page());
    const signal = new AbortController();
    await expect(store.update(path, () => { signal.abort(); return page("lost"); }, { signal: signal.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect((await store.read(path))!.body).toBe("original\n");
    expect(await store.compareAndSwap(path, page("retry"), (await store.read(path))!.version!)).toMatchObject({ ok: true });
  });

  it("does not treat a malformed existing page as absent", async () => {
    await writeFile(join(store.root, path), "not a wiki page");
    await expect(store.compareAndSwap(path, page("lost"), null)).rejects.toThrow();
    expect(await readFile(join(store.root, path), "utf8")).toBe("not a wiki page");
    const read = await tool("memory_read").execute({ path }, ctx());
    expect(read.isError).toBe(true); expect(read.display).toContain("cannot read");
  });

  it.skipIf(process.platform === "win32")("canonical root aliases share a lock", async () => {
    const alias = join(root, "alias"); await symlink(store.root, alias);
    await withMemoryLock(store.root, async () => {
      await expect(new FileMemoryStore({ root: alias, lockTimeoutMs: 20 }).write(path, page())).rejects.toThrow(/memory lock/);
    });
    expect(await store.read(path)).toBeNull();
  });

  it("keeps real reservations planned with claimants through structural dream", async () => {
    await Promise.all([store.reserve("unfilled", "session:a"), new FileMemoryStore({ root: store.root }).reserve("unfilled", "session:b")]);
    const result = await runDream({ wiki: store, raw: new FileRawStore({ root }), structuralOnly: true });
    try {
      expect(result.structural.unfilled).toContain("entities/unfilled.md");
      expect((await new FileMemoryStore({ root: result.outputRoot }).index()).find(e => e.slug === "unfilled"))
        .toMatchObject({ status: "planned", claimedBy: expect.arrayContaining(["session:a", "session:b"]) });
    } finally { await result.workspace.dispose(); }
  });

  it("returns read versions and current conflict content through the actual tools", async () => {
    const write = tool("memory_write");
    const input = { type: "concept", slug: "shared", body: "original", aliases: ["the auth thing"] };
    await write.execute(input, ctx());
    const read = await tool("memory_read").execute({ path }, ctx());
    expect(read.display).toMatch(/version: [a-f0-9]{64}/);
    const version = (read.output as { version: string }).version;
    await write.execute({ ...input, body: "new fact", if_version: version }, ctx());
    const stale = await write.execute({ ...input, body: "lost", if_version: version }, ctx());
    expect(stale.isError).toBe(true);
    expect(stale.display).toContain("new fact");
    expect(stale.output).toMatchObject({ conflict: true, current: { version: (await store.read(path))!.version } });
    expect((await store.index())[0]!.summary).toBe("new fact");
    expect((await tool("memory_search").execute({ query: "the auth thing" }, ctx())).display).toContain(path);
  });

  it("makes absent versions create-only for both replacement tools", async () => {
    for (const [name, input] of [["memory_write", { type: "concept", slug: "shared", body: "first" }],
      ["memory_file_analysis", { slug: "answer", body: "first" }]] as const) {
      const writer = tool(name);
      expect((await writer.execute(input, ctx())).isError).toBeUndefined();
      const stale = await writer.execute({ ...input, body: "overwrite" }, ctx());
      expect(stale.isError).toBe(true); expect(stale.display).toContain("first");
      const version = (stale.output as { version: string }).version;
      expect((await writer.execute({ ...input, body: "merged", if_version: version }, ctx())).isError).toBeUndefined();
    }
  });
});
