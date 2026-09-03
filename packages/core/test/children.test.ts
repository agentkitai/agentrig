import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("a log that cannot be parsed is reported on its node, not thrown at the prompt", async () => {
    const store = new SessionStore({ root });
    await writeFile(join(root, "torn.jsonl"), '{"seq":0,"sessionId":"torn","ts":1,"type":"session.start","ta', "utf8");
    const nodes = await liveChildren(store, [{ id: "torn", task: "t" }]);
    expect(nodes[0]!.status).toBeNull();
    expect(nodes[0]!.error).toMatch(/JSON|token|parse/i);
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
