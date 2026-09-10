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
// Actual Git processes, including concurrent snapshots, need more than 5s on Windows CI.
vi.setConfig({ testTimeout: 30_000 });
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "agentrig-checkpoint-worktrees-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFile("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}
async function fixture(): Promise<{ main: string; left: string; right: string }> {
  const main = join(root, "main"), left = join(root, "left"), right = join(root, "right");
  await mkdir(main);
  await git(main, "init", "-q");
  await git(main, "config", "user.name", "Checkpoint Test");
  await git(main, "config", "user.email", "checkpoint@agentrig.invalid");
  await writeFile(join(main, "tracked.txt"), "committed\n");
  await git(main, "add", "tracked.txt");
  await git(main, "commit", "-qm", "baseline");
  await git(main, "worktree", "add", "-qb", "left", left);
  await git(main, "worktree", "add", "-qb", "right", right);
  return { main, left, right };
}
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
class WriterProvider implements ModelProvider {
  readonly id = "fake";
  readonly model = "checkpoint-test";
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
function writer(cwd: string, id: string, content: string, storeName: string) {
  const entered = latch(), release = latch();
  const store = new SessionStore({ root: join(root, "stores", storeName) });
  const tool: AnyTool = {
    name: "write", description: "write then hold a real workspace mutation",
    inputSchema: z.object({}), permission: "write", effects: "workspace",
    paths: () => [join(cwd, "tracked.txt")],
    execute: async () => {
      await writeFile(join(cwd, "tracked.txt"), content);
      entered.resolve();
      await release.promise;
      return { output: null, display: "written" };
    },
  };
  const session = createAgent({
    provider: new WriterProvider(), tools: [tool], store, systemPrompt: "test",
    permissions: new RulePolicy([{ class: "write", decision: "allow" }]),
    hooks: [new Checkpointer()], budget: { maxTurns: 3 },
  }).run("write", { cwd, id });
  const events: HarnessEvent[] = [];
  const collected = (async () => { for await (const event of session.events) events.push(event); })();
  return {
    session, store, events, release: release.resolve,
    async waitForWrite() {
      await Promise.race([entered.promise, session.done.then(() => {
        throw new Error(`writer ended before dispatch: ${events.filter(event => event.type === "error").map(event => event.message).join("; ")}`);
      })]);
    },
    async waitForRefusal() {
      await Promise.race([collected, entered.promise.then(() => {
        throw new Error("contending writer unexpectedly dispatched");
      })]);
    },
    async finish() { await session.done; await collected; },
  };
}

describe("worktree-scoped checkpoint ownership", () => {
  for (const pair of ["linked-linked", "primary-linked"] as const) {
    it(`overlaps ${pair} writes with identical session IDs and independent refs, seals and undo`, async () => {
      const repos = await fixture();
      const left = pair === "linked-linked" ? repos.left : repos.main, right = repos.right;
      // Different pre-existing dirty bytes prove the same ref name is resolved per worktree.
      await writeFile(join(left, "tracked.txt"), "left before\r\n");
      await writeFile(join(right, "tracked.txt"), "right before\n");
      const headLeft = await git(left, "rev-parse", "HEAD"), headRight = await git(right, "rev-parse", "HEAD");
      const indexLeft = await git(left, "write-tree"), indexRight = await git(right, "write-tree");
      const first = writer(left, "same_id", "left after", "left");
      let second: ReturnType<typeof writer> | undefined;
      try {
        await first.waitForWrite();
        second = writer(right, "same_id", "right after", "right");
        await second.waitForWrite();
        expect(await readFile(join(left, "tracked.txt"), "utf8")).toBe("left after");
        expect(await readFile(join(right, "tracked.txt"), "utf8")).toBe("right after");
        first.release();
        await first.finish();
        const created = first.events.filter(event => event.type === "checkpoint.created");
        expect(created).toHaveLength(1);
        expect(first.events.filter(event => event.type === "checkpoint.sealed")).toHaveLength(1);
        // Undo in one worktree must succeed while another worktree's writer is still active.
        expect((await undoSession(first.store, "same_id", { cwd: left })).restored).toBe(true);
        expect(await readFile(join(left, "tracked.txt"), "utf8")).toBe("left before\r\n");
        expect(await readFile(join(right, "tracked.txt"), "utf8")).toBe("right after");
        second.release();
        await second.finish();
        const secondCreated = second.events.filter(event => event.type === "checkpoint.created");
        expect(secondCreated).toHaveLength(1);
        expect(secondCreated[0]!.ref).toBe(created[0]!.ref);
        expect(secondCreated[0]!.tree).not.toBe(created[0]!.tree);
        expect(created[0]!.ref).toBe("refs/worktree/agentrig/same_id/1");
        expect(second.events.filter(event => event.type === "checkpoint.sealed")).toHaveLength(1);
        expect((await undoSession(second.store, "same_id", { cwd: right })).restored).toBe(true);
        expect(await readFile(join(right, "tracked.txt"), "utf8")).toBe("right before\n");
        expect(await readFile(join(left, "tracked.txt"), "utf8")).toBe("left before\r\n");
        expect(await git(left, "rev-parse", "HEAD")).toBe(headLeft);
        expect(await git(right, "rev-parse", "HEAD")).toBe(headRight);
        expect(await git(left, "write-tree")).toBe(indexLeft);
        expect(await git(right, "write-tree")).toBe(indexRight);
      } finally {
        first.release(); second?.release();
        await Promise.all([first.finish(), second?.finish()]);
      }
    });
  }

  it("still refuses a second writer in the same worktree without disturbing the first owner", async () => {
    const { left } = await fixture();
    const first = writer(left, "owner", "owned change", "owner");
    let second: ReturnType<typeof writer> | undefined;
    try {
      await first.waitForWrite();
      second = writer(left, "contender", "must not write", "contender");
      await second.waitForRefusal();
      await second.finish();
      expect(second.events.some(event => event.type === "tool.denied" && event.name === "write")).toBe(true);
      expect(second.events.filter(event => event.type === "checkpoint.created")).toHaveLength(0);
      expect(await readFile(join(left, "tracked.txt"), "utf8")).toBe("owned change");
      first.release();
      await first.finish();
      expect(first.events.filter(event => event.type === "checkpoint.sealed")).toHaveLength(1);
      expect((await undoSession(first.store, "owner", { cwd: left })).restored).toBe(true);
      expect(await readFile(join(left, "tracked.txt"), "utf8")).toBe("committed\n");
    } finally {
      first.release(); second?.release();
      await Promise.all([first.finish(), second?.finish()]);
    }
  });
});
