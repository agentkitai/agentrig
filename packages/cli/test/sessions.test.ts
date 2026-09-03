import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@agentkitai/agentrig-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forkSession, forkSessionAt, renderSessionTree, replaySession, searchSessions, sessionTree } from "../src/sessions.ts";

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

    const tree = await sessionTree(store, grandchild);
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
    expect(lines.join("\n")).not.toContain("unrelated");
  });

  it("a plain session is its own root, with its forks as children", async () => {
    const store = new SessionStore({ root, newId: () => "kid" });
    await start(store, "solo", "alone");
    const kid = await forkSession(store, "solo", 0);
    const tree = await sessionTree(store, "solo");
    expect(tree.ancestry).toEqual(["solo"]);
    expect(renderSessionTree(tree, "solo")).toEqual(["solo  ← you are here", `└─ ${kid} (forked at seq 0)`]);
  });

  it("tolerates a parent whose log is gone rather than throwing at the prompt", async () => {
    const store = new SessionStore({ root });
    await store.append("orphan", { type: "session.fork", parent: "vanished", atSeq: 3 });
    const tree = await sessionTree(store, "orphan");
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
