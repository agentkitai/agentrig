import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Checkpointer, createAgent, RulePolicy, SessionStore, undoSession, writeFileTool,
  type HarnessEvent, type ModelEvent, type ModelProvider,
} from "@agentkitai/agentrig-core";
import { FileMemoryStore, ingestOnSessionEnd } from "@agentkitai/agentrig-memory";

// Real Git ownership scans need the same Windows fixture budget as core/checkpointer.test.ts.
vi.setConfig({ testTimeout: 30_000 });
const execFile = promisify(execFileCallback);
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentrig-checkpoint-ingest-"));
  const git = (...args: string[]) => execFile("git", args, { cwd: root });
  await git("init", "-q");
  await git("config", "user.name", "AgentRig Test");
  await git("config", "user.email", "test@agentrig.invalid");
  await writeFile(join(root, "task.txt"), "before task\n");
  await writeFile(join(root, "human.txt"), "before human\n");
  await git("add", "task.txt", "human.txt");
  await git("commit", "-qm", "baseline");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function provider(stream: () => AsyncIterable<ModelEvent>): ModelProvider {
  return {
    id: "fake", model: "fake-1",
    capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 },
    stream,
  };
}

it.each(["untracked wiki", "tracked wiki", "concurrent tracked wiki edit", "no ingest"])(
  "distinguishes created checkpoints from undo availability with %s", async mode => {
    const dir = join(root, ".agentrig");
    const wiki = new FileMemoryStore({ root: join(dir, "wiki") });
    await wiki.init();
    const humanWiki = join(dir, "wiki", "concepts", "human.md");
    await writeFile(humanWiki, "before wiki human\n");
    if (mode === "tracked wiki" || mode === "concurrent tracked wiki edit") {
      await execFile("git", ["add", ".agentrig/wiki"], { cwd: root });
      await execFile("git", ["commit", "-qm", "track wiki"], { cwd: root });
    }
    const store = new SessionStore({ root: join(dir, "raw", "sessions") });
    const maintenance: string[] = [];
    const failures: Error[] = [];
    let turn = 0;
    const session = createAgent({
      provider: provider(async function* () {
        if (turn++ === 0) {
          yield { type: "tool_use", id: "write", name: "write_file", input: { path: "task.txt", content: "task completed\n" } };
          yield { type: "stop", reason: "tool_use" };
        } else {
          yield { type: "text_delta", text: "done" };
          yield { type: "stop", reason: "end_turn" };
        }
      }),
      tools: [writeFileTool()],
      permissions: new RulePolicy([{ class: "write", decision: "allow" }]),
      systemPrompt: "test", store,
      hooks: [new Checkpointer(), ...(mode === "no ingest" ? [] : [ingestOnSessionEnd({
        dir,
        provider: provider(async function* () {
          if (mode === "concurrent tracked wiki edit") {
            await writeFile(join(root, "human.txt"), "human edit during ingest\n");
            await writeFile(humanWiki, "human wiki edit during ingest\n");
          }
          yield { type: "text_delta", text: JSON.stringify({ nothingDurable: true }) };
          yield { type: "stop", reason: "end_turn" };
        }),
        onDone: text => maintenance.push(text),
        onError: error => failures.push(error),
      })])],
    }).run("write task.txt", { cwd: root });
    const events: HarnessEvent[] = [];
    for await (const event of session.events) events.push(event);
    expect((await session.done).reason).toBe("done");
    expect(events.filter(event => event.type === "checkpoint.created")).toHaveLength(1);
    if (mode === "no ingest") {
      expect(events.filter(event => event.type === "checkpoint.sealed")).toHaveLength(1);
      expect((await undoSession(store, session.id, { cwd: root })).restored).toBe(true);
      expect(await readFile(join(root, "task.txt"), "utf8")).toBe("before task\n");
      return;
    }
    expect(failures).toEqual([]);
    expect(maintenance.some(text => text.startsWith("ingested "))).toBe(true);
    expect(events.some(event => event.type === "checkpoint.sealed")).toBe(false);
    const refusal = events.find(event => event.type === "error" && event.message.startsWith("checkpoint seal failed:"));
    expect(refusal).toMatchObject({ fatal: false });
    expect(refusal?.type === "error" ? refusal.message : "").toContain("Checkpoint snapshots remain, but undo has no verified ownership seal");
    expect(refusal?.type === "error" ? refusal.message : "").toContain("session-end hooks such as memory ingest may change covered files");
    const checkpoint = events.find(event => event.type === "checkpoint.created")!;
    expect((await execFile("git", ["rev-parse", "--verify", checkpoint.ref], { cwd: root })).stdout.trim()).toBe(checkpoint.commit);
    expect((await execFile("git", ["show", `${checkpoint.ref}:task.txt`], { cwd: root })).stdout).toBe("before task\n");
    const index = await readFile(join(dir, "wiki", "index.md"), "utf8");
    const raw = await readFile(join(store.root, `${session.id}.jsonl`), "utf8");
    await expect(undoSession(store, session.id, { cwd: root })).rejects.toThrow("no verified ownership seal");
    expect(await readFile(join(root, "task.txt"), "utf8")).toBe("task completed\n");
    expect(await readFile(join(dir, "wiki", "index.md"), "utf8")).toBe(index);
    expect(await readFile(join(store.root, `${session.id}.jsonl`), "utf8")).toBe(raw);
    expect(await readFile(join(root, "human.txt"), "utf8")).toBe(mode === "concurrent tracked wiki edit" ? "human edit during ingest\n" : "before human\n");
    expect(await readFile(humanWiki, "utf8")).toBe(mode === "concurrent tracked wiki edit" ? "human wiki edit during ingest\n" : "before wiki human\n");
  },
);
