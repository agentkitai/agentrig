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
// Real Git collection plus snapshots/restoration is slower on Windows runners.
vi.setConfig({ testTimeout: 30_000 });
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "agentrig-checkpoint-gc-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFile("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

class Provider implements ModelProvider {
  readonly id = "fake";
  readonly model = "checkpoint-gc-test";
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

async function closedCheckpoint(repo: string, name: string) {
  const before = `${name} dirty before`, after = `${name} dirty after`;
  await writeFile(join(repo, "tracked.txt"), before);
  const store = new SessionStore({ root: join(root, "sessions", name) });
  const tool: AnyTool = {
    name: "write", description: "write", permission: "write", effects: "workspace",
    inputSchema: z.object({}), paths: () => [join(repo, "tracked.txt")],
    execute: async () => {
      await writeFile(join(repo, "tracked.txt"), after);
      return { output: null, display: "written" };
    },
  };
  const session = createAgent({
    provider: new Provider(), tools: [tool], store, systemPrompt: "test",
    permissions: new RulePolicy([{ class: "write", decision: "allow" }]),
    hooks: [new Checkpointer()], budget: { maxTurns: 3 },
  }).run("write", { cwd: repo, id: "same_id" });
  const events: HarnessEvent[] = [];
  for await (const event of session.events) events.push(event);
  await session.done;
  const created = events.filter(event => event.type === "checkpoint.created");
  const sealed = events.filter(event => event.type === "checkpoint.sealed");
  expect(created).toHaveLength(1);
  expect(sealed).toHaveLength(1);
  const records = [created[0]!, sealed[0]!];
  return { repo, store, before, after, records };
}

async function assertObjects(state: Awaited<ReturnType<typeof closedCheckpoint>>) {
  for (const [index, event] of state.records.entries()) {
    expect(await git(state.repo, "rev-parse", "--verify", event.ref)).toBe(event.commit);
    expect(await git(state.repo, "cat-file", "-t", event.commit)).toBe("commit");
    expect(await git(state.repo, "cat-file", "-t", event.tree)).toBe("tree");
    expect(await git(state.repo, "rev-parse", `${event.commit}^{tree}`)).toBe(event.tree);
    // These unique dirty blobs were never in HEAD or the real index: only checkpoints retain them.
    expect(await git(state.repo, "show", `${event.tree}:tracked.txt`)).toBe(index === 0 ? state.before : state.after);
  }
}

describe("checkpoint retention across shared-object Git maintenance", () => {
  for (const collector of ["primary", "linked"] as const) {
    it(`retains both worktrees' checkpoint objects and undo after gc from ${collector}`, async () => {
      const primary = join(root, "primary"), linked = join(root, "linked");
      await mkdir(primary);
      await git(primary, "init", "-q");
      await git(primary, "config", "user.name", "Checkpoint Test");
      await git(primary, "config", "user.email", "checkpoint@agentrig.invalid");
      await writeFile(join(primary, "tracked.txt"), "committed\n");
      await git(primary, "add", "tracked.txt");
      await git(primary, "commit", "-qm", "baseline");
      await git(primary, "worktree", "add", "-qb", "linked", linked);
      const states = [await closedCheckpoint(primary, "primary"), await closedCheckpoint(linked, "linked")];
      for (const state of states) await assertObjects(state);
      const rawBefore = await Promise.all(states.map(state => readFile(state.store.pathFor("same_id"))));
      // Destructive collection is confined to this disposable fixture, after both sessions joined.
      // In particular, no active writer relies on Git's usual object-age safety window here.
      await git(collector === "primary" ? primary : linked, "gc", "--prune=now");
      for (const state of states) await assertObjects(state);
      for (const [index, state] of states.entries()) {
        expect((await undoSession(state.store, "same_id", { cwd: state.repo })).restored).toBe(true);
        expect(await readFile(join(state.repo, "tracked.txt"), "utf8")).toBe(state.before);
        expect(await readFile(state.store.pathFor("same_id"))).toEqual(rawBefore[index]);
      }
      // Restoration in the sibling must neither disturb the first restore nor consume retained refs.
      for (const state of states) {
        expect(await readFile(join(state.repo, "tracked.txt"), "utf8")).toBe(state.before);
        await assertObjects(state);
      }
    });
  }
});
