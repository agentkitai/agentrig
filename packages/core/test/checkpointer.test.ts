import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Checkpointer,
  undoSession,
  bashTool,
  JobRegistry,
  createAgent,
  RulePolicy,
  SessionStore,
  type AnyTool,
  type CheckpointHookEvent,
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
      { class: "exec", decision: "allow" },
    ]),
    hooks: [
      opts.checkpointer ?? new Checkpointer(
        opts.hookTimeoutMs === undefined ? {} : { timeoutMs: opts.hookTimeoutMs },
      ),
    ],
    ...(opts.hookTimeoutMs === undefined ? {} : { hookTimeoutMs: opts.hookTimeoutMs }),
    systemPrompt: "test",
    store: new SessionStore({ root: join(root, ".agentrig", "sessions") }),
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
  effects: "read-only",
  paths: (input: { path: string }) => [input.path],
  execute: async (input: { path: string }) => ({
    output: await readFile(join(root, input.path), "utf8"),
    display: "read",
  }),
});

describe("Checkpointer", () => {
  it("refuses an ignored unowned file colliding with a restoration target",async()=>{
    await initRepo();await writeFile(join(root,"lost.txt"),"before");await writeFile(join(root,".gitignore"),"\n");
    const tool:AnyTool={name:"remove",description:"remove",permission:"write",inputSchema:z.object({}),execute:async()=>{await rm(join(root,"lost.txt"));await writeFile(join(root,".gitignore"),"lost.txt\n");return {output:null,display:"done"};}};
    const session=agent([[call("a",tool.name,{}),stop("tool_use")],[stop("end_turn")]], [tool]).run("remove",{cwd:root,id:"undo_collision"});
    await collect(session);await session.done;await writeFile(join(root,"lost.txt"),"ignored external data");
    await expect(undoSession(new SessionStore({root:join(root,".agentrig","sessions")}),session.id,{cwd:root})).rejects.toThrow("ignored or unowned path");
    expect(await readFile(join(root,"lost.txt"),"utf8")).toBe("ignored external data");
    expect(await readFile(join(root,".gitignore"),"utf8")).toBe("lost.txt\n");
  });

  it("refuses to undo across a session-created commit without rewriting history",async()=>{
    await initRepo();
    const session=agent([[call("a","write",{path:"tracked.txt",content:"committed change"}),stop("tool_use")],[call("b","bash",{command:"git add tracked.txt && git commit -qm change"}),stop("tool_use")],[stop("end_turn")]], [writeTool(),bashTool()]).run("commit",{cwd:root,id:"undo_commit"});
    await collect(session);await session.done;const head=await git("rev-parse","HEAD");
    await expect(undoSession(new SessionStore({root:join(root,".agentrig","sessions")}),session.id,{cwd:root})).rejects.toThrow("HEAD changed since the checkpoint");
    expect(await git("rev-parse","HEAD")).toBe(head);
    expect(await readFile(join(root,"tracked.txt"),"utf8")).toBe("committed change");
  });
  it.skipIf(process.platform === "win32")("undo restores symlink target bytes without reading or changing the target",async()=>{
    await initRepo();
    await writeFile(join(root,"target.txt"),"target untouched");
    await symlink("target.txt",join(root,"link"));
    const tool:AnyTool={name:"replace_link",description:"replace",permission:"write",inputSchema:z.object({}),execute:async()=>{await rm(join(root,"link"));await writeFile(join(root,"link"),"regular replacement");return {output:null,display:"done"};}};
    const session=agent([[call("a",tool.name,{}),stop("tool_use")],[stop("end_turn")]], [tool]).run("replace",{cwd:root,id:"undo_link"});
    await collect(session);await session.done;
    await undoSession(new SessionStore({root:join(root,".agentrig","sessions")}),session.id,{cwd:root});
    expect(await readlink(join(root,"link"))).toBe("target.txt");
    expect(await readFile(join(root,"target.txt"),"utf8")).toBe("target untouched");
  });

  it("never certifies an aborted in-flight tool that can still write later",async()=>{
    await initRepo();let begin!:()=>void;let finish!:()=>void;
    const begun=new Promise<void>(r=>{begin=r;}); const wait=new Promise<void>(r=>{finish=r;});
    let finished!:()=>void;const settled=new Promise<void>(r=>{finished=r;});
    const tool:AnyTool={name:"late",description:"late",permission:"write",inputSchema:z.object({}),execute:async()=>{begin();await wait;await writeFile(join(root,"tracked.txt"),"late write");finished();return {output:null,display:"done"};}};
    const session=agent([[call("a",tool.name,{}),stop("tool_use")]], [tool]).run("late",{cwd:root,id:"undo_late"});
    await begun;session.control.abort();const events=await collect(session);await session.done;
    expect(events.some(e=>e.type==="checkpoint.sealed")).toBe(false);
    finish();await settled;
    await expect(undoSession(new SessionStore({root:join(root,".agentrig","sessions")}),session.id,{cwd:root})).rejects.toThrow("no verified ownership");
    expect(await readFile(join(root,"tracked.txt"),"utf8")).toBe("late write");
  });

  it.skipIf(process.platform === "win32")("retains displaced originals and a manifest on a real partial installation failure",async()=>{
    await initRepo();await mkdir(join(root,"z"));
    await writeFile(join(root,"a.txt"),"a before");await writeFile(join(root,"z","file.txt"),"z before");
    const session=agent([[call("a","write",{path:"a.txt",content:"a owned"}),call("z","write",{path:"z/file.txt",content:"z owned"}),stop("tool_use")],[stop("end_turn")]], [writeTool()]).run("change",{cwd:root,id:"undo_partial"});
    await collect(session);await session.done;let checks=0;
    try {
      await expect(undoSession(new SessionStore({root:join(root,".agentrig","sessions")}),session.id,{cwd:root,assertQuiescent:async()=>{if(++checks===3)await chmod(join(root,"z"),0o500);}})).rejects.toThrow("undo partially applied; recovery retained");
      expect(await readFile(join(root,"a.txt"),"utf8")).toBe("a before");
      expect(await readFile(join(root,"z","file.txt"),"utf8")).toBe("z owned");
      const recovery=(await readdir(join(root,".git"))).find(name=>name.startsWith("agentrig-undo-"))!;
      expect(await readFile(join(root,".git",recovery,"originals","0"),"utf8")).toBe("a owned");
      expect(await readFile(join(root,".git",recovery,"manifest.json"),"utf8")).toContain("z/file.txt");
    } finally {await chmod(join(root,"z"),0o700);}
  });
  it("undo restores dirty raw bytes from file and shell tools without changing index, HEAD, refs, or session history", async () => {
    await initRepo();
    await writeFile(join(root,".gitignore"),"ignored.txt\n");
    await git("add",".gitignore"); await git("commit","-qm","ignore");
    await writeFile(join(root,"tracked.txt"),"staged\n"); await git("add","tracked.txt");
    const before = Buffer.from([0,255,13,10,65]);
    await writeFile(join(root,"tracked.txt"),before);
    await writeFile(join(root,"untracked.txt"),"precious\r\n");
    await writeFile(join(root,"ignored.txt"),"ignored external bytes");
    const index = await readFile(join(root,".git","index"));
    const head = await git("rev-parse","HEAD"); const log = await git("log","--format=%H");
    const session = agent([
      [call("a","write",{path:"tracked.txt",content:"changed"}),usage,stop("tool_use")],
      [call("b","bash",{command:"printf shell > untracked.txt; printf new > new.txt"}),usage,stop("tool_use")],
      [stop("end_turn")],
    ],[writeTool(),bashTool()]).run("change",{cwd:root,id:"undo_raw"});
    const events = await collect(session); await session.done;
    expect(events.filter(e=>e.type==="checkpoint.sealed")).toHaveLength(1);
    const store = new SessionStore({root:join(root,".agentrig","sessions")});
    const history = await readFile(store.pathFor(session.id));
    const refs = await git("for-each-ref","--format=%(refname) %(objectname)","refs/agentrig");
    const result = await undoSession(store,session.id,{cwd:root,toTurn:1});
    expect(result.restored).toBe(true);
    expect(await readFile(join(root,"tracked.txt"))).toEqual(before);
    expect(await readFile(join(root,"untracked.txt"),"utf8")).toBe("precious\r\n");
    await expect(readFile(join(root,"new.txt"))).rejects.toThrow();
    expect(await readFile(join(root,"ignored.txt"),"utf8")).toBe("ignored external bytes");
    expect(await readFile(join(root,".git","index"))).toEqual(index);
    expect(await git("rev-parse","HEAD")).toBe(head); expect(await git("log","--format=%H")).toBe(log);
    expect(await git("for-each-ref","--format=%(refname) %(objectname)","refs/agentrig")).toBe(refs);
    expect(await readFile(store.pathFor(session.id))).toEqual(history);
    expect((await store.readAll(result.auditId!)).map(e=>e.type)).toEqual(["session.start","checkpoint.restored","session.end"]);
    expect(await readFile(join(result.recovery!,"manifest.json"),"utf8")).toContain("undo_raw");
  });

  it("undo defaults to the latest checkpoint and refuses external dirty-worktree changes", async () => {
    await initRepo();
    const session = agent([
      [call("a","write",{path:"tracked.txt",content:"first"}),stop("tool_use")],
      [call("b","write",{path:"tracked.txt",content:"second"}),stop("tool_use")],
      [stop("end_turn")],
    ],[writeTool()]).run("change",{cwd:root,id:"undo_latest"});
    await collect(session); await session.done;
    const store = new SessionStore({root:join(root,".agentrig","sessions")});
    await writeFile(join(root,"external.txt"),"human change");
    await expect(undoSession(store,session.id,{cwd:root})).rejects.toThrow("non-session changes");
    expect(await readFile(join(root,"tracked.txt"),"utf8")).toBe("second");
    expect(await readFile(join(root,"external.txt"),"utf8")).toBe("human change");
    await rm(join(root,"external.txt"));
    expect((await undoSession(store,session.id,{cwd:root})).turn).toBe(2);
    expect(await readFile(join(root,"tracked.txt"),"utf8")).toBe("first");
  });

  it("refuses external index/HEAD changes and held writer leases before undo", async () => {
    await initRepo();
    const session = agent([[call("a","write",{path:"tracked.txt",content:"after"}),stop("tool_use")],[stop("end_turn")]], [writeTool()]).run("change",{cwd:root,id:"undo_guard"});
    await collect(session); await session.done;
    const store = new SessionStore({root:join(root,".agentrig","sessions")});
    const index = await readFile(join(root,".git","index"));
    await git("add","tracked.txt");
    await expect(undoSession(store,session.id,{cwd:root})).rejects.toThrow("non-session changes");
    await writeFile(join(root,".git","index"),index);
    const lease = join(root,".git","agentrig-checkpoint.lock"); await mkdir(lease);
    await expect(undoSession(store,session.id,{cwd:root})).rejects.toThrow("another session");
    await rm(lease,{recursive:true});
    const release = await store.acquireLock(session.id);
    await expect(undoSession(store,session.id,{cwd:root})).rejects.toThrow("locked");
    await release();
    await git("checkout","-qb","other");
    await expect(undoSession(store,session.id,{cwd:root})).rejects.toThrow("non-session changes");
    expect(await readFile(join(root,"tracked.txt"),"utf8")).toBe("after");
  });

  it("does not seal external changes after the final tool or between mutating calls", async () => {
    await initRepo();
    const cp = new Checkpointer(); const stored: CheckpointHookEvent[] = [];
    const ctx = {point:"pre_tool" as const,sessionId:"external",cwd:root,turn:1,signal:new AbortController().signal,emitCheckpoint:async(e:CheckpointHookEvent)=>{stored.push(e);}};
    await cp.handler(ctx); await writeFile(join(root,"tracked.txt"),"tool"); await cp.afterTool(ctx);
    await writeFile(join(root,"tracked.txt"),"external");
    await expect(cp.seal(ctx)).rejects.toThrow("non-session changes");
    await expect(cp.handler(ctx)).rejects.toThrow("non-session changes");
    expect(stored.some(e=>e.type==="checkpoint.sealed")).toBe(false); await cp.endSession(ctx.sessionId);
  });

  it("rejects missing seals and invalid turns and degrades a non-Git run to a no-op", async () => {
    const session = agent([[call("a","write",{path:"plain.txt",content:"plain"}),stop("tool_use")],[stop("end_turn")]], [writeTool()]).run("change",{cwd:root,id:"plain_undo"});
    await collect(session); await session.done;
    const store = new SessionStore({root:join(root,".agentrig","sessions")});
    expect((await undoSession(store,session.id,{cwd:root})).restored).toBe(false);
    await expect(undoSession(store,session.id,{cwd:root,toTurn:0})).rejects.toThrow("positive");
    const legacy = store.create(); await store.append(legacy,{type:"session.end",reason:"done"});
    await expect(undoSession(store,legacy,{cwd:root})).rejects.toThrow("no verified ownership");
  });
  it("captures real foreground shell writes and unknown read-class custom tools conservatively", async () => {
    await initRepo();
    const unknown = { ...writeTool(), permission: "read" as const };
    const session = agent([
      [call("shell", "bash", { command: "echo shell > tracked.txt" }), usage, stop("tool_use")],
      [call("custom", "write", { path: "tracked.txt", content: "custom" }), usage, stop("tool_use")],
      [usage, stop("end_turn")],
    ], [bashTool(), unknown]).run("change", { cwd: root, id: "effects" });
    const events = await collect(session); await session.done;
    expect(events.filter(e => e.type === "checkpoint.created")).toHaveLength(2);
    expect(await git("show", "refs/agentrig/effects/1:tracked.txt")).toBe("committed");
    expect(await git("show", "refs/agentrig/effects/2:tracked.txt")).toBe("shell");
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("custom");
  });

  it("rejects background launch before execution and active registry work before mutation", async () => {
    await initRepo();
    const jobs = new JobRegistry();
    const session = agent([
      [call("background", "bash", { command: "echo unsafe > tracked.txt", background: true }), usage, stop("tool_use")],
      [usage, stop("end_turn")],
    ], [bashTool({ jobs })]).run("background", { cwd: root, id: "background" });
    const events = await collect(session); await session.done;
    expect(jobs.ids()).toEqual([]);
    expect(events.some(e => e.type === "tool.denied")).toBe(true);
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("committed\n");

    // Actual shared registry state from an already-started process, not model annotations.
    const running = jobs.start({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: root,
      isWindows: process.platform === "win32", killTree: pid => { void execFile("taskkill", ["/pid", String(pid), "/T", "/F"]).catch(() => {}); }, signal: new AbortController().signal });
    try {
      const blocked = agent([[call("write", "write", { path: "tracked.txt", content: "unsafe" }), usage, stop("tool_use")], [usage, stop("end_turn")]],
        [bashTool({ jobs }), writeTool()]).run("write", { cwd: root, id: "live_job" });
      const es = await collect(blocked); await blocked.done;
      expect(es.some(e => e.type === "tool.denied")).toBe(true);
      expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("committed\n");
    } finally { jobs.disposeAll(); await jobs.get(running.id)?.done; }
  });

  it("preserves staged index bytes, ignored files, CRLF, and deleted tracked paths", async () => {
    await initRepo();
    await writeFile(join(root, ".gitignore"), "ignored.txt\n");
    await writeFile(join(root, "ignored.txt"), "secret excluded");
    await writeFile(join(root, "tracked.txt"), "staged\n"); await git("add", "tracked.txt");
    await writeFile(join(root, "tracked.txt"), "raw\r\nbytes\r\n");
    await git("config", "core.autocrlf", "true");
    const index = await readFile(join(root, ".git", "index"));
    const session = agent([[call("write", "write", { path: "after.txt", content: "after" }), usage, stop("tool_use")], [usage, stop("end_turn")]],
      [writeTool()]).run("write", { cwd: root, id: "raw_bytes" });
    await collect(session); await session.done;
    const { stdout } = await execFile("git", ["show", "refs/agentrig/raw_bytes/1:tracked.txt"], { cwd: root, encoding: "buffer" });
    expect(stdout).toEqual(Buffer.from("raw\r\nbytes\r\n"));
    expect(await readFile(join(root, ".git", "index"))).toEqual(index);
    expect(await readFile(join(root, "ignored.txt"), "utf8")).toBe("secret excluded");
    await expect(git("show", "refs/agentrig/raw_bytes/1:ignored.txt")).rejects.toThrow();
    await rm(join(root, "tracked.txt"));
    const removed = agent([[call("write", "write", { path: "after.txt", content: "next" }), usage, stop("tool_use")], [usage, stop("end_turn")]], [writeTool()])
      .run("write", { cwd: root, id: "deleted" });
    await collect(removed); await removed.done;
    await expect(git("show", "refs/agentrig/deleted/1:tracked.txt")).rejects.toThrow();
  });

  it("holds an exclusive session lease and refuses known external uncertainty even later in a turn", async () => {
    await initRepo();
    let external = false;
    const cp = new Checkpointer({ assertQuiescent: async () => { if (external) throw new Error("external writer active"); } });
    const ctx = { point: "pre_tool" as const, sessionId: "owner", cwd: root, turn: 1, signal: new AbortController().signal, emitCheckpoint: async () => {} };
    await cp.handler(ctx);
    await expect(new Checkpointer().handler({ ...ctx, sessionId: "competitor" })).rejects.toThrow("ownership uncertain");
    external = true;
    await expect(cp.handler(ctx)).rejects.toThrow("external writer active");
    await cp.endSession("owner");
    const next = new Checkpointer(); await next.handler({ ...ctx, sessionId: "next" }); await next.endSession("next");
  });

  it("detects byte changes between scans and never publishes a mixed checkpoint", async () => {
    await initRepo(); let calls = 0;
    const cp = new Checkpointer({ assertQuiescent: async () => { if (++calls === 2) await writeFile(join(root, "tracked.txt"), "concurrent edit"); } });
    const ctx = { point: "pre_tool" as const, sessionId: "changed", cwd: root, turn: 1, signal: new AbortController().signal, emitCheckpoint: async () => {} };
    await expect(cp.handler(ctx)).rejects.toThrow("worktree changed while checkpointing");
    await expect(git("show-ref", "--verify", "refs/agentrig/changed/1")).rejects.toThrow();
    await cp.endSession("changed");
  });

  it("captures an unborn repository without requiring a user Git identity", async () => {
    await git("init", "-q"); await writeFile(join(root, "before.txt"), "before");
    const s = agent([[call("w", "write", { path: "before.txt", content: "after" }), usage, stop("tool_use")], [usage, stop("end_turn")]], [writeTool()])
      .run("write", { cwd: root, id: "unborn" });
    await collect(s); await s.done;
    expect(await git("show", "refs/agentrig/unborn/1:before.txt")).toBe("before");
    await expect(git("rev-parse", "--verify", "HEAD")).rejects.toThrow();
  });

  it("bounds a hung quiescence callback and settles the session without executing a mutation", async () => {
    await initRepo();
    const cp = new Checkpointer({ timeoutMs: 30, assertQuiescent: async () => new Promise<void>(() => {}) });
    const session = agent([[call("w", "write", { path: "tracked.txt", content: "unsafe" }), usage, stop("tool_use")], [usage, stop("end_turn")]],
      [writeTool()], { checkpointer: cp }).run("write", { cwd: root, id: "hung_guard" });
    const events = await collect(session); await session.done;
    expect(events.some(e => e.type === "tool.denied")).toBe(true);
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("committed\n");
  });

  it("preserves a replaced lease and refuses both mutation and cleanup", async () => {
    await initRepo(); const cp = new Checkpointer();
    const ctx = { point: "pre_tool" as const, sessionId: "replaced", cwd: root, turn: 1, signal: new AbortController().signal, emitCheckpoint: async () => {} };
    await cp.handler(ctx);
    const path = join(root, ".git", "agentrig-checkpoint.lock");
    await rename(path, path + ".original"); await mkdir(path); await writeFile(join(path, "user-data"), "keep");
    await expect(cp.handler(ctx)).rejects.toThrow("lease replaced");
    await expect(cp.endSession(ctx.sessionId)).rejects.toThrow("lease replaced");
    expect(await readFile(join(path, "user-data"), "utf8")).toBe("keep");
  });

  it("shares the exclusive lease with linked worktrees without touching their HEADs", async () => {
    await initRepo(); const linked = join(root, "linked"); await git("worktree", "add", "--detach", linked, "HEAD");
    await writeFile(join(root, ".gitignore"), "linked/\n");
    const cp = new Checkpointer(); const ctx = { point: "pre_tool" as const, sessionId: "primary", cwd: root, turn: 1, signal: new AbortController().signal, emitCheckpoint: async () => {} };
    await cp.handler(ctx);
    await expect(new Checkpointer().handler({ ...ctx, sessionId: "linked", cwd: linked })).rejects.toThrow("ownership uncertain");
    await cp.endSession("primary");
    const other = new Checkpointer(); await other.handler({ ...ctx, sessionId: "linked", cwd: linked }); await other.endSession("linked");
    expect((await execFile("git", ["rev-parse", "HEAD"], { cwd: linked })).stdout.trim()).toBe(await git("rev-parse", "HEAD"));
  });
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
    const checkpointPaths = await git("ls-tree", "-r", "--name-only", "refs/agentrig/session_one/1");
    expect(checkpointPaths).not.toContain(".agentrig/");
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

  it("rejects broken repository metadata instead of degrading it as a non-Git directory", async () => {
    await writeFile(join(root, ".git"), `gitdir: ${join(root, "missing-worktree-metadata")}\n`);
    const checkpointer = new Checkpointer();
    const emitted: Array<{ type: string }> = [];

    await expect(checkpointer.handler({
      point: "pre_tool",
      sessionId: "broken_metadata",
      cwd: root,
      turn: 1,
      tool: { name: "write", input: {} },
      permission: "write",
      signal: new AbortController().signal,
      emitCheckpoint: async (event) => { emitted.push(event); },
    })).rejects.toBeDefined();
    expect(emitted).toEqual([]);
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

  it("does nothing for explicitly read-only tools", async () => {
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
      store: new SessionStore({ root: join(root, ".agentrig", "sessions") }),
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

  it("preserves binary bytes exactly and snapshots symlinks without reading their targets", async () => {
    await initRepo();
    const bytes = Buffer.from([0, 255, 1, 2, 13, 10, 128, 64]);
    await writeFile(join(root, "binary.dat"), bytes);
    const outside = join(tmpdir(), `agentrig-secret-${Date.now()}`);
    await writeFile(outside, "outside secret");
    try {
      if (process.platform !== "win32") await symlink(outside, join(root, "outside-link"));
      const session = agent([
        [call("w1", "write", { path: "after.txt", content: "after" }), usage, stop("tool_use")],
        [usage, stop("end_turn")],
      ], [writeTool()]).run("write", { cwd: root, id: "binary_and_link" });
      await collect(session);
      await session.done;

      const expectedHash = await git("hash-object", "binary.dat");
      expect(await git("rev-parse", "refs/agentrig/binary_and_link/1:binary.dat")).toBe(expectedHash);
      if (process.platform !== "win32") {
        expect(await git("cat-file", "-p", "refs/agentrig/binary_and_link/1:outside-link")).toBe(outside);
        expect(await git("ls-tree", "refs/agentrig/binary_and_link/1", "outside-link")).toContain("120000");
      }
    } finally {
      await rm(outside, { force: true });
    }
  });

  it("reuses an existing checkpoint ref on resume instead of overwriting its pre-write state", async () => {
    await initRepo();
    const checkpointer = new Checkpointer();
    const emitted: CheckpointHookEvent[] = [];
    const context = {
      point: "pre_tool" as const,
      sessionId: "resumed",
      cwd: root,
      turn: 1,
      tool: { name: "write", input: {} },
      permission: "write" as const,
      signal: new AbortController().signal,
      emitCheckpoint: async (event: CheckpointHookEvent) => { emitted.push(event); },
    };
    await checkpointer.handler(context);
    const original = await git("rev-parse", "refs/agentrig/resumed/1");
    await checkpointer.endSession("resumed");
    await writeFile(join(root, "tracked.txt"), "new dirty state\n");
    await new Checkpointer().handler(context);

    expect(await git("rev-parse", "refs/agentrig/resumed/1")).toBe(original);
    expect(emitted.at(-1)?.commit).toBe(original);
    expect(await git("show", "refs/agentrig/resumed/1:tracked.txt")).toBe("committed");
  });

  it("rejects a symbolic checkpoint ref without moving the target branch", async () => {
    await initRepo();
    const head = await git("rev-parse", "HEAD");
    await git("symbolic-ref", "refs/agentrig/symbolic/1", "refs/heads/master").catch(async () => {
      await git("symbolic-ref", "refs/agentrig/symbolic/1", "refs/heads/main");
    });
    const context = {
      point: "pre_tool" as const,
      sessionId: "symbolic",
      cwd: root,
      turn: 1,
      tool: { name: "write", input: {} },
      permission: "write" as const,
      signal: new AbortController().signal,
      emitCheckpoint: async () => {},
    };

    await expect(new Checkpointer().handler(context)).rejects.toThrow("is symbolic");
    expect(await git("rev-parse", "HEAD")).toBe(head);
  });

  it("refuses sparse checkouts rather than claiming complete coverage", async () => {
    await initRepo();
    await mkdir(join(root, "visible"));
    await mkdir(join(root, "hidden"));
    await writeFile(join(root, "visible", "file.txt"), "visible\n");
    await writeFile(join(root, "hidden", "file.txt"), "old hidden\n");
    await git("add", ".");
    await git("commit", "-qm", "sparse baseline");
    await git("sparse-checkout", "init", "--cone");
    await git("sparse-checkout", "set", "visible");
    await mkdir(join(root, "hidden"), { recursive: true });
    await writeFile(join(root, "hidden", "file.txt"), "dirty hidden\n");

    const session = agent([
      [call("w1", "write", { path: "after.txt", content: "after" }), usage, stop("tool_use")],
      [usage, stop("end_turn")],
    ], [writeTool()]).run("write", { cwd: root, id: "sparse" });
    const events = await collect(session);
    await session.done;

    expect(events.some(e => e.type === "tool.denied")).toBe(true);
    await expect(git("show-ref", "--verify", "refs/agentrig/sparse/1")).rejects.toThrow();
    expect(await readFile(join(root, "hidden", "file.txt"), "utf8")).toBe("dirty hidden\n");
  });

  it("refuses submodules instead of omitting their dirty files", async () => {
    await initRepo();
    const child = await mkdtemp(join(tmpdir(), "agentrig-submodule-"));
    try {
      await execFile("git", ["init", "-q"], { cwd: child });
      await execFile("git", ["config", "user.name", "AgentRig Test"], { cwd: child });
      await execFile("git", ["config", "user.email", "test@agentrig.invalid"], { cwd: child });
      await writeFile(join(child, "nested.txt"), "committed child\n");
      await execFile("git", ["add", "nested.txt"], { cwd: child });
      await execFile("git", ["commit", "-qm", "child"], { cwd: child });
      await git("-c", "protocol.file.allow=always", "submodule", "add", "-q", child, "sub");
      await git("commit", "-qam", "add submodule");
      await writeFile(join(root, "sub", "nested.txt"), "dirty child bytes that must not be embedded\n");

      const session = agent([
        [call("w1", "write", { path: "after.txt", content: "after" }), usage, stop("tool_use")],
        [usage, stop("end_turn")],
      ], [writeTool()]).run("write", { cwd: root, id: "submodule" });
      const events = await collect(session);
      await session.done;

      expect(events.some(e => e.type === "tool.denied")).toBe(true);
      await expect(git("show-ref", "--verify", "refs/agentrig/submodule/1")).rejects.toThrow();
      await expect(git("rev-parse", "refs/agentrig/submodule/1:sub/nested.txt")).rejects.toThrow();
    } finally {
      await rm(child, { recursive: true, force: true });
    }
  });

  it("fails closed on corrupt HEAD instead of silently creating an empty-parent checkpoint", async () => {
    await initRepo();
    await writeFile(join(root, ".git", "HEAD"), `${"1".repeat(40)}\n`);
    const context = {
      point: "pre_tool" as const,
      sessionId: "corrupt_head",
      cwd: root,
      turn: 1,
      tool: { name: "write", input: {} },
      permission: "write" as const,
      signal: new AbortController().signal,
      emitCheckpoint: async () => {},
    };

    await expect(new Checkpointer().handler(context)).rejects.toThrow();
    await expect(git("show-ref", "--verify", "refs/agentrig/corrupt_head/1")).rejects.toThrow();
  });

  it("fails closed when the checkpoint ref cannot be updated", async () => {
    await initRepo();
    await git("update-ref", "refs/agentrig/ref_failure/1/child", "HEAD");
    const context = {
      point: "pre_tool" as const,
      sessionId: "ref_failure",
      cwd: root,
      turn: 1,
      tool: { name: "write", input: {} },
      permission: "write" as const,
      signal: new AbortController().signal,
      emitCheckpoint: async () => {},
    };

    await expect(new Checkpointer().handler(context)).rejects.toThrow();
    await expect(git("show-ref", "--verify", "refs/agentrig/ref_failure/1")).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "does not execute Git clean filters during checkpoint capture",
    async () => {
      await initRepo();
      const filter = join(root, "churn-filter.sh");
      await writeFile(filter, "#!/bin/sh\ncat\nprintf x >> sentinel.txt\n");
      await chmod(filter, 0o755);
      await writeFile(join(root, ".gitattributes"), "churn.txt filter=agentrig-churn\n");
      await writeFile(join(root, "churn.txt"), "filtered\n");
      await writeFile(join(root, "sentinel.txt"), "start\n");
      await git("add", ".gitattributes", "churn.txt", "sentinel.txt");
      await git("commit", "-qm", "filter baseline");
      await git("config", "filter.agentrig-churn.clean", filter);
      await writeFile(join(root, "churn.txt"), "dirty\n");
      const context = {
        point: "pre_tool" as const,
        sessionId: "worktree_churn",
        cwd: root,
        turn: 1,
        tool: { name: "write", input: {} },
        permission: "write" as const,
        signal: new AbortController().signal,
        emitCheckpoint: async () => {},
      };

      const checkpoint = new Checkpointer();
      await checkpoint.handler(context);
      expect(await git("show", "refs/agentrig/worktree_churn/1:churn.txt")).toBe("dirty");
      expect(await readFile(join(root, "sentinel.txt"), "utf8")).toBe("start\n");
      await checkpoint.endSession(context.sessionId);
    },
  );

  it("retries checkpoint event persistence without replacing the snapshot ref", async () => {
    await initRepo();
    const checkpointer = new Checkpointer();
    let appends = 0;
    const context = {
      point: "pre_tool" as const,
      sessionId: "append_failure",
      cwd: root,
      turn: 1,
      tool: { name: "write", input: {} },
      permission: "write" as const,
      signal: new AbortController().signal,
      emitCheckpoint: async () => {
        appends += 1;
        if (appends === 1) throw new Error("session disk full");
      },
    };

    await expect(checkpointer.handler(context)).rejects.toThrow("session disk full");
    const original = await git("rev-parse", "refs/agentrig/append_failure/1");
    await expect(checkpointer.handler(context)).resolves.toEqual({ action: "continue" });
    expect(await git("rev-parse", "refs/agentrig/append_failure/1")).toBe(original);
    expect(appends).toBe(2);
  });
});
