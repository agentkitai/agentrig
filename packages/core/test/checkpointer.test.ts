import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Checkpointer,
  createAgent,
  RulePolicy,
  SessionStore,
  type AnyTool,
  type HarnessEvent,
  type ModelEvent,
  type ModelProvider,
  type ModelRequest,
} from "@agentkitai/agentrig-core";

const execFile = promisify(execFileCallback);

class FakeProvider implements ModelProvider {
  readonly id = "fake";
  readonly model = "fake-1";
  readonly capabilities = { tools: true, parallelTools: true, caching: false, contextWindow: 100_000 };
  constructor(private readonly turns: ModelEvent[][]) {}
  async *stream(_req: ModelRequest): AsyncIterable<ModelEvent> {
    yield* this.turns.shift() ?? [{ type: "stop", reason: "end_turn" }];
  }
}

const usage: ModelEvent = { type: "usage", usage: { input: 1, output: 1 } };
const stop = (reason: "tool_use" | "end_turn"): ModelEvent => ({ type: "stop", reason });
const call = (id: string, name: string, input: unknown): ModelEvent => ({ type: "tool_use", id, name, input });

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentrig-checkpointer-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd: root, encoding: "utf8" });
  return stdout.trim();
}

async function initRepo(): Promise<void> {
  await git("init", "-q");
  await git("config", "user.name", "AgentRig Test");
  await git("config", "user.email", "test@agentrig.invalid");
  await writeFile(join(root, "tracked.txt"), "committed\n");
  await git("add", "tracked.txt");
  await git("commit", "-qm", "baseline");
}

async function collect(session: { events: AsyncIterable<HarnessEvent> }): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for await (const event of session.events) events.push(event);
  return events;
}

function agent(
  turns: ModelEvent[][],
  tools: AnyTool[],
  opts: { checkpointer?: Checkpointer; hookTimeoutMs?: number } = {},
) {
  return createAgent({
    provider: new FakeProvider(turns),
    tools,
    permissions: new RulePolicy([
      { class: "read", decision: "allow" },
      { class: "write", decision: "allow" },
    ]),
    hooks: [opts.checkpointer ?? new Checkpointer()],
    ...(opts.hookTimeoutMs === undefined ? {} : { hookTimeoutMs: opts.hookTimeoutMs }),
    systemPrompt: "test",
    store: new SessionStore({ root }),
    budget: { maxTurns: 10 },
  });
}

const writeTool = (): AnyTool => ({
  name: "write",
  description: "write a file",
  inputSchema: z.object({ path: z.string(), content: z.string() }),
  permission: "write",
  paths: (input: { path: string }) => [input.path],
  execute: async (input: { path: string; content: string }) => {
    await writeFile(join(root, input.path), input.content);
    return { output: null, display: "written" };
  },
});

const readTool = (): AnyTool => ({
  name: "read",
  description: "read a file",
  inputSchema: z.object({ path: z.string() }),
  permission: "read",
  paths: (input: { path: string }) => [input.path],
  execute: async (input: { path: string }) => ({
    output: await readFile(join(root, input.path), "utf8"),
    display: "read",
  }),
});

describe("Checkpointer", () => {
  it("creates one namespaced snapshot before the first write-class tool in each turn without touching HEAD, index, or worktree", async () => {
    await initRepo();
    await writeFile(join(root, "tracked.txt"), "dirty before turn one\n");
    await writeFile(join(root, "untracked.txt"), "untracked before turn one\n");
    const headBefore = await git("rev-parse", "HEAD");
    const logBefore = await git("log", "--format=%H");
    const indexBefore = await readFile(join(root, ".git", "index"));

    const session = agent([
      [
        call("w1", "write", { path: "tracked.txt", content: "first write\n" }),
        call("w2", "write", { path: "second.txt", content: "second write\n" }),
        usage,
        stop("tool_use"),
      ],
      [call("w3", "write", { path: "tracked.txt", content: "third write\n" }), usage, stop("tool_use")],
      [usage, stop("end_turn")],
    ], [writeTool()]).run("write", { cwd: root, id: "session_one" });

    const events = await collect(session);
    expect((await session.done).reason).toBe("done");
    const checkpoints = events.filter((event) => event.type === "checkpoint.created");
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints.map((event) => event.type === "checkpoint.created" && event.ref)).toEqual([
      "refs/agentrig/session_one/1",
      "refs/agentrig/session_one/2",
    ]);
    const firstCheckpoint = events.findIndex((event) => event.type === "checkpoint.created" && event.turn === 1);
    const firstWrite = events.findIndex((event) => event.type === "tool.call" && event.name === "write");
    expect(firstCheckpoint).toBeGreaterThan(-1);
    expect(firstCheckpoint).toBeLessThan(firstWrite);

    expect(await git("show", "refs/agentrig/session_one/1:tracked.txt")).toBe("dirty before turn one");
    expect(await git("show", "refs/agentrig/session_one/1:untracked.txt")).toBe("untracked before turn one");
    expect(await git("show", "refs/agentrig/session_one/2:tracked.txt")).toBe("first write");
    expect(await git("show", "refs/agentrig/session_one/2:second.txt")).toBe("second write");
    expect(await git("rev-parse", "HEAD")).toBe(headBefore);
    expect(await git("log", "--format=%H")).toBe(logBefore);
    expect(await readFile(join(root, ".git", "index"))).toEqual(indexBefore);
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("third write\n");
  });

  it("blocks a write when the checkpoint times out", async () => {
    await initRepo();
    const session = agent([
      [call("w1", "write", { path: "tracked.txt", content: "must not be written\n" }), usage, stop("tool_use")],
      [usage, stop("end_turn")],
    ], [writeTool()], { hookTimeoutMs: 1 }).run("write", { cwd: root, id: "checkpoint_timeout" });

    const events = await collect(session);
    expect((await session.done).reason).toBe("done");
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("committed\n");
    expect(events.some((event) => event.type === "tool.call" && event.name === "write")).toBe(false);
    expect(events.some((event) => event.type === "tool.denied" && event.name === "write")).toBe(true);
    expect(events.some((event) =>
      event.type === "error"
      && event.message.includes("core:checkpointer")
      && event.message.includes("blocking")
    )).toBe(true);
  });

  it("does not cache an aborted snapshot attempt as success for a later write in the turn", async () => {
    await initRepo();
    const checkpointer = new Checkpointer();
    const aborted = new AbortController();
    aborted.abort();
    const emitted: Array<{ type: string }> = [];
    const context = {
      point: "pre_tool" as const,
      sessionId: "retry_after_abort",
      cwd: root,
      turn: 1,
      tool: { name: "write", input: {} },
      permission: "write" as const,
      emitCheckpoint: async (event: { type: string }) => { emitted.push(event); },
    };

    await expect(checkpointer.handler({ ...context, signal: aborted.signal })).rejects.toBeDefined();
    await expect(checkpointer.handler({ ...context, signal: new AbortController().signal })).resolves.toEqual({ action: "continue" });
    expect(emitted.some((event) => event.type === "checkpoint.warning")).toBe(false);
    expect(emitted.some((event) => event.type === "checkpoint.created")).toBe(true);
  });

  it("retries a non-Git warning when its first event append fails", async () => {
    const checkpointer = new Checkpointer();
    const events: Array<{ type: string }> = [];
    let fail = true;
    const context = {
      point: "pre_tool" as const,
      sessionId: "warning_retry",
      cwd: root,
      turn: 1,
      tool: { name: "write", input: {} },
      permission: "write" as const,
      signal: new AbortController().signal,
      emitCheckpoint: async (event: { type: string }) => {
        if (fail) {
          fail = false;
          throw new Error("append failed");
        }
        events.push(event);
      },
    };

    await expect(checkpointer.handler(context)).rejects.toThrow("append failed");
    await expect(checkpointer.handler(context)).resolves.toEqual({ action: "continue" });
    expect(events).toEqual([{ type: "checkpoint.warning", message: expect.any(String) }]);
  });

  it("ignores parent Git repository-selection variables", async () => {
    await initRepo();
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = join(root, "missing-git-dir");
    try {
      const session = agent([
        [call("w1", "write", { path: "tracked.txt", content: "written\n" }), usage, stop("tool_use")],
        [usage, stop("end_turn")],
      ], [writeTool()]).run("write", { cwd: root, id: "clean_git_env" });
      const events = await collect(session);
      await session.done;
      expect(events.some((event) => event.type === "checkpoint.created")).toBe(true);
      expect(events.some((event) => event.type === "checkpoint.warning")).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
  });

  it("releases its per-session state when a session ends", async () => {
    const checkpointer = new Checkpointer();
    const session = agent([
      [call("w1", "write", { path: "one.txt", content: "one" }), usage, stop("tool_use")],
      [usage, stop("end_turn")],
    ], [writeTool()], { checkpointer }).run("write", { cwd: root, id: "cleanup" });

    await collect(session);
    await session.done;
    const state = checkpointer as unknown as {
      attempts: Map<string, unknown>;
      warned: Set<string>;
    };
    expect(state.attempts.size).toBe(0);
    expect(state.warned.size).toBe(0);
  });

  it("does nothing for read-class tools", async () => {
    await initRepo();
    const session = agent([
      [call("r1", "read", { path: "tracked.txt" }), usage, stop("tool_use")],
      [usage, stop("end_turn")],
    ], [readTool()]).run("read", { cwd: root, id: "reads_only" });
    const events = await collect(session);
    await session.done;

    expect(events.some((event) => event.type === "checkpoint.created")).toBe(false);
    await expect(git("show-ref", "--verify", "refs/agentrig/reads_only/1")).rejects.toThrow();
  });

  it("does not checkpoint a denied write", async () => {
    await initRepo();
    const deniedAgent = createAgent({
      provider: new FakeProvider([
        [call("w1", "write", { path: "tracked.txt", content: "forbidden\n" }), usage, stop("tool_use")],
        [usage, stop("end_turn")],
      ]),
      tools: [writeTool()],
      permissions: new RulePolicy([{ class: "write", decision: "deny" }]),
      hooks: [new Checkpointer()],
      systemPrompt: "test",
      store: new SessionStore({ root }),
      budget: { maxTurns: 10 },
    });
    const session = deniedAgent.run("write", { cwd: root, id: "denied_write" });
    const events = await collect(session);
    await session.done;

    expect(events.some((event) => event.type === "checkpoint.created")).toBe(false);
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("committed\n");
    await expect(git("show-ref", "--verify", "refs/agentrig/denied_write/1")).rejects.toThrow();
  });

  it("degrades outside git to one warning for the session, never an error", async () => {
    const session = agent([
      [call("w1", "write", { path: "one.txt", content: "one" }), usage, stop("tool_use")],
      [call("w2", "write", { path: "two.txt", content: "two" }), usage, stop("tool_use")],
      [usage, stop("end_turn")],
    ], [writeTool()]).run("write", { cwd: root, id: "not_git" });
    const events = await collect(session);
    expect((await session.done).reason).toBe("done");

    expect(events.filter((event) => event.type === "checkpoint.warning")).toHaveLength(1);
    expect(events.some((event) => event.type === "checkpoint.created")).toBe(false);
    expect(events.some((event) => event.type === "error" && event.message.includes("checkpoint"))).toBe(false);
    expect(await readFile(join(root, "one.txt"), "utf8")).toBe("one");
    expect(await readFile(join(root, "two.txt"), "utf8")).toBe("two");
  });
});
