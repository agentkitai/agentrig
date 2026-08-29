import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertSessionId, isValidSessionId, SessionStore, contentHash } from "@agentkitai/agentrig-core";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "harness-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("SessionStore", () => {
  it("stamps seq in order and replays identically", async () => {
    let t = 1000;
    const store = new SessionStore({ root, now: () => t++, newId: () => "s1" });
    const id = store.create();
    await store.append(id, { type: "session.start", task: "hello", cwd: "/w", provider: "fake", model: "m" });
    await store.append(id, { type: "turn.start", n: 1 });
    await store.append(id, { type: "tool.call", id: "t1", name: "bash", input: { cmd: "ls" }, inputHash: contentHash({ cmd: "ls" }) });
    await store.append(id, { type: "session.end", reason: "done" });

    const events = await store.readAll(id);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(events.map((e) => e.ts)).toEqual([1000, 1001, 1002, 1003]);
    expect(events[2]).toMatchObject({ type: "tool.call", sessionId: "s1", name: "bash" });
  });

  it("recovers seq from disk when a new store instance resumes a session", async () => {
    const a = new SessionStore({ root, newId: () => "s2" });
    const id = a.create();
    await a.append(id, { type: "turn.start", n: 1 });
    await a.append(id, { type: "turn.end", n: 1 });

    const b = new SessionStore({ root });
    const resumed = await b.append(id, { type: "turn.start", n: 2 });
    expect(resumed.seq).toBe(2);
  });

  it("lists sessions newest first", async () => {
    let t = 0;
    const store = new SessionStore({ root, now: () => t++ });
    const first = store.create();
    await store.append(first, { type: "turn.start", n: 1 });
    await new Promise((r) => setTimeout(r, 10));
    const second = store.create();
    await store.append(second, { type: "turn.start", n: 1 });
    const refs = await store.list();
    expect(refs.map((r) => r.id)).toEqual([second, first]);
  });

  it("fails loudly on a gap in seq", async () => {
    const store = new SessionStore({ root, newId: () => "s3" });
    const id = store.create();
    await store.append(id, { type: "turn.start", n: 1 });
    const { appendFile } = await import("node:fs/promises");
    await appendFile(store.pathFor(id), JSON.stringify({ seq: 5, sessionId: id, ts: 1, type: "turn.end", n: 1 }) + "\n");
    await expect(store.readAll(id)).rejects.toThrow(/expected seq 1, got 5/);
  });
});

describe("snapshots", () => {
  it("round-trips a snapshot and returns null when none exists", async () => {
    const store = new SessionStore({ root });
    expect(await store.readSnapshot("nope")).toBe(null);
    const snapshot = {
      sessionId: "s9",
      task: "do things",
      cwd: "/w",
      turns: 3,
      usage: { input: 100, output: 50 },
      messages: [
        { role: "user" as const, content: [{ type: "text" as const, text: "do things" }] },
        {
          role: "assistant" as const,
          content: [{ type: "tool_use" as const, id: "t1", name: "bash", input: { command: "ls" } }],
        },
        {
          role: "user" as const,
          content: [{ type: "tool_result" as const, toolUseId: "t1", content: "a.txt", isError: false }],
        },
      ],
      ts: 1234,
    };
    await store.writeSnapshot(snapshot);
    expect(await store.readSnapshot("s9")).toEqual(snapshot);
  });

  it("advisory lock: second acquire fails until released", async () => {
    const store = new SessionStore({ root });
    const release = await store.acquireLock("s11");
    await expect(store.acquireLock("s11")).rejects.toThrow(/locked by another process/);
    await release();
    const again = await store.acquireLock("s11");
    await again();
  });

  it("keeps snapshots out of the session listing", async () => {
    const store = new SessionStore({ root, newId: () => "s10" });
    const id = store.create();
    await store.append(id, { type: "turn.start", n: 1 });
    await store.writeSnapshot({ sessionId: id, task: "t", cwd: "/w", turns: 1, usage: { input: 0, output: 0 }, messages: [], ts: 1 });
    const refs = await store.list();
    expect(refs.map((r) => r.id)).toEqual(["s10"]);
  });
});

describe("contentHash", () => {
  it("is stable for equal inputs and differs otherwise", () => {
    expect(contentHash({ a: 1 })).toBe(contentHash({ a: 1 }));
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
    expect(contentHash("x")).toHaveLength(16);
  });
});

describe("session ids cannot escape the sessions directory", () => {
  it("rejects traversal, separators and empties", () => {
    for (const bad of [
      "../../etc/passwd",
      "../escape",
      "a/b",
      "a\\b",
      "",
      ".",
      "..",
      "with space",
      "x".repeat(129),
    ]) {
      expect(isValidSessionId(bad)).toBe(false);
      expect(() => assertSessionId(bad)).toThrow(/invalid session id/);
    }
  });

  it("accepts what create() produces, and ordinary ids", () => {
    for (const good of ["a1b2c3d4", "session_1", "my-session", "A".repeat(128)]) {
      expect(isValidSessionId(good)).toBe(true);
    }
  });

  it("every path builder refuses a traversing id", async () => {
    const store = new SessionStore({ root });
    expect(() => store.pathFor("../evil")).toThrow(/invalid session id/);
    expect(() => store.snapshotPathFor("../evil")).toThrow(/invalid session id/);
    expect(() => store.lockPathFor("../evil")).toThrow(/invalid session id/);
  });
});
