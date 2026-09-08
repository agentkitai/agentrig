import { mkdir, mkdtemp, readFile, rename, rm, symlink } from "node:fs/promises";
import * as fs from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createAgent, RulePolicy, defaultRules, SessionStore, type ModelProvider } from "@agentkitai/agentrig-core";

vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>() }));

it("delivers the fake provider's first byte as a persisted stream event within one event-loop tick", async () => {
  const root = await mkdtemp(join(tmpdir(), "feel-stream-"));
  let tick = 0, firstByteTick: number | undefined, eventTick: number | undefined;
  let active = true;
  let timer: NodeJS.Immediate;
  const count = () => { if (active) { tick++; timer = setImmediate(count); } };
  timer = setImmediate(count);
  const provider: ModelProvider = {
    id: "fake", model: "feel", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 10_000 },
    async *stream() {
      firstByteTick = tick;
      yield { type: "text_delta", text: "first byte" };
      yield { type: "stop", reason: "end_turn" };
    },
  };
  const store = new SessionStore({ root });
  try {
    const agent = createAgent({ provider, tools: [], permissions: new RulePolicy(defaultRules), systemPrompt: "test", store, repoMap: false });
    const session = agent.run("stream the first byte", { cwd: root });
    for await (const event of session.events) {
      if (event.type === "model.delta" && eventTick === undefined) {
        eventTick = tick;
        // Observe disk at publication time, not merely after session completion.
        expect(fs.readFileSync(store.pathFor(session.id), "utf8")).toContain('"text":"first byte"');
      }
    }
    await session.done;
    expect(firstByteTick).toBeDefined();
    expect(eventTick).toBeDefined();
    expect(eventTick! - firstByteTick!).toBeLessThanOrEqual(1);
    const persisted = [];
    for await (const event of store.read(session.id)) persisted.push(event);
    expect(persisted.find(e => e.type === "model.delta")).toMatchObject({ text: "first byte" });
    expect(persisted.at(-1)).toMatchObject({ type: "session.end", reason: "done" });
  } finally {
    active = false; clearImmediate(timer); await rm(root, { recursive: true, force: true });
  }
});

it("creates a first-delta log and never advances its sequence past a failed stream append", async () => {
  const temp = await mkdtemp(join(tmpdir(), "feel-append-"));
  const store = new SessionStore({ root: join(temp, "new-root") });
  const id = store.create();
  try {
    expect(await store.append(id, { type: "model.delta", text: "first" })).toMatchObject({ seq: 0 });
    const path = store.pathFor(id), backup = `${path}.saved`;
    await rename(path, backup);
    await mkdir(path); // Deterministic write failure on all supported platforms, not chmod/root-dependent.
    await expect(store.append(id, { type: "model.delta", text: "must not commit" })).rejects.toThrow();
    await rm(path, { recursive: true });
    await rename(backup, path);
    expect(await store.append(id, { type: "model.delta", text: "second" })).toMatchObject({ seq: 1 });
    const text = await readFile(path, "utf8");
    expect(text).not.toContain("must not commit");
    const events = [];
    for await (const event of store.read(id)) events.push(event);
    expect(events).toMatchObject([{ seq: 0, text: "first" }, { seq: 1, text: "second" }]);
  } finally { await rm(temp, { recursive: true, force: true }); }
});


it("holds one descriptor per live session and closes it on release, without reopening replaced paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "feel-held-fd-"));
  const store = new SessionStore({ root });
  const id = store.create(), release = store.claim(id);
  const spy = vi.spyOn(fs, "appendFileSync");
  try {
    await store.append(id, { type: "model.delta", text: "first" });
    const path = store.pathFor(id), backup = `${path}.saved`;
    await rename(path, backup);
    await mkdir(path);
    await store.append(id, { type: "model.delta", text: "held inode" });
    const fd = spy.mock.calls.at(-1)?.[0];
    expect(typeof fd).toBe("number");
    expect(await readFile(backup, "utf8")).toContain("held inode");
    // Target the actual descriptor path: failed write cannot consume a sequence.
    spy.mockImplementationOnce(() => { throw new Error("injected fd write failure"); });
    await expect(store.append(id, { type: "model.delta", text: "not committed" })).rejects.toThrow("fd write failure");
    expect(await store.append(id, { type: "model.delta", text: "retry" })).toMatchObject({ seq: 2 });
    expect(spy.mock.calls.at(-1)?.[0]).toBe(fd);
    release();
    expect(() => fs.fstatSync(fd as number)).toThrow();
    expect(await readFile(backup, "utf8")).not.toContain("not committed");
    await rm(path, { recursive: true });
    await rename(backup, path);
    await store.append(id, { type: "model.delta", text: "unclaimed" });
    expect(spy.mock.calls).toHaveLength(3); // unclaimed append cannot enter synchronous fast path
  } finally { spy.mockRestore(); release(); await rm(root, { recursive: true, force: true }); }
});


it.skipIf(process.platform === "win32")("rejects a symlink log before writing outside the session store", async () => {
  const root = await mkdtemp(join(tmpdir(), "feel-symlink-"));
  const store = new SessionStore({ root });
  const id = store.create();
  const target = join(root, "unrelated.txt");
  await fs.promises.writeFile(target, "untouched");
  await symlink(target, store.pathFor(id));
  try {
    await expect(store.append(id, { type: "model.delta", text: "no authority" })).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("untouched");
    await rm(store.pathFor(id));
    expect(await store.append(id, { type: "model.delta", text: "retry" })).toMatchObject({ seq: 0 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("resume lock owns and releases a descriptor and stale claim release cannot close a new owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "feel-resume-fd-"));
  const store = new SessionStore({ root });
  const id = store.create();
  const spy = vi.spyOn(fs, "appendFileSync");
  try {
    const release = store.claim(id);
    await store.append(id, { type: "model.delta", text: "init" });
    release();
    const unlock = await store.acquireLock(id);
    await store.append(id, { type: "model.delta", text: "resume init" });
    release(); // must not affect the new lifecycle
    await store.append(id, { type: "model.delta", text: "resumed" });
    const fd = spy.mock.calls.at(-1)?.[0];
    expect(typeof fd).toBe("number");
    await unlock();
    expect(() => fs.fstatSync(fd as number)).toThrow();
  } finally { spy.mockRestore(); await rm(root, { recursive: true, force: true }); }
});


it.each([true, false])("overlapping claim and lock close only after both owners release (lock first=%s)", async lockFirst => {
  const root = await mkdtemp(join(tmpdir(), "feel-two-owners-"));
  const store = new SessionStore({ root });
  const id = store.create(), release = store.claim(id), unlock = await store.acquireLock(id);
  const spy = vi.spyOn(fs, "appendFileSync");
  try {
    await store.append(id, { type: "model.delta", text: "init" });
    await store.append(id, { type: "model.delta", text: "owned" });
    const fd = spy.mock.calls.at(-1)?.[0];
    expect(typeof fd).toBe("number");
    if (lockFirst) await unlock(); else release();
    expect(fs.fstatSync(fd as number).isFile()).toBe(true);
    await store.append(id, { type: "model.delta", text: "remaining owner" });
    expect(spy.mock.calls.at(-1)?.[0]).toBe(fd);
    if (lockFirst) release(); else await unlock();
    expect(() => fs.fstatSync(fd as number)).toThrow();
  } finally { spy.mockRestore(); release(); await unlock(); await rm(root, { recursive: true, force: true }); }
});

// Probe once without creating a FIFO. A nonzero usage exit still means the tool
// exists; only ENOENT is an optional-tool skip, not permission or runtime failures.
const fifoProbe = process.platform === "win32" ? undefined : spawnSync("mkfifo", [], { stdio: "ignore" });
if (fifoProbe?.error && (fifoProbe.error as NodeJS.ErrnoException).code !== "ENOENT") throw fifoProbe.error;
const hasMkfifo = process.platform !== "win32" && !fifoProbe?.error;

it.skipIf(!hasMkfifo)("rejects a FIFO with an attached reader without leaking session bytes or consuming seq", async () => {
  const root = await mkdtemp(join(tmpdir(), "feel-fifo-"));
  const store = new SessionStore({ root });
  const id = store.create(), path = store.pathFor(id);
  let reader: number | undefined;
  try {
    execFileSync("mkfifo", [path]);
    // Without the reader open(O_WRONLY|O_NONBLOCK) rejects ENXIO before isFile runs.
    reader = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    await expect(store.append(id, { type: "model.delta", text: "private session bytes" }))
      .rejects.toThrow("session log must be a regular file");
    expect(fs.readSync(reader, Buffer.alloc(4096), 0, 4096, null)).toBe(0);
    fs.closeSync(reader); reader = undefined;
    await rm(path);
    expect(await store.append(id, { type: "model.delta", text: "regular retry" })).toMatchObject({ seq: 0 });
    expect(await readFile(path, "utf8")).not.toContain("private session bytes");
  } finally {
    if (reader !== undefined) fs.closeSync(reader);
    await rm(root, { recursive: true, force: true });
  }
});
