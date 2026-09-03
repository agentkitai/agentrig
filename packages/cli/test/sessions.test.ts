import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, type ChildNode } from "@agentkitai/agentrig-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  forkSession, forkSessionAt, formatElapsed, renderChildLine, renderChildren, renderSessionTree, replaySession, searchSessions,
} from "../src/sessions.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentrig-cli-sessions-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function start(store: SessionStore, id: string, task: string): Promise<void> {
  await store.append(id, { type: "session.start", task, cwd: "/work", provider: "fake", model: "m" });
}

describe("session CLI operations", () => {
  it("forks at an explicit sequence and defaults to the latest physical event", async () => {
    const ids = ["explicit", "latest"];
    const store = new SessionStore({ root, newId: () => ids.shift() ?? "unexpected" });
    await start(store, "parent", "begin");
    await store.append("parent", { type: "model.delta", text: "middle" });
    await store.append("parent", { type: "model.response", usage: { input: 1, output: 1 }, stop: "end_turn" });

    const explicit = await forkSession(store, "parent", 1);
    const latest = await forkSession(store, "parent");

    expect(await store.readAll(explicit)).toMatchObject([
      { type: "session.fork", parent: "parent", atSeq: 1 },
    ]);
    expect(await store.readAll(latest)).toMatchObject([
      { type: "session.fork", parent: "parent", atSeq: 2 },
    ]);
  });

  it("replays materialized ancestry and --until addresses the named session's own log", async () => {
    const store = new SessionStore({ root, newId: () => "child" });
    await start(store, "parent", "ancestor task");
    await store.append("parent", { type: "model.delta", text: "parent answer" });
    const child = await forkSession(store, "parent", 1);
    await store.append(child, { type: "model.delta", text: "child continuation" });

    const throughFork = await replaySession(store, child, 0);
    const complete = await replaySession(store, child);

    expect(throughFork.join("\n")).toContain("ancestor task");
    expect(throughFork.join("\n")).toContain("fork");
    expect(throughFork.join("\n")).not.toContain("child continuation");
    expect(complete.join("\n")).toContain("child continuation");
  });

  it("searches rendered materialized transcripts with the memory BM25 scorer", async () => {
    const store = new SessionStore({ root });
    await start(store, "alpha", "diagnose quasar telemetry");
    await start(store, "beta", "refactor payment retries");

    const hits = await searchSessions(store, "quasar telemetry");

    expect(hits[0]).toMatchObject({ id: "alpha" });
    expect(hits[0]!.score).toBeGreaterThan(0);
    expect(hits[0]!.snippet).toMatch(/quasar/i);
    expect(hits.map((hit) => hit.id)).not.toContain("beta");
  });

  it("searches a fork through matching content found only in its materialized parent prefix", async () => {
    const store = new SessionStore({ root, newId: () => "child" });
    await start(store, "parent", "investigate inherited pulsar signature");
    const child = await forkSession(store, "parent", 0);
    await store.append(child, { type: "model.delta", text: "unrelated continuation" });

    const hits = await searchSessions(store, "inherited pulsar signature");

    expect(hits.map((hit) => hit.id)).toContain(child);
  });

  it("rejects a default fork of an empty session instead of inventing sequence zero", async () => {
    const store = new SessionStore({ root });
    await writeFile(store.pathFor("empty"), "", "utf8");
    await expect(forkSession(store, "empty")).rejects.toThrow(/empty session/);
  });
});

describe("session tree (R3c)", () => {


  it("walks ancestry up through fork markers and descendants down through every log's first event", async () => {
    const ids = ["child", "grandchild", "sibling"];
    const store = new SessionStore({ root, newId: () => ids.shift() ?? "unexpected" });
    await start(store, "rootsess", "the beginning");
    await store.append("rootsess", { type: "model.delta", text: "a" });
    await store.append("rootsess", { type: "model.delta", text: "b" });
    const child = await forkSession(store, "rootsess", 1);
    await store.append(child, { type: "model.delta", text: "c" });
    const grandchild = await forkSession(store, child, 1);
    const sibling = await forkSession(store, "rootsess", 2);
    await start(store, "unrelated", "elsewhere");

    const tree = await store.tree(grandchild);
    expect(tree.ancestry).toEqual(["rootsess", child, grandchild]);
    expect(tree.missing).toEqual([]);
    expect(tree.root).toEqual({
      id: "rootsess",
      children: [
        { id: child, atSeq: 1, children: [{ id: grandchild, atSeq: 1, children: [] }] },
        { id: sibling, atSeq: 2, children: [] },
      ],
    });

    const lines = renderSessionTree(tree, grandchild);
    expect(lines).toEqual([
      "rootsess",
      `├─ ${child} (forked at seq 1)`,
      `│  └─ ${grandchild} (forked at seq 1)  ← you are here`,
      `└─ ${sibling} (forked at seq 2)`,
    ]);
    // the plain session is a root of its own, not a stray leaf of this tree
    expect((await store.tree("unrelated")).ancestry).toEqual(["unrelated"]);
  });

  it("one unreadable log in the directory is skipped and named, not fatal for every /tree", async () => {
    const store = new SessionStore({ root, newId: () => "kid" });
    await start(store, "good", "fine");
    const kid = await forkSession(store, "good", 0);
    await writeFile(join(root, "bad.jsonl"), "this is not json\n", "utf8");
    await writeFile(join(root, "empty.jsonl"), "", "utf8");

    const tree = await store.tree("good");
    expect(tree.unreadable).toEqual(["bad"]);
    expect(tree.root.children.map((c) => c.id)).toEqual([kid]);
    expect(renderSessionTree(tree, "good").at(-1)).toBe("(skipped 1 unreadable log(s): bad)");

    // the named session itself must still parse: its corruption is the caller's error
    await expect(store.tree("bad")).rejects.toThrow();
  });

  it("terminates on a marker that names itself, and on two markers naming each other", async () => {
    const store = new SessionStore({ root });
    await store.append("loop", { type: "session.fork", parent: "loop", atSeq: 0 });
    const self = await store.tree("loop");
    expect(self.ancestry).toEqual(["loop"]);
    expect(self.root).toEqual({ id: "loop", children: [] });
    expect(renderSessionTree(self, "loop")).toEqual(["loop  ← you are here"]);

    await store.append("a", { type: "session.fork", parent: "b", atSeq: 0 });
    await store.append("b", { type: "session.fork", parent: "a", atSeq: 0 });
    const cycle = await store.tree("a");
    expect(cycle.ancestry).toEqual(["b", "a"]);
    expect(cycle.root).toEqual({ id: "b", children: [{ id: "a", atSeq: 0, children: [] }] });
    expect(renderSessionTree(cycle, "a").filter((l) => l.includes("you are here"))).toHaveLength(1);
  });

  it("a plain session is its own root, with its forks as children", async () => {
    const store = new SessionStore({ root, newId: () => "kid" });
    await start(store, "solo", "alone");
    const kid = await forkSession(store, "solo", 0);
    const tree = await store.tree("solo");
    expect(tree.ancestry).toEqual(["solo"]);
    expect(renderSessionTree(tree, "solo")).toEqual(["solo  ← you are here", `└─ ${kid} (forked at seq 0)`]);
  });

  it("tolerates a parent whose log is gone rather than throwing at the prompt", async () => {
    const store = new SessionStore({ root });
    await store.append("orphan", { type: "session.fork", parent: "vanished", atSeq: 3 });
    const tree = await store.tree("orphan");
    expect(tree.ancestry).toEqual(["vanished", "orphan"]);
    expect(tree.missing).toEqual(["vanished"]);
    expect(renderSessionTree(tree, "orphan")).toEqual([
      "vanished (log missing)",
      "└─ orphan (forked at seq 3)  ← you are here",
    ]);
  });

  it("forkSessionAt reports the sequence it resolved", async () => {
    const store = new SessionStore({ root, newId: () => "f" });
    await start(store, "p", "x");
    await store.append("p", { type: "model.delta", text: "y" });
    expect(await forkSessionAt(store, "p")).toEqual({ id: "f", atSeq: 1 });
  });
});

describe("children rendering (R3d)", () => {
  it("formatElapsed floors and never overstates", () => {
    expect(formatElapsed(999)).toBe("0s");
    expect(formatElapsed(12_400)).toBe("12s");
    expect(formatElapsed(65_000)).toBe("1m05s");
    expect(formatElapsed(3_600_000 + 5 * 60_000)).toBe("1h05m");
    expect(formatElapsed(-5)).toBe("0s");
  });

  const running: ChildNode = {
    id: "c1",
    task: "review the diff",
    status: {
      id: "c1", task: "review the diff", startedAt: 100_000, lastTs: 160_000, turns: 3,
      tool: { name: "bash", sinceTs: 148_000 }, plan: "write findings", ended: null, children: [],
    },
    children: [],
  };

  it("a running child shows turn, current tool, latest plan item and elapsed time", () => {
    expect(renderChildLine(running, 160_000)).toBe("c1 · review the diff · turn 3 · bash 12s · plan: write findings · 1m00s");
    const thinking = { ...running, status: { ...running.status!, tool: null, plan: null } };
    expect(renderChildLine(thinking, 160_000)).toBe("c1 · review the diff · turn 3 · thinking · 1m00s");
  });

  it("a finished child shows the parent's subagent.end reason and how long it took", () => {
    const done = { ...running, reason: "budget", status: { ...running.status!, ended: { reason: "budget", ts: 190_000 } } };
    expect(renderChildLine(done, 999_999)).toBe("c1 · review the diff · budget after 3 turn(s) · 1m30s");
    // the parent's reason wins over the child's own session.end when they disagree (an abort the
    // child recorded as its own reason is still "aborted" to the parent)
    const disagree = { ...done, reason: "aborted" };
    expect(renderChildLine(disagree, 0)).toContain("aborted after 3 turn(s)");
  });

  it("a child with no log yet, an unreadable one, and one that ended before writing are each named", () => {
    expect(renderChildLine({ id: "c2", task: "t", status: null, children: [] }, 0)).toBe("c2 · t · starting");
    expect(renderChildLine({ id: "c2", task: "t", status: null, reason: "error", children: [] }, 0))
      .toBe("c2 · t · error before writing a log");
    expect(renderChildLine({ id: "c3", task: "t", status: null, error: "Unexpected token", children: [] }, 0))
      .toBe("c3 · t · log unreadable (Unexpected token)");
    expect(renderChildLine({ id: "../x", task: "t", status: null, invalid: true, error: "not a session id", children: [] }, 0))
      .toBe("../x · t · invalid id (a spawn record that names no session)");
    // a torn tail still shows everything the log said before it
    expect(renderChildLine({ ...running, torn: true }, 160_000))
      .toBe("c1 · review the diff · turn 3 · bash 12s · plan: write findings · 1m00s · log still being written");
  });

  it("renders nested children as an indented tree — /tree with live state", () => {
    const grand: ChildNode = { ...running, id: "g1", task: "grandchild", children: [] };
    const lines = renderChildren([{ ...running, children: [grand] }, { ...running, id: "c2", task: "second" }], 160_000);
    expect(lines).toEqual([
      "c1 · review the diff · turn 3 · bash 12s · plan: write findings · 1m00s",
      "└─ g1 · grandchild · turn 3 · bash 12s · plan: write findings · 1m00s",
      "c2 · second · turn 3 · bash 12s · plan: write findings · 1m00s",
    ]);
  });
});
