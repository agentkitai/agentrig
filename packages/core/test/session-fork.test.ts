import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contentHash, SessionStore, type AnyTool } from "@agentkitai/agentrig-core";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentrig-fork-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const hashFile = async (path: string): Promise<string> =>
  createHash("sha256").update(await readFile(path)).digest("hex");

describe("session forks", () => {
  it("opens a child with session.fork and materializes the parent prefix before child events", async () => {
    const ids = ["parent", "child"];
    const store = new SessionStore({ root, newId: () => ids.shift() ?? "unexpected" });
    const parent = store.create();
    await store.append(parent, { type: "session.start", task: "inspect", cwd: "/w", provider: "fake", model: "m" });
    await store.append(parent, { type: "model.delta", text: "calling" });
    await store.append(parent, { type: "model.response", usage: { input: 1, output: 1 }, stop: "tool_use" });
    await store.append(parent, {
      type: "tool.call", id: "t1", name: "counter", input: {}, inputHash: contentHash({}),
    });
    await store.append(parent, { type: "tool.result", id: "t1", ok: true, display: "recorded", durationMs: 1 });
    const expectedAtFork = await store.materializeMessages(parent, 4);
    await store.append(parent, { type: "model.delta", text: "must not leak" });
    await store.append(parent, { type: "model.response", usage: { input: 1, output: 1 }, stop: "end_turn" });

    const parentHash = await hashFile(store.pathFor(parent));
    const child = await store.fork(parent, 4);

    expect(child).toBe("child");
    expect(await store.readAll(child)).toMatchObject([
      { seq: 0, sessionId: "child", type: "session.fork", parent: "parent", atSeq: 4 },
    ]);
    expect(await store.materializeMessages(child)).toEqual(expectedAtFork);
    expect(await hashFile(store.pathFor(parent))).toBe(parentHash);

    await store.append(child, { type: "model.delta", text: "continued" });
    await store.append(child, { type: "model.response", usage: { input: 1, output: 1 }, stop: "end_turn" });
    expect(await store.materializeMessages(child)).toEqual([
      { role: "user", content: [{ type: "text", text: "inspect" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "calling" },
          { type: "tool_use", id: "t1", name: "counter", input: {} },
        ],
      },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "recorded" }] },
      { role: "assistant", content: [{ type: "text", text: "continued" }] },
    ]);
  });

  it("materializes a fork of a fork through both recorded prefixes", async () => {
    const ids = ["parent", "child", "grandchild"];
    const store = new SessionStore({ root, newId: () => ids.shift() ?? "unexpected" });
    const parent = store.create();
    await store.append(parent, { type: "session.start", task: "root", cwd: "/w", provider: "fake", model: "m" });
    await store.append(parent, { type: "model.delta", text: "parent" });
    await store.append(parent, { type: "model.response", usage: { input: 1, output: 1 }, stop: "end_turn" });

    const child = await store.fork(parent, 2);
    await store.append(child, { type: "model.delta", text: "child" });
    await store.append(child, { type: "model.response", usage: { input: 1, output: 1 }, stop: "end_turn" });
    const expected = await store.materializeMessages(child, 2);

    const grandchild = await store.fork(child, 2);
    expect(await store.materializeMessages(grandchild)).toEqual(expected);
  });

  it("uses recorded tool results without executing the fixture tool during materialization", async () => {
    let calls = 0;
    const counter: AnyTool = {
      name: "counter",
      description: "count executions",
      inputSchema: z.object({}),
      permission: "read",
      execute: async () => {
        calls += 1;
        return { output: "recorded", display: "recorded" };
      },
    };
    const store = new SessionStore({ root, newId: (() => {
      const ids = ["parent", "child"];
      return () => ids.shift() ?? "unexpected";
    })() });
    const parent = store.create();
    await store.append(parent, { type: "session.start", task: "run", cwd: "/w", provider: "fake", model: "m" });
    await store.append(parent, { type: "model.response", usage: { input: 1, output: 1 }, stop: "tool_use" });
    await store.append(parent, { type: "tool.call", id: "t1", name: counter.name, input: {}, inputHash: contentHash({}) });
    const result = await counter.execute({}, {
      signal: new AbortController().signal,
      cwd: root,
      sessionId: parent,
      emit: () => {},
    });
    await store.append(parent, { type: "tool.result", id: "t1", ok: true, display: result.display, durationMs: 1 });
    expect(calls).toBe(1);

    const child = await store.fork(parent, 3);
    expect(await store.materializeMessages(child)).toContainEqual({
      role: "user",
      content: [{ type: "tool_result", toolUseId: "t1", content: "recorded" }],
    });
    expect(calls).toBe(1);
  });

  it("rejects a fork point outside the parent's own log without creating a child", async () => {
    const ids = ["parent", "child"];
    const store = new SessionStore({ root, newId: () => ids.shift() ?? "unexpected" });
    const parent = store.create();
    await store.append(parent, { type: "session.start", task: "root", cwd: "/w", provider: "fake", model: "m" });

    await expect(store.fork(parent, 1)).rejects.toThrow(/atSeq 1.*parent/);
    await expect(readFile(store.pathFor("child"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not append into an existing child log after the store is reopened", async () => {
    const initial = new SessionStore({ root, newId: () => "parent" });
    const parent = initial.create();
    await initial.append(parent, { type: "session.start", task: "root", cwd: "/w", provider: "fake", model: "m" });
    const childPath = initial.pathFor("child");
    const existing = `${JSON.stringify({
      seq: 0,
      ts: 1,
      sessionId: "child",
      type: "session.start",
      task: "existing",
      cwd: "/w",
      provider: "fake",
      model: "m",
    })}\n`;
    await writeFile(childPath, existing);

    const ids = ["child", "fresh-child"];
    const reopened = new SessionStore({ root, newId: () => ids.shift() ?? "unexpected" });
    const forked = await reopened.fork(parent, 0);

    expect(forked).toBe("fresh-child");
    expect(await readFile(childPath, "utf8")).toBe(existing);
    expect(await reopened.readAll(forked)).toMatchObject([
      { seq: 0, sessionId: "fresh-child", type: "session.fork", parent: "parent", atSeq: 0 },
    ]);
  });

  it.each([
    { mode: "modify" as const, patched: "[REDACTED]" },
    { mode: "inject" as const, patched: "safe follow-up", expected: "sensitive original\n\nsafe follow-up" },
  ])("replays the final $mode tool-result patch", async ({ mode, patched, expected }) => {
    const store = new SessionStore({ root, newId: () => "parent" });
    const parent = store.create();
    await store.append(parent, { type: "session.start", task: "root", cwd: "/w", provider: "fake", model: "m" });
    await store.append(parent, { type: "tool.call", id: "t1", name: "secret", input: {}, inputHash: contentHash({}) });
    await store.append(parent, { type: "tool.result", id: "t1", ok: true, display: "sensitive original", durationMs: 1 });
    await store.append(parent, { type: "tool.result.patched", id: "t1", by: "review", display: patched, mode });

    const replay = await store.materializeMessages(parent);
    const result = replay.flatMap((message) => message.content).find(
      (block) => block.type === "tool_result" && block.toolUseId === "t1",
    );
    expect(result).toMatchObject({
      type: "tool_result",
      content: expected ?? patched,
    });
    if (mode === "modify") expect(JSON.stringify(replay)).not.toContain("sensitive original");
  });
});
