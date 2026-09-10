import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Checkpointer, createAgent, RulePolicy, SessionStore, undoSession,
  type AnyTool, type HarnessEvent, type ModelEvent, type ModelProvider, type ModelRequest,
} from "@agentkitai/agentrig-core";

const execFile = promisify(execFileCallback);
vi.setConfig({ testTimeout: 30_000 });
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "agentrig-checkpoint-legacy-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFile("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}
class Provider implements ModelProvider {
  readonly id = "fake";
  readonly model = "legacy-checkpoint-test";
  readonly capabilities = { tools: true, parallelTools: true, caching: false, contextWindow: 100_000 };
  private called = false;
  async *stream(_request: ModelRequest): AsyncIterable<ModelEvent> {
    yield { type: "usage", usage: { input: 1, output: 1 } };
    if (!this.called) {
      this.called = true;
      yield { type: "tool_use", id: "write", name: "write", input: {} };
      yield { type: "stop", reason: "tool_use" };
    } else yield { type: "stop", reason: "end_turn" };
  }
}

async function fixture() {
  const repo = join(root, "repo");
  await mkdir(repo);
  await git(repo, "init", "-q");
  await git(repo, "config", "user.name", "Checkpoint Test");
  await git(repo, "config", "user.email", "checkpoint@agentrig.invalid");
  await writeFile(join(repo, "tracked.txt"), "committed\n");
  await git(repo, "add", "tracked.txt");
  await git(repo, "commit", "-qm", "baseline");
  await writeFile(join(repo, "tracked.txt"), "dirty before\r\n");
  const store = new SessionStore({ root: join(root, "sessions") });
  const tool: AnyTool = {
    name: "write", description: "write", permission: "write", effects: "workspace",
    inputSchema: z.object({}), paths: () => [join(repo, "tracked.txt")],
    execute: async () => {
      await writeFile(join(repo, "tracked.txt"), "after");
      return { output: null, display: "written" };
    },
  };
  const session = createAgent({
    provider: new Provider(), tools: [tool], store, systemPrompt: "test",
    permissions: new RulePolicy([{ class: "write", decision: "allow" }]),
    hooks: [new Checkpointer()], budget: { maxTurns: 3 },
  }).run("write", { cwd: repo, id: "source" });
  const events: HarnessEvent[] = [];
  for await (const event of session.events) events.push(event);
  await session.done;
  expect(events.filter(event => event.type === "checkpoint.created")).toHaveLength(1);
  expect(events.filter(event => event.type === "checkpoint.sealed")).toHaveLength(1);
  return { repo, store, events };
}

/** A new append-only historical fixture, never a rewrite of the actual SDK session. */
async function copyReceipts(
  repo: string, store: SessionStore, events: HarnessEvent[], id: string,
  prefixes: { created: string; sealed: string },
) {
  for (const event of events) {
    const { sessionId: _sessionId, seq: _seq, ts: _ts, ...payload } = event;
    if (payload.type === "checkpoint.created" || payload.type === "checkpoint.sealed") {
      const suffix = payload.type === "checkpoint.created" ? `${payload.turn}` : `sealed/${payload.turn}`;
      const prefix = payload.type === "checkpoint.created" ? prefixes.created : prefixes.sealed;
      const ref = `${prefix}/${id}/${suffix}`;
      await git(repo, "update-ref", ref, payload.commit);
      await store.append(id, { ...payload, ref });
    } else await store.append(id, payload);
  }
}

describe("checkpoint namespace compatibility", () => {
  it("restores legacy receipts without migrating refs or rewriting source evidence", async () => {
    const { repo, store, events } = await fixture();
    const sourceBytes = await readFile(store.pathFor("source"));
    await copyReceipts(repo, store, events, "legacy", { created: "refs/agentrig", sealed: "refs/agentrig" });
    // Seed modern names even on the old implementation, so this control proves preservation
    // both before and after the format change (Git itself supports worktree-local refs).
    for (const event of events) {
      if (event.type !== "checkpoint.created" && event.type !== "checkpoint.sealed") continue;
      const suffix = event.type === "checkpoint.created" ? `${event.turn}` : `sealed/${event.turn}`;
      await git(repo, "update-ref", `refs/worktree/agentrig/modern/${suffix}`, event.commit);
    }
    const refsBefore = await git(repo, "for-each-ref", "--format=%(refname) %(objectname)");
    const legacyBytes = await readFile(store.pathFor("legacy"));
    const head = await git(repo, "rev-parse", "HEAD"), index = await git(repo, "write-tree");
    const result = await undoSession(store, "legacy", { cwd: repo });
    expect(result.restored).toBe(true);
    expect(await readFile(join(repo, "tracked.txt"), "utf8")).toBe("dirty before\r\n");
    expect(await git(repo, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(refsBefore);
    expect(await readFile(store.pathFor("source"))).toEqual(sourceBytes);
    expect(await readFile(store.pathFor("legacy"))).toEqual(legacyBytes);
    expect(await git(repo, "rev-parse", "HEAD")).toBe(head);
    expect(await git(repo, "write-tree")).toBe(index);
    const audit = await store.readAll(result.auditId!);
    expect(audit.find(event => event.type === "checkpoint.restored")).toMatchObject({
      targetSession: "legacy", ref: "refs/agentrig/legacy/1",
    });
  });

  for (const direction of ["legacy-created", "legacy-sealed"] as const) {
    it(`refuses mixed namespace receipts (${direction}) before changing files or refs`, async () => {
      const { repo, store, events } = await fixture();
      await copyReceipts(repo, store, events, "mixed", {
        created: direction === "legacy-created" ? "refs/agentrig" : "refs/worktree/agentrig",
        sealed: direction === "legacy-sealed" ? "refs/agentrig" : "refs/worktree/agentrig",
      });
      const sourceBytes = await readFile(store.pathFor("source"));
      const mixedBytes = await readFile(store.pathFor("mixed"));
      const refsBefore = await git(repo, "for-each-ref", "--format=%(refname) %(objectname)");
      await expect(undoSession(store, "mixed", { cwd: repo })).rejects.toThrow("checkpoint namespace mismatch");
      expect(await readFile(join(repo, "tracked.txt"), "utf8")).toBe("after");
      expect(await git(repo, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(refsBefore);
      expect(await readFile(store.pathFor("source"))).toEqual(sourceBytes);
      expect(await readFile(store.pathFor("mixed"))).toEqual(mixedBytes);
    });
  }
});
