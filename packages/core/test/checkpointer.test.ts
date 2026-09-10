import { execFile as execFileCallback } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Checkpointer,
  worktreeCheckpointNamespace,
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

// Multiple real Git scans exceed Vitest's 5s default on Windows; production deadlines are unchanged.
vi.setConfig({ testTimeout: 30_000 });

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
let checkpointPrefix: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentrig-checkpointer-"));
  checkpointPrefix = worktreeCheckpointNamespace(join(await realpath(root), ".git"));
});
afterEach(async () => {
  // A fixture that fails before reaching its own restoration must not leak frozen timers: every
  // later test that waits on a real deadline would then hang or silently skip its timeout.
  vi.useRealTimers();
  // Sessions join their owned work before cleanup; Windows can still transiently refuse
  // directory deletion. Bound OS-level retries without weakening any timeout assertion.
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

/** Bounded fixture cleanup that never lets its own failure replace the assertion that failed.
 *  A cleanup failure on its own is still a failure — it is only demoted, never swallowed. */
async function settleFixture(failure: { error: unknown } | undefined, cleanup: () => Promise<void>): Promise<void> {
  let cleanupError: unknown;
  try { await cleanup(); } catch (error) { cleanupError = error; }
  if (failure !== undefined) {
    if (cleanupError !== undefined && failure.error instanceof Error && failure.error.cause === undefined) {
      failure.error.cause = cleanupError;
    }
    throw failure.error;
  }
  if (cleanupError !== undefined) throw cleanupError;
}

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
    const refs = await git("for-each-ref","--format=%(refname) %(objectname)",checkpointPrefix);
    const result = await undoSession(store,session.id,{cwd:root,toTurn:1});
    expect(result.restored).toBe(true);
    expect(await readFile(join(root,"tracked.txt"))).toEqual(before);
    expect(await readFile(join(root,"untracked.txt"),"utf8")).toBe("precious\r\n");
    await expect(readFile(join(root,"new.txt"))).rejects.toThrow();
    expect(await readFile(join(root,"ignored.txt"),"utf8")).toBe("ignored external bytes");
    expect(await readFile(join(root,".git","index"))).toEqual(index);
    expect(await git("rev-parse","HEAD")).toBe(head); expect(await git("log","--format=%H")).toBe(log);
    expect(await git("for-each-ref","--format=%(refname) %(objectname)",checkpointPrefix)).toBe(refs);
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
    await expect(undoSession(store,session.id,{cwd:root})).rejects.toThrow("legacy repository-wide lock");
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
    expect(await git("show", `${checkpointPrefix}/effects/1:tracked.txt`)).toBe("committed");
    expect(await git("show", `${checkpointPrefix}/effects/2:tracked.txt`)).toBe("shell");
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
    const { stdout } = await execFile("git", ["show", `${checkpointPrefix}/raw_bytes/1:tracked.txt`], { cwd: root, encoding: "buffer" });
    expect(stdout).toEqual(Buffer.from("raw\r\nbytes\r\n"));
    expect(await readFile(join(root, ".git", "index"))).toEqual(index);
    expect(await readFile(join(root, "ignored.txt"), "utf8")).toBe("secret excluded");
    await expect(git("show", `${checkpointPrefix}/raw_bytes/1:ignored.txt`)).rejects.toThrow();
    await rm(join(root, "tracked.txt"));
    const removed = agent([[call("write", "write", { path: "after.txt", content: "next" }), usage, stop("tool_use")], [usage, stop("end_turn")]], [writeTool()])
      .run("write", { cwd: root, id: "deleted" });
    await collect(removed); await removed.done;
    await expect(git("show", `${checkpointPrefix}/deleted/1:tracked.txt`)).rejects.toThrow();
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
    await expect(git("show-ref", "--verify", `${checkpointPrefix}/changed/1`)).rejects.toThrow();
    await cp.endSession("changed");
  });

  it("captures an unborn repository without requiring a user Git identity", async () => {
    await git("init", "-q"); await writeFile(join(root, "before.txt"), "before");
    const s = agent([[call("w", "write", { path: "before.txt", content: "after" }), usage, stop("tool_use")], [usage, stop("end_turn")]], [writeTool()])
      .run("write", { cwd: root, id: "unborn" });
    await collect(s); await s.done;
    expect(await git("show", `${checkpointPrefix}/unborn/1:before.txt`)).toBe("before");
    await expect(git("rev-parse", "--verify", "HEAD")).rejects.toThrow();
  });

  it("bounds a hung quiescence callback and settles the session without executing a mutation", async () => {
    await initRepo();
    const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
    let entered!: (signal: AbortSignal) => void, release!: () => void;
    const ready = new Promise<AbortSignal>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let guardReturned = false;
    const cp = new Checkpointer({ timeoutMs: 30, assertQuiescent: async ctx => { entered(ctx.signal); await blocked; guardReturned = true; } });
    // Freeze only deadline timers: real Git discovery must finish before testing the hung guard.
    // Advancing time before readiness could deny on Git startup and never exercise this callback.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let watchdog!: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      watchdog = realSetTimeout(() => reject(new Error("hung guard fixture did not reach readiness or settle")), 5000);
    });
    // Constructed inside the guarded body: a synchronous agent/session failure here must still
    // release the callback, restore real timers and disarm the watchdog.
    let session: ReturnType<ReturnType<typeof agent>["run"]> | undefined;
    let collected: Promise<HarnessEvent[]> | undefined;
    let failure: { error: unknown } | undefined;
    try {
      session = agent([[call("w", "write", { path: "tracked.txt", content: "unsafe" }), usage, stop("tool_use")], [usage, stop("end_turn")]],
        [writeTool()], { checkpointer: cp }).run("write", { cwd: root, id: "hung_guard" });
      collected = collect(session);
      const signal = await Promise.race([ready, deadline]);
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(29);
      expect(signal.aborted).toBe(false);
      expect(guardReturned).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signal.aborted).toBe(true);
      expect(guardReturned).toBe(false);
      const events = await Promise.race([collected, deadline]);
      await Promise.race([session.done, deadline]);
      expect(events.some(e => e.type === "tool.denied")).toBe(true);
      expect(events.some(e => e.type === "checkpoint.created")).toBe(false);
      expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("committed\n");
    } catch (error) { failure = { error }; }
    release(); session?.control.abort();
    vi.useRealTimers();
    realClearTimeout(watchdog);
    await settleFixture(failure, async () => {
      // A fired readiness watchdog must not short-circuit the owned session's cleanup join.
      const cleanupDeadline = new Promise<never>((_, reject) => {
        watchdog = realSetTimeout(() => reject(new Error("hung guard fixture cleanup did not settle")), 5000);
      });
      try { await Promise.race([Promise.all([collected, session?.done]), cleanupDeadline]); }
      finally { realClearTimeout(watchdog); }
    });
  });

  it("preserves the primary fixture failure when its bounded cleanup also fails", async () => {
    const primary = new Error("hung guard fixture assertion failed");
    const cleanupFailure = new Error("hung guard fixture cleanup did not settle");
    let joined = false;
    await expect(settleFixture({ error: primary }, async () => { joined = true; throw cleanupFailure; })).rejects.toBe(primary);
    expect(joined).toBe(true); // the bounded join is still attempted, not skipped
    expect(primary.cause).toBe(cleanupFailure);
  });

  it("reports a cleanup-only failure and stays silent when both succeed", async () => {
    const cleanupFailure = new Error("hung guard fixture cleanup did not settle");
    await expect(settleFixture(undefined, async () => { throw cleanupFailure; })).rejects.toBe(cleanupFailure);
    let joined = false;
    await expect(settleFixture(undefined, async () => { joined = true; })).resolves.toBeUndefined();
    expect(joined).toBe(true);
  });

  it("leaves fake timers installed when checkpoint session construction throws", () => {
    // Same order as the hung guard fixture above: deadline timers are frozen before the checkpoint
    // session exists, so a synchronous construction failure escapes before any local restoration.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    expect(() => agent([[usage, stop("end_turn")]], [writeTool()], { hookTimeoutMs: 0 })).toThrow("checkpoint timeout");
    expect(vi.isFakeTimers()).toBe(true);
  });

  it("restores real timers for the next test after a leaked construction failure", async () => {
    // Pairs with the test directly above, which deliberately never restores them: only the
    // file-level afterEach stands between a failed setup and every later test silently hanging.
    expect(vi.isFakeTimers()).toBe(false);
    const started = Date.now();
    await new Promise<void>(resolve => { setTimeout(resolve, 5); });
    expect(Date.now() - started).toBeGreaterThanOrEqual(4);
  });

  it("joins an abandoned later-turn verification before releasing the session", async () => {
    await initRepo();
    const cp = new Checkpointer();
    const base = { point: "pre_tool" as const, sessionId: "later_turn", cwd: root, turn: 1,
      signal: new AbortController().signal, emitCheckpoint: async () => {} };
    await cp.handler(base);
    await writeFile(join(root, "tracked.txt"), "turn one");
    await cp.afterTool(base); // owned state, so turn 2 verifies before it registers its own attempt
    // A private temporary root: this verification's own state directory is the observable proof
    // that its Git work finished, and nothing else in this file writes there.
    const tmpEnv = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    const stateRoot = await mkdtemp(join(tmpdir(), "agentrig-later-turn-"));
    const aborting = new AbortController();
    let reached!: () => void;
    const verifying = new Promise<void>(resolve => { reached = resolve; });
    let settled = false;
    try {
      process.env.TMPDIR = process.env.TEMP = process.env.TMP = stateRoot;
      // Read once per covered path while the verification walks the worktree, so the abort below
      // lands with real Git work in flight rather than before or after it.
      const abandoned = cp.handler({ ...base, turn: 2, signal: aborting.signal,
        get checkpointExcludes(): string[] { reached(); return []; } });
      const observed = abandoned.then(() => { settled = true; }, () => { settled = true; });
      await verifying;
      aborting.abort(); // the hook timeout fires and the runner stops awaiting this handler
      await cp.endSession(base.sessionId);
      expect(settled).toBe(true);
      expect(await readdir(stateRoot)).toEqual([]);
      await observed;
      expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("turn one");
    } finally {
      for (const [name, value] of Object.entries(tmpEnv)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("preserves a replaced lease and refuses both mutation and cleanup", async () => {
    await initRepo(); const cp = new Checkpointer();
    const ctx = { point: "pre_tool" as const, sessionId: "replaced", cwd: root, turn: 1, signal: new AbortController().signal, emitCheckpoint: async () => {} };
    await cp.handler(ctx);
    const path = join(root, ".git", "agentrig-worktree-checkpoint.lock");
    await rename(path, path + ".original"); await mkdir(path); await writeFile(join(path, "user-data"), "keep");
    await expect(cp.handler(ctx)).rejects.toThrow("lease replaced");
    await expect(cp.endSession(ctx.sessionId)).rejects.toThrow("lease replaced");
    expect(await readFile(join(path, "user-data"), "utf8")).toBe("keep");
  });

  it("keeps independent leases in linked worktrees without touching their HEADs", async () => {
    await initRepo(); const linked = join(root, "linked"); await git("worktree", "add", "--detach", linked, "HEAD");
    await writeFile(join(root, ".gitignore"), "linked/\n");
    const cp = new Checkpointer(); const ctx = { point: "pre_tool" as const, sessionId: "primary", cwd: root, turn: 1, signal: new AbortController().signal, emitCheckpoint: async () => {} };
    await cp.handler(ctx);
    const other = new Checkpointer();
    await other.handler({ ...ctx, sessionId: "linked", cwd: linked });
    await cp.endSession("primary");
    await other.endSession("linked");
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
      `${checkpointPrefix}/session_one/1`,
      `${checkpointPrefix}/session_one/2`,
    ]);
    const firstCheckpoint = events.findIndex((event) => event.type === "checkpoint.created" && event.turn === 1);
    const firstWrite = events.findIndex((event) => event.type === "tool.call" && event.name === "write");
    expect(firstCheckpoint).toBeGreaterThan(-1);
    expect(firstCheckpoint).toBeLessThan(firstWrite);

    expect(await git("show", `${checkpointPrefix}/session_one/1:tracked.txt`)).toBe("dirty before turn one");
    expect(await git("show", `${checkpointPrefix}/session_one/1:untracked.txt`)).toBe("untracked before turn one");
    expect(await git("show", `${checkpointPrefix}/session_one/2:tracked.txt`)).toBe("first write");
    expect(await git("show", `${checkpointPrefix}/session_one/2:second.txt`)).toBe("second write");
    const checkpointPaths = await git("ls-tree", "-r", "--name-only", `${checkpointPrefix}/session_one/1`);
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
    await expect(git("show-ref", "--verify", `${checkpointPrefix}/reads_only/1`)).rejects.toThrow();
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
    await expect(git("show-ref", "--verify", `${checkpointPrefix}/denied_write/1`)).rejects.toThrow();
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
      expect(await git("rev-parse", `${checkpointPrefix}/binary_and_link/1:binary.dat`)).toBe(expectedHash);
      if (process.platform !== "win32") {
        expect(await git("cat-file", "-p", `${checkpointPrefix}/binary_and_link/1:outside-link`)).toBe(outside);
        expect(await git("ls-tree", `${checkpointPrefix}/binary_and_link/1`, "outside-link")).toContain("120000");
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
    const original = await git("rev-parse", `${checkpointPrefix}/resumed/1`);
    await checkpointer.endSession("resumed");
    await writeFile(join(root, "tracked.txt"), "new dirty state\n");
    await new Checkpointer().handler(context);

    expect(await git("rev-parse", `${checkpointPrefix}/resumed/1`)).toBe(original);
    expect(emitted.at(-1)?.commit).toBe(original);
    expect(await git("show", `${checkpointPrefix}/resumed/1:tracked.txt`)).toBe("committed");
  });

  it("rejects a symbolic checkpoint ref without moving the target branch", async () => {
    await initRepo();
    const head = await git("rev-parse", "HEAD");
    await git("symbolic-ref", `${checkpointPrefix}/symbolic/1`, "refs/heads/master").catch(async () => {
      await git("symbolic-ref", `${checkpointPrefix}/symbolic/1`, "refs/heads/main");
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
    await expect(git("show-ref", "--verify", `${checkpointPrefix}/sparse/1`)).rejects.toThrow();
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
      await expect(git("show-ref", "--verify", `${checkpointPrefix}/submodule/1`)).rejects.toThrow();
      await expect(git("rev-parse", `${checkpointPrefix}/submodule/1:sub/nested.txt`)).rejects.toThrow();
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
    await expect(git("show-ref", "--verify", `${checkpointPrefix}/corrupt_head/1`)).rejects.toThrow();
  });

  it("fails closed when the checkpoint ref cannot be updated", async () => {
    await initRepo();
    await git("update-ref", `${checkpointPrefix}/ref_failure/1/child`, "HEAD");
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
    await expect(git("show-ref", "--verify", `${checkpointPrefix}/ref_failure/1`)).rejects.toThrow();
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
      expect(await git("show", `${checkpointPrefix}/worktree_churn/1:churn.txt`)).toBe("dirty");
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
    const original = await git("rev-parse", `${checkpointPrefix}/append_failure/1`);
    await expect(checkpointer.handler(context)).resolves.toEqual({ action: "continue" });
    expect(await git("rev-parse", `${checkpointPrefix}/append_failure/1`)).toBe(original);
    expect(appends).toBe(2);
  });
});

it("sealing retains only the last two turn refs and preserves last retained undo", async () => {
  await initRepo();
  const branch = await git("rev-parse", "HEAD");
  const turns: ModelEvent[][] = Array.from({length: 5}, (_, i) => [call(String(i), "write", {path: "tracked.txt", content: `turn ${i+1}`}), stop("tool_use")]);
  turns.push([stop("end_turn")]);
  const session = agent(turns, [writeTool()]).run("change", {cwd: root, id: "retention"});
  const events = await collect(session); await session.done;
  const refs = (await git("for-each-ref", "--format=%(refname)", `${checkpointPrefix}/retention/`)).split("\n");
  expect(refs).toEqual([`${checkpointPrefix}/retention/4`, `${checkpointPrefix}/retention/5`, `${checkpointPrefix}/retention/sealed/6`]);
  expect(await git("rev-parse", "HEAD")).toBe(branch);
  expect(events.filter(e => e.type === "checkpoint.created")).toHaveLength(5);
  const store = new SessionStore({root: join(root, ".agentrig", "sessions")});
  await expect(undoSession(store, session.id, {cwd: root, toTurn: 1})).rejects.toThrow("checkpoint turn 1 is unavailable (pruned or missing); only the last two mutating-turn refs are retained");
  expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("turn 5");
  await undoSession(store, session.id, {cwd: root, toTurn: 4});
  expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("turn 3");
});

it("prune failure cannot publish a seal and successful seal observes already-pruned refs", async () => {
  await initRepo();
  const cp = new Checkpointer(); const events: CheckpointHookEvent[] = [];
  let refsAtSeal: string | undefined;
  const ctx = {point:"pre_tool" as const, sessionId:"atomicprune", cwd:root, turn:1,
    signal:new AbortController().signal, emitCheckpoint:async(e:CheckpointHookEvent)=>{
      if(e.type==="checkpoint.sealed") refsAtSeal=await git("for-each-ref","--format=%(refname)",`${checkpointPrefix}/atomicprune/`);
      events.push(e);
    }};
  try {
    for(let turn=1;turn<=4;turn++) {ctx.turn=turn;await cp.handler(ctx);await writeFile(join(root,"tracked.txt"),`turn ${turn}`);await cp.afterTool(ctx);}
    const lock=join(root,".git",...checkpointPrefix.split("/"),"atomicprune","1.lock");
    await writeFile(lock,"locked");
    await expect(cp.seal(ctx)).rejects.toThrow();
    expect(events.some(e=>e.type==="checkpoint.sealed")).toBe(false);
    const failedRefs=await git("for-each-ref","--format=%(refname)",`${checkpointPrefix}/atomicprune/`);
    expect(failedRefs.split("\n")).toHaveLength(4);
    expect(failedRefs).not.toContain("/sealed/");
    await rm(lock);
    await cp.seal(ctx);
    expect(refsAtSeal).toContain("/sealed/");
    expect(refsAtSeal).not.toMatch(/atomicprune\/[12](?:\n|$)/);
  } finally {await cp.endSession(ctx.sessionId);}
});

it("refuses two configured checkpointers instead of reporting a stray lock holder", () => {
  // Each instance keeps its own leases/owned state, so the second one's `lease` finds the first's
  // lock directory and reports "another session or retained lock exists" — which sends the operator
  // hunting for a process rather than at their own hook list.
  const build = (hooks: Checkpointer[]) => createAgent({
    provider: new FakeProvider([]), tools: [], permissions: new RulePolicy([], "allow"), hooks,
    systemPrompt: "test", store: new SessionStore({ root: join(root, ".agentrig", "sessions") }),
  });
  expect(() => build([new Checkpointer(), new Checkpointer()])).toThrow(/only one Checkpointer/);
  expect(() => build([new Checkpointer()])).not.toThrow();
});

it("names the path when a listed file is a directory in the worktree", async () => {
  await initRepo();
  // Git still lists `tracked.txt`; the worktree has a directory there. A nested repository looks
  // exactly the same from the capture loop, and the operator has to be told which path to inspect.
  await rm(join(root, "tracked.txt"));
  await mkdir(join(root, "tracked.txt"));
  const tool = writeTool();
  const session = agent([[call("a", "write", { path: "new.txt", content: "x" }), stop("tool_use")], [stop("end_turn")]], [tool])
    .run("write", { cwd: root, id: "file_to_dir" });
  const events = await collect(session);
  await session.done;
  const failure = events.find(e => e.type === "error" && e.message.includes("core:checkpointer"));
  expect(failure).toBeDefined();
  expect((failure as { message: string }).message).toContain('checkpoint path "tracked.txt" is a directory');
  expect((failure as { message: string }).message).toContain("nested repository or submodule");
  expect(events.filter(e => e.type === "tool.denied" && e.id === "a")).toHaveLength(1);
  // the tool never ran: a blocked checkpoint blocks the write
  await expect(readFile(join(root, "new.txt"), "utf8")).rejects.toThrow();
});

it("records a denial when the run aborts after the checkpoint and before the call", async () => {
  await initRepo();
  const session = agent([[call("a", "write", { path: "new.txt", content: "x" }), stop("tool_use")], [stop("end_turn")]], [writeTool()])
    .run("write", { cwd: root, id: "late_abort_denial" });
  const events: HarnessEvent[] = [];
  for await (const event of session.events) {
    events.push(event);
    // the narrow window this covers: the snapshot is durable, the tool has not been called
    if (event.type === "checkpoint.created") session.control.abort();
  }
  await session.done;
  expect(events.some(e => e.type === "checkpoint.created")).toBe(true);
  // the snapshot is durable and the tool never ran, so every abort in this window — whether the
  // hook runner reports it or the post-gate check catches it — must leave a denial receipt
  expect(events.filter(e => e.type === "error" && e.message.includes("aborted"))).not.toEqual([]);
  expect(events.filter(e => e.type === "tool.denied" && e.id === "a")).toHaveLength(1);
  // an authorized tool with no result and no receipt is indistinguishable from a lost append
  expect(events.some(e => e.type === "tool.call" && e.id === "a")).toBe(false);
  await expect(readFile(join(root, "new.txt"), "utf8")).rejects.toThrow();
});

it("a throwing effects descriptor is contained, and the call is treated as mutating", async () => {
  await initRepo();
  const tool: AnyTool = { ...writeTool(), effects: () => { throw new Error("descriptor defect"); } };
  const session = agent([[call("a", "write", { path: "new.txt", content: "x" }), stop("tool_use")], [stop("end_turn")]], [tool])
    .run("write", { cwd: root, id: "throwing_effects" });
  const events = await collect(session);
  await session.done;
  // not a fatal turn: the run continues, the descriptor failure is visible, and the conservative
  // unknown effect means the checkpoint is still taken before the write lands
  expect(events.filter(e => e.type === "error" && e.message.includes("effects descriptor failed"))).toHaveLength(1);
  expect(events.some(e => e.type === "checkpoint.created")).toBe(true);
  expect(events.find(e => e.type === "tool.result" && e.id === "a")).toMatchObject({ ok: true });
  expect(await readFile(join(root, "new.txt"), "utf8")).toBe("x");
});

it("a second undo says the worktree already matches the turn, not that a stranger wrote to it", async () => {
  await initRepo();
  const session = agent([
    [call("a", "write", { path: "tracked.txt", content: "first" }), stop("tool_use")],
    [call("b", "write", { path: "tracked.txt", content: "second" }), stop("tool_use")],
    [stop("end_turn")],
  ], [writeTool()]).run("change", { cwd: root, id: "undo_repeat" });
  await collect(session); await session.done;
  const store = new SessionStore({ root: join(root, ".agentrig", "sessions") });

  expect((await undoSession(store, session.id, { cwd: root })).turn).toBe(2);
  expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("first");
  // the "non-session change" the second run sees is the first run's own restoration
  await expect(undoSession(store, session.id, { cwd: root })).rejects.toThrow(/worktree already matches turn 2/);
  await expect(undoSession(store, session.id, { cwd: root })).rejects.toThrow(/nothing to restore/);
  // still refused, and still nothing written
  expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("first");
  // an actual foreign change is still reported as one
  await writeFile(join(root, "external.txt"), "human change");
  await expect(undoSession(store, session.id, { cwd: root })).rejects.toThrow("non-session changes");
});

it("replays the recorded seal refusal and recorded references when undo has no seal", async () => {
  await initRepo();
  // a session_end hook that writes a covered file is exactly what invalidates the seal
  const ingest = { point: "session_end" as const, id: "fixture:ingest",
    handler: async () => { await writeFile(join(root, "tracked.txt"), "written by session-end maintenance"); return { action: "continue" as const }; } };
  const session = createAgent({
    provider: new FakeProvider([[call("a", "write", { path: "tracked.txt", content: "first" }), stop("tool_use")], [stop("end_turn")]]),
    tools: [writeTool()], permissions: new RulePolicy([], "allow"), hooks: [new Checkpointer(), ingest],
    systemPrompt: "test", store: new SessionStore({ root: join(root, ".agentrig", "sessions") }), budget: { maxTurns: 10 },
  }).run("change", { cwd: root, id: "undo_seal_refused" });
  const events = await collect(session); await session.done;
  expect(events.filter(e => e.type === "checkpoint.sealed")).toHaveLength(0);
  expect(events.some(e => e.type === "checkpoint.created")).toBe(true);

  const store = new SessionStore({ root: join(root, ".agentrig", "sessions") });
  const failure = await undoSession(store, session.id, { cwd: root }).then(() => undefined, (error: Error) => error);
  expect(failure).toBeDefined();
  expect(failure!.message).toContain("no verified ownership seal");
  // the reason was recorded at session end and would otherwise never be read again
  expect(failure!.message).toContain("recorded refusal: checkpoint seal failed:");
  expect(failure!.message).toContain("session-end hooks such as memory ingest may change covered files");
  // Recorded references are named without claiming their present retention or safe restoration.
  expect(failure!.message).toContain(`recorded checkpoint (current retention not checked; not restorable without a seal): turn 1 at ${checkpointPrefix}/undo_seal_refused/1`);
  expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("written by session-end maintenance");
});

it("a hand-restored matching tree does not claim a prior undo or retained originals", async () => {
  await initRepo();
  const session = agent([[call("a", "write", { path: "tracked.txt", content: "first" }), stop("tool_use")],
    [call("b", "write", { path: "tracked.txt", content: "second" }), stop("tool_use")], [stop("end_turn")]], [writeTool()])
    .run("change", { cwd: root, id: "manual_match" });
  await collect(session); await session.done;
  const store = new SessionStore({ root: join(root, ".agentrig", "sessions") });
  await writeFile(join(root, "tracked.txt"), "first");
  const before = await readFile(store.pathFor(session.id));
  const error = await undoSession(store, session.id, { cwd: root }).catch(error => error as Error);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("worktree already matches turn 2");
  expect((error as Error).message).not.toContain("undo already applied");
  expect((error as Error).message).not.toContain("originals");
  expect((await readdir(join(root, ".git"))).filter(name => name.startsWith("agentrig-undo-"))).toEqual([]);
  expect(await readFile(store.pathFor(session.id))).toEqual(before);
});

it("bounds recorded refusal replay and names omissions without altering the journal", async () => {
  const store = new SessionStore({ root: join(root, ".agentrig", "sessions") }); const id = await store.create();
  await store.append(id, { type: "session.start", task: "fixture", cwd: root, provider: "fixture", model: "fixture" });
  for (let i = 0; i < 40; i++) {
    await store.append(id, { type: "error", fatal: false, message: "checkpoint seal failed: " + "x".repeat(1500) + "\u001b[31m" });
    await store.append(id, { type: "checkpoint.created", turn: i + 1, ref: `${checkpointPrefix}/${"x".repeat(128)}/${i + 1}`, tree: "a".repeat(40), commit: "b".repeat(40) });
  }
  await store.append(id, { type: "session.end", reason: "done" });
  const before = await readFile(store.pathFor(id)); const error = await undoSession(store, id).catch(error => error as Error);
  expect(error).toBeInstanceOf(Error); expect((error as Error).message.length).toBeLessThanOrEqual(4096);
  expect((error as Error).message).toContain("omitted 72 recorded entries");
  expect((error as Error).message).toContain("truncated"); expect((error as Error).message).not.toContain("\u001b");
  expect((error as Error).message).toContain("current retention not checked");
  expect(await readFile(store.pathFor(id))).toEqual(before);
});

for (const kind of ["deletion", "executable bit"] as const) {
// Windows chmod/stat do not expose POSIX execute bits. Keep deletion coverage independent.
it.skipIf(kind === "executable bit" && process.platform === "win32")(`round-trips ${kind}`, async () => {
  await initRepo();
  await writeFile(join(root, "script.sh"), "#!/bin/sh\noriginal\n", { mode: 0o644 });
  await writeFile(join(root, "doomed.txt"), "still here\n");
  await git("add", "script.sh", "doomed.txt");
  await git("commit", "-qm", "round trip baseline");

  const tool: AnyTool = { name: "mutate", description: "mutate", permission: "write", inputSchema: z.object({}),
    execute: async () => {
      if (kind === "executable bit") await chmod(join(root, "script.sh"), 0o755);
      else await rm(join(root, "doomed.txt"));
      return { output: null, display: "mutated" };
    } };
  const session = agent([[call("a", "mutate", {}), stop("tool_use")], [stop("end_turn")]], [tool])
    .run("mutate", { cwd: root, id: "undo_round_trip" });
  await collect(session); await session.done;
  if (kind === "executable bit") expect((await lstat(join(root, "script.sh"))).mode & 0o111).not.toBe(0);
  else await expect(readFile(join(root, "doomed.txt"))).rejects.toMatchObject({ code: "ENOENT" });

  const store = new SessionStore({ root: join(root, ".agentrig", "sessions") });
  expect((await undoSession(store, session.id, { cwd: root })).restored).toBe(true);
  // the executable bit is part of the snapshot, not just the bytes
  if (kind === "executable bit") expect((await lstat(join(root, "script.sh"))).mode & 0o111).toBe(0);
  expect(await readFile(join(root, "script.sh"), "utf8")).toBe("#!/bin/sh\noriginal\n");
  // and a deleted file comes back
  expect(await readFile(join(root, "doomed.txt"), "utf8")).toBe("still here\n");
});
}

it("refuses a file/directory collision as a collision, and restores nothing", async () => {
  await initRepo();
  // untracked, so the post-turn snapshot itself is capturable: the collision is only in the undo
  await writeFile(join(root, "slot"), "a plain file\n");
  const tool: AnyTool = { name: "mutate", description: "mutate", permission: "write", inputSchema: z.object({}),
    execute: async () => {
      await rm(join(root, "slot"));
      await mkdir(join(root, "slot"));
      await writeFile(join(root, "slot", "inner.txt"), "inside a directory\n");
      return { output: null, display: "mutated" };
    } };
  const session = agent([[call("a", "mutate", {}), stop("tool_use")], [stop("end_turn")]], [tool])
    .run("mutate", { cwd: root, id: "undo_collision_dir" });
  const events = await collect(session); await session.done;
  expect(events.filter(e => e.type === "checkpoint.sealed")).toHaveLength(1);

  const store = new SessionStore({ root: join(root, ".agentrig", "sessions") });
  const failure = await undoSession(store, session.id, { cwd: root }).then(() => undefined, (error: Error) => error);
  expect(failure!.message).toContain("undo refuses non-file path: slot");
  // not ".gitignore is hiding something": a directory is standing where a file belongs
  expect(failure!.message).toContain("a directory now occupies a path the checkpoint holds as a file");
  expect(failure!.message).not.toContain("ignored or unowned");
  // fail-closed: the collision is refused before any original is moved
  expect((await lstat(join(root, "slot"))).isDirectory()).toBe(true);
  expect(await readFile(join(root, "slot", "inner.txt"), "utf8")).toBe("inside a directory\n");
});
