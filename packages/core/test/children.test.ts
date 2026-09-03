import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { liveChildren, SessionStore, summarizeSession, type HarnessEvent } from "@agentkitai/agentrig-core";

/**
 * R3d: a child's live state is read from its own log, never copied into the parent's. These pin
 * the fold (which turn, which tool, which plan item, how it ended) and the read-only tree walk.
 */

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentrig-children-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

let seq = 0;
const ev = (payload: Record<string, unknown>, ts = 1_000 + seq * 100): HarnessEvent =>
  ({ seq: seq++, sessionId: "c", ts, ...payload }) as HarnessEvent;

beforeEach(() => {
  seq = 0;
});

describe("summarizeSession", () => {
  it("reports the turn, the open tool, the plan item in progress and no end while a child runs", () => {
    const s = summarizeSession("c", [
      ev({ type: "session.start", task: "review the diff", cwd: "/w", provider: "p", model: "m" }),
      ev({ type: "turn.start", n: 1 }),
      ev({ type: "plan.updated", items: [
        { id: "a", text: "read files", status: "done" },
        { id: "b", text: "write findings", status: "in_progress" },
        { id: "c", text: "report", status: "pending" },
      ] }),
      ev({ type: "tool.call", id: "t1", name: "bash", input: {}, inputHash: "h" }),
      ev({ type: "tool.result", id: "t1", ok: true, display: "", durationMs: 1 }),
      ev({ type: "turn.end", n: 1 }),
      ev({ type: "turn.start", n: 2 }),
      ev({ type: "tool.call", id: "t2", name: "read_file", input: {}, inputHash: "h" }, 9_000),
    ]);
    expect(s).toMatchObject({
      id: "c",
      task: "review the diff",
      startedAt: 1_000,
      lastTs: 9_000,
      turns: 2,
      tool: { name: "read_file", sinceTs: 9_000 },
      plan: "write findings",
      ended: null,
      children: [],
    });
  });

  it("a tool.result closes the open call: a child thinking after bash is not 'in bash'", () => {
    const base = [
      ev({ type: "session.start", task: "t", cwd: "/w", provider: "p", model: "m" }),
      ev({ type: "turn.start", n: 1 }),
      ev({ type: "tool.call", id: "t1", name: "bash", input: {}, inputHash: "h" }),
    ];
    expect(summarizeSession("c", base).tool).toEqual({ name: "bash", sinceTs: expect.any(Number) });
    const closed = [...base, ev({ type: "tool.result", id: "t1", ok: true, display: "", durationMs: 1 })];
    expect(summarizeSession("c", closed).tool).toBeNull();
    const again = [
      ...closed,
      ev({ type: "turn.end", n: 1 }),
      ev({ type: "turn.start", n: 2 }),
      ev({ type: "tool.call", id: "t2", name: "read_file", input: {}, inputHash: "h" }),
      ev({ type: "tool.result", id: "t2", ok: false, display: "", durationMs: 1 }),
    ];
    expect(summarizeSession("c", again).tool).toBeNull();
    expect(summarizeSession("c", again).turns).toBe(2);
  });

  it("a denied call is not still open, and the first pending item stands in when none is in progress", () => {
    const s = summarizeSession("c", [
      ev({ type: "session.start", task: "t", cwd: "/w", provider: "p", model: "m" }),
      ev({ type: "turn.start", n: 1 }),
      ev({ type: "plan.updated", items: [
        { id: "a", text: "first", status: "done" },
        { id: "b", text: "next up", status: "pending" },
      ] }),
      ev({ type: "tool.call", id: "t1", name: "write_file", input: {}, inputHash: "h" }),
      ev({ type: "tool.denied", id: "t1", name: "write_file" }),
    ]);
    expect(s.tool).toBeNull();
    expect(s.plan).toBe("next up");
  });

  it("records how the child ended, and its own children with their end reasons", () => {
    const s = summarizeSession("c", [
      ev({ type: "session.start", task: "t", cwd: "/w", provider: "p", model: "m" }),
      ev({ type: "turn.start", n: 1 }),
      ev({ type: "subagent.spawn", id: "g1", task: "grandchild one" }),
      ev({ type: "subagent.spawn", id: "g2", task: "grandchild two" }),
      ev({ type: "subagent.end", id: "g1", reason: "done" }),
      ev({ type: "tool.call", id: "t1", name: "bash", input: {}, inputHash: "h" }),
      ev({ type: "session.end", reason: "budget" }, 5_000),
    ]);
    expect(s.ended).toEqual({ reason: "budget", ts: 5_000 });
    // a session that ended has nothing in progress, whatever was left open
    expect(s.tool).toBeNull();
    expect(s.children).toEqual([
      { id: "g1", task: "grandchild one", reason: "done" },
      { id: "g2", task: "grandchild two" },
    ]);
  });

  it("an empty log is a child that has not started", () => {
    expect(summarizeSession("c", [])).toMatchObject({ startedAt: null, lastTs: null, turns: 0, tool: null, ended: null });
  });
});

describe("liveChildren", () => {
  const start = (store: SessionStore, id: string, task: string) =>
    store.append(id, { type: "session.start", task, cwd: "/w", provider: "p", model: "m" });

  it("reads each child's own log and follows its spawn records to grandchildren, writing nothing", async () => {
    const store = new SessionStore({ root });
    await start(store, "child", "child task");
    await store.append("child", { type: "turn.start", n: 1 });
    await store.append("child", { type: "subagent.spawn", id: "grand", task: "grand task" });
    await start(store, "grand", "grand task");
    await store.append("grand", { type: "turn.start", n: 3 });
    const before = await store.list();

    const nodes = await liveChildren(store, [{ id: "child", task: "child label" }, { id: "unborn", task: "not yet" }]);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({
      id: "child",
      task: "child label",
      status: { turns: 1, task: "child task" },
      children: [{ id: "grand", task: "grand task", status: { turns: 3 }, children: [] }],
    });
    // a child whose log does not exist yet is "starting", not an error
    expect(nodes[1]).toMatchObject({ id: "unborn", status: null, children: [] });
    expect(nodes[1]!.error).toBeUndefined();
    // read-only: the same logs, the same sizes
    expect(await store.list()).toEqual(before);
  });

  it("a torn last line keeps every line before it and is flagged; a corrupt terminated line is an error", async () => {
    const store = new SessionStore({ root });
    await start(store, "torn", "still writing");
    await store.append("torn", { type: "turn.start", n: 2 });
    await appendFile(join(root, "torn.jsonl"), '{"seq":2,"sessionId":"torn","ts":1,"type":"tool.result","id":"t","ok":true,"display":"a very long', "utf8");
    const [node] = await liveChildren(store, [{ id: "torn", task: "t" }]);
    expect(node!.error).toBeUndefined();
    expect(node!.torn).toBe(true);
    expect(node!.status).toMatchObject({ task: "still writing", turns: 2 });

    await writeFile(join(root, "corrupt.jsonl"), 'this is not json\n{"seq":1}\n', "utf8");
    const [bad] = await liveChildren(store, [{ id: "corrupt", task: "t" }]);
    expect(bad!.status).toBeNull();
    expect(bad!.torn).toBeUndefined();
    expect(bad!.error).toMatch(/JSON|token|parse/i);
  });

  it("readPrefix rejects a seq gap even with a torn tail, and reads a clean log whole", async () => {
    const store = new SessionStore({ root });
    await start(store, "clean", "t");
    await store.append("clean", { type: "turn.start", n: 1 });
    expect(await store.readPrefix("clean")).toMatchObject({ torn: false, events: [{ seq: 0 }, { seq: 1 }] });
    await writeFile(join(root, "gap.jsonl"), '{"seq":0,"sessionId":"gap","ts":1,"type":"turn.start","n":1}\n{"seq":5,"sessionId":"gap","ts":1,"type":"turn.start","n":2}\n{"seq":6,"sess', "utf8");
    await expect(store.readPrefix("gap")).rejects.toThrow(/expected seq 1, got 5/);
  });

  it("a child claiming the parent or a sibling as its own child does not pull them under itself", async () => {
    const store = new SessionStore({ root });
    await start(store, "parent", "p");
    await start(store, "kid", "k");
    await store.append("kid", { type: "subagent.spawn", id: "parent", task: "forged parent" });
    await store.append("kid", { type: "subagent.spawn", id: "sib", task: "forged sibling" });
    await store.append("kid", { type: "subagent.spawn", id: "real-grand", task: "real" });
    await start(store, "sib", "s");
    await start(store, "real-grand", "g");
    const nodes = await liveChildren(store, [{ id: "kid", task: "k" }, { id: "sib", task: "s" }], { parent: "parent" });
    expect(nodes.map((n) => n.id)).toEqual(["kid", "sib"]);
    expect(nodes[0]!.children.map((n) => n.id)).toEqual(["real-grand"]);
    expect(nodes[1]!.children).toEqual([]);
  });

  it("a record in one branch cannot pull a session of the same depth out of another branch", async () => {
    const store = new SessionStore({ root });
    for (const [id, task] of [["kid1", "k1"], ["kid2", "k2"], ["g1", "g1"], ["g2", "g2"]] as const) await start(store, id, task);
    await store.append("kid1", { type: "subagent.spawn", id: "g1", task: "g1" });
    await store.append("kid2", { type: "subagent.spawn", id: "g2", task: "g2" });
    await store.append("g1", { type: "subagent.spawn", id: "g2", task: "forged" });
    const nodes = await liveChildren(store, [{ id: "kid1", task: "k1" }, { id: "kid2", task: "k2" }], { parent: "parent" });
    expect(nodes[0]!.children.map((n) => n.id)).toEqual(["g1"]);
    expect(nodes[0]!.children[0]!.children).toEqual([]);
    expect(nodes[1]!.children.map((n) => n.id)).toEqual(["g2"]);
  });

  it("a grandchild cannot claim its own sibling grandchild", async () => {
    const store = new SessionStore({ root });
    for (const id of ["kid", "g", "g2"]) await start(store, id, id);
    await store.append("kid", { type: "subagent.spawn", id: "g", task: "g" });
    await store.append("kid", { type: "subagent.spawn", id: "g2", task: "g2" });
    await store.append("g", { type: "subagent.spawn", id: "g2", task: "forged sibling" });
    const nodes = await liveChildren(store, [{ id: "kid", task: "kid" }]);
    expect(nodes[0]!.children.map((n) => n.id)).toEqual(["g", "g2"]);
    expect(nodes[0]!.children[0]!.children).toEqual([]);
    expect(nodes[0]!.children[1]!.task).toBe("g2");
  });

  it("an id that is not a session id is marked invalid rather than read", async () => {
    const store = new SessionStore({ root });
    const [node] = await liveChildren(store, [{ id: "../../etc/passwd", task: "t" }]);
    expect(node).toMatchObject({ invalid: true, status: null, error: "not a session id" });
  });

  it("a spawn record that loops back is visited once", async () => {
    const store = new SessionStore({ root });
    await start(store, "a", "a");
    await store.append("a", { type: "subagent.spawn", id: "b", task: "b" });
    await start(store, "b", "b");
    await store.append("b", { type: "subagent.spawn", id: "a", task: "a again" });
    const nodes = await liveChildren(store, [{ id: "a", task: "a" }]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.children.map((n) => n.id)).toEqual(["b"]);
    expect(nodes[0]!.children[0]!.children).toEqual([]);
  });
});
