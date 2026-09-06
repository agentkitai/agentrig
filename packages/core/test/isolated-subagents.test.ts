import { mkdtemp, mkdir, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, expect, it } from "vitest";
import { createAgent, parallel, RulePolicy, SessionStore, subagentTool, PermissionGrantRegistry,
  type AgentConfig, type AnyTool, type HarnessEvent, type ModelEvent, type ModelProvider } from "@agentkitai/agentrig-core";
import { git } from "../src/checkpointer.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
function latch() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
function provider(turns: ModelEvent[][]): ModelProvider {
  return { id: "inert", model: "inert", capabilities: { tools: true, parallelTools: true, caching: false, contextWindow: 100000 },
    async *stream() { yield* turns.shift() ?? [{ type: "stop", reason: "end_turn" }]; } };
}
const call = (id: string, name: string, input: unknown): ModelEvent => ({ type: "tool_use", id, name, input });
const stop: ModelEvent = { type: "stop", reason: "tool_use" };
async function fixture(count = 2, options: { parent?: Partial<AgentConfig>; child?: Partial<AgentConfig>; mutateTool?: (tool: AnyTool) => AnyTool; noGit?: boolean; prepare?: (repo: string) => Promise<void>; runThrows?: boolean; aliasedStore?: boolean; ordinary?: boolean; lazyChildStore?: boolean; pool?: { children: number; tokens: number; usd: number; live: number } } = {}) {
  const root = await mkdtemp(join(tmpdir(), "agentrig-isolated-")); roots.push(root);
  const repo = join(root, "repo"); await mkdir(repo);
  if (!options.noGit) { await git(repo, ["init"]); await git(repo, ["config", "user.name", "fixture"]); await git(repo, ["config", "user.email", "fixture@localhost"]); }
  await writeFile(join(repo, "shared.txt"), "committed\n");
  if (!options.noGit) { await git(repo, ["add", "shared.txt"]); await git(repo, ["commit", "-m", "fixture"]); }
  await writeFile(join(repo, "shared.txt"), "dirty baseline\n"); await writeFile(join(repo, "untracked.txt"), "untracked baseline\n");
  await writeFile(join(repo, "binary.dat"), Buffer.from([0, 1, 2]));
  await options.prepare?.(repo);
  if (options.aliasedStore) await symlink(repo, join(root, "repo-alias"), process.platform === "win32" ? "junction" : "dir");
  const store = new SessionStore({ root: join(options.aliasedStore ? join(root, "repo-alias") : repo, "runtime-logs") });
  const entered = Array.from({ length: count }, latch); const gates = Array.from({ length: count }, latch);
  const cwds: string[] = []; const seen: string[] = []; let built = 0;
  const base: AgentConfig = { provider: provider([]), store, systemPrompt: "inert local fixture", tools: [], repoMap: false, permissions: new RulePolicy([], "allow") };
  const tool = subagentTool({ isolation: "worktree", ...(options.pool ? { ancestorPools: [options.pool], childBudget: { maxTokens: 4 } } : {}), createAgent: options.runThrows ? () => ({ run() { throw new Error("injected synchronous child.run failure"); } }) : createAgent,
    childConfig: () => {
      const index = built++;
      const probe: AnyTool = { name: "probe", description: "local write fixture", inputSchema: z.object({}), permission: "write", paths: () => ["shared.txt", "binary.dat", `child-${index}.txt`], effects: "workspace",
        async execute(_input, ctx) {
          cwds[index] = ctx.cwd;
          seen[index] = await readFile(join(ctx.cwd, "shared.txt"), "utf8") + await readFile(join(ctx.cwd, "untracked.txt"), "utf8");
          entered[index]!.release(); await gates[index]!.promise; ctx.signal.throwIfAborted();
          await writeFile(join(ctx.cwd, "shared.txt"), `child ${index}\n`);
          await writeFile(join(ctx.cwd, "binary.dat"), Buffer.from([0, 255, index]));
          await writeFile(join(ctx.cwd, `child-${index}.txt`), "new child file\n");
          return { output: index, display: `child ${index}` };
        } };
      return { ...base, ...(options.lazyChildStore ? { store: new SessionStore({ root: join(root, "repo-alias", "nested", "child-logs") }) } : {}), tools: [probe], provider: provider([[call("write", "probe", {}), stop]]), ...options.child };
    } });
  const ordinaryDeclared = latch(); let ordinaryEntered = false;
  const ordinary: AnyTool = { name: "ordinary", description: "ordinary parent read", inputSchema: z.object({}), permission: "read", effects: "read-only",
    paths: () => { ordinaryDeclared.release(); return ["untracked.txt"]; },
    async execute(_input, ctx) { ordinaryEntered = true; return { output: "read", display: await readFile(join(ctx.cwd, "untracked.txt"), "utf8") }; } };
  const config = { ...base, tools: [options.mutateTool?.(tool) ?? tool, ...(options.ordinary ? [ordinary] : [])], turnStrategy: parallel(),
    provider: provider([[...Array.from({ length: count }, (_, n) => call(`child-${n}`, "subagent", { task: `local child ${n}` })), ...(options.ordinary ? [call("ordinary", "ordinary", {})] : []), stop]]), ...options.parent };
  const session = createAgent(config).run("run inert children", { cwd: repo });
  const finished = (async () => { const events: HarnessEvent[] = []; for await (const event of session.events) events.push(event); return { events, summary: await session.done }; })();
  return { root, repo, store, session, finished, entered, gates, cwds, seen, built: () => built, ordinaryDeclared, ordinaryEntered: () => ordinaryEntered };
}
function results(events: HarnessEvent[]) { return events.filter(event => event.type === "tool.result"); }
async function ready(work: Promise<unknown>, finished: Promise<{ events: HarnessEvent[] }>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([work, finished.then(result => { throw Error(`session settled before expected stage: ${results(result.events).map(event => event.display).join("\n")}`); }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(Error("expected child stage not reached within 20s")), 20_000); })]); }
  finally { clearTimeout(timer); }
}

it("runs two writer children concurrently in distinct raw-baseline worktrees and returns checked parent diffs", async () => {
  const f = await fixture();
  try {
    await ready(Promise.all(f.entered.map(gate => gate.promise)), f.finished);
    expect(new Set(f.cwds).size).toBe(2); expect(f.cwds).not.toContain(f.repo);
    expect(f.seen).toEqual(["dirty baseline\nuntracked baseline\n", "dirty baseline\nuntracked baseline\n"]);
    expect(await readFile(join(f.repo, "shared.txt"), "utf8")).toBe("dirty baseline\n");
    const secondFinished = (async () => { for await (const event of f.session.events) if (event.type === "tool.result" && event.id === "child-1") return; throw Error("second child did not complete"); })();
    f.gates[1]!.release(); await secondFinished; f.gates[0]!.release();
    const { events, summary } = await f.finished; expect(summary.reason).toBe("done");
    expect(results(events).every(event => event.ok)).toBe(true);
    expect(results(events).map(event => event.id)).toEqual(["child-1", "child-0"]);
    expect(results(events).map(event => event.display).join("\n")).toContain("candidate.patch");
    const snapshot = await f.store.readSnapshot(f.session.id);
    expect(snapshot!.messages.flatMap(message => message.content).filter(block => block.type === "tool_result").map(block => block.toolUseId)).toEqual(["child-0", "child-1"]);
    expect(events.map(event => event.seq)).toEqual(events.map((_event, n) => n));
    for (const cwd of f.cwds) {
      const manifest = JSON.parse(await readFile(join(cwd, "..", "candidate.json"), "utf8"));
      expect(manifest.ready).toBe(true); expect(manifest.changed).toContain("shared.txt");
      expect(await readFile(manifest.patchPath, "utf8")).toContain("GIT binary patch");
      await git(f.repo, ["apply", "--check", manifest.patchPath]);
    }
    // Actual normal parent permission dispatch: denial prevents application, then explicit
    // approval runs the same local Git action. Worktree handoff itself grants nothing.
    let applied = 0;
    const patch = join(f.cwds[0]!, "..", "candidate.patch");
    const apply: AnyTool = { name: "apply_candidate", description: "trusted local fixture", inputSchema: z.object({}), permission: "write", paths: () => ["shared.txt", "binary.dat", "child-0.txt"],
      async execute(_input, ctx) { await git(ctx.cwd, ["apply", "--check", patch]); await git(ctx.cwd, ["apply", patch]); applied++; return { output: "applied", display: "applied" }; } };
    for (const decision of ["deny", "allow"] as const) {
      const agent = createAgent({ provider: provider([[call("apply", apply.name, {}), stop]]), store: f.store, tools: [apply], systemPrompt: "inert", repoMap: false, permissions: new RulePolicy([], decision) });
      const run = agent.run("apply candidate", { cwd: f.repo }); for await (const _event of run.events) {} await run.done;
      expect(applied).toBe(decision === "deny" ? 0 : 1);
    }
    expect(await readFile(join(f.repo, "shared.txt"), "utf8")).toBe("child 0\n");
    expect(await readFile(join(f.repo, "binary.dat"))).toEqual(Buffer.from([0, 255, 0]));
    expect(await readFile(join(f.repo, "untracked.txt"), "utf8")).toBe("untracked baseline\n");
    // The conflicting second patch cannot silently overwrite the first.
    await expect(git(f.repo, ["apply", "--check", join(f.cwds[1]!, "..", "candidate.patch")])).rejects.toThrow();
  } finally { f.gates.forEach(gate => gate.release()); await f.finished; }
}, 30_000);

it.each(["path", "cwd"])("does not remap a delegable parent %s grant into the isolated child", async scope => {
  const grants = new PermissionGrantRegistry(); let childAsks = 0;
  const policy = new RulePolicy([], "ask");
  const onAsk: NonNullable<AgentConfig["onAsk"]> = async request => {
    if (request.tool !== "subagent") { childAsks++; return "deny"; }
    grants.grant({ subject: grants.subject, operation: { tool: "probe", class: "write" },
      resource: scope === "path" ? { kind: "path-prefix", path: join(request.cwd, "shared.txt") } : "*", constraints: scope === "cwd" ? { cwd: request.cwd } : {},
      duration: { kind: "session", id: grants.context.sessionId! }, delegable: true, decision: "allow" });
    return "allow";
  };
  const f = await fixture(1, { parent: { permissions: policy, permissionGrants: grants, onAsk }, child: { permissions: policy, permissionGrants: grants, onAsk } });
  const { events } = await f.finished;
  expect(childAsks).toBe(1); expect(f.cwds).toEqual([]);
  expect(grants.inspect()[0]!.matchedDecisions).toBe(0);
  const spawn = events.find(event => event.type === "subagent.spawn"); if (spawn?.type !== "subagent.spawn") throw Error("no child");
  expect(await f.store.readAll(spawn.id)).toContainEqual(expect.objectContaining({ type: "tool.denied", name: "probe" }));
}, 30_000);

it("a copied factory tool cannot recover the private isolated runtime binding", async () => {
  const f = await fixture(1, { mutateTool: tool => ({ ...tool }) });
  const { events } = await f.finished;
  expect(results(events)[0]!.ok).toBe(false);
  expect(results(events)[0]!.display).toContain("requires the live tool execution context");
  await expect(readdir(join(f.repo, ".git", "agentrig-isolated"))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["symlink", "oversize"])("refuses unsupported %s baseline before spawning a child", async kind => {
  const f = await fixture(1, { prepare: async repo => {
    if (kind === "symlink") { await mkdir(join(repo, "target-dir")); await writeFile(join(repo, "target-dir", "content"), "content"); await symlink(join(repo, "target-dir"), join(repo, "alias-link"), process.platform === "win32" ? "junction" : "dir"); }
    else await writeFile(join(repo, "oversize.bin"), Buffer.alloc(16 * 1024 * 1024 + 1));
  } });
  const { events } = await f.finished; expect(results(events)[0]!.ok).toBe(false);
  expect(events.some(event => event.type === "subagent.spawn")).toBe(false);
}, 30_000);

it("does not execute configured smudge filters while preparing a dirty baseline", async () => {
  const f = await fixture(1, { prepare: async repo => {
    await writeFile(join(repo, ".gitattributes"), "shared.txt filter=tripwire\n");
    await git(repo, ["config", "filter.tripwire.smudge", "command-that-must-never-run"]);
    await git(repo, ["config", "filter.tripwire.required", "true"]);
  } });
  try { await ready(f.entered[0]!.promise, f.finished); expect(f.seen[0]).toBe("dirty baseline\nuntracked baseline\n"); f.gates[0]!.release();
    expect(results((await f.finished).events)[0]!.ok).toBe(true);
  } finally { f.gates[0]!.release(); await f.finished; }
}, 30_000);

it("does not prepare a child or artifact when parent permission denies", async () => {
  const f = await fixture(1, { parent: { permissions: new RulePolicy([], "deny") } });
  const result = await f.finished; expect(f.built()).toBe(0); expect(result.events.some(event => event.type === "tool.denied")).toBe(true);
  await expect(readdir(join(f.repo, ".git", "agentrig-isolated"))).rejects.toMatchObject({ code: "ENOENT" });
});
it.each([false, true])("canonicalizes aliased stores without copying transcripts or broadening a missing suffix (lazy child=%s)", async lazyChildStore => {
  const f = await fixture(1, { aliasedStore: true, lazyChildStore });
  try {
    await ready(f.entered[0]!.promise, f.finished);
    await expect(readdir(join(f.cwds[0]!, "runtime-logs"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.seen[0]).toBe("dirty baseline\nuntracked baseline\n");
    f.gates[0]!.release();
    expect(results((await f.finished).events)[0]!.ok).toBe(true);
  } finally { f.gates[0]!.release(); await f.finished; }
}, 30_000);
it("keeps an ordinary parent read behind both live isolated children", async () => {
  const f = await fixture(2, { ordinary: true });
  try {
    await ready(Promise.all(f.entered.map(gate => gate.promise)), f.finished);
    await ready(f.ordinaryDeclared.promise, f.finished);
    // A bounded timing-sensitive negative observation; the positive child-overlap proof
    // above is the deterministic shared-entry barrier, not this observation window.
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(f.ordinaryEntered()).toBe(false);
    f.gates.forEach(gate => gate.release());
    const { events } = await f.finished;
    const parentCall = events.find(event => event.type === "tool.call" && event.name === "ordinary")!;
    expect(parentCall.seq).toBeGreaterThan(Math.max(...results(events).filter(event => event.id.startsWith("child-")).map(event => event.seq)));
    expect(f.ordinaryEntered()).toBe(true);
  } finally { f.gates.forEach(gate => gate.release()); await f.finished; }
}, 30_000);
it("rejects enforcing parent sandbox without requesting an outside escape", async () => {
  let asks = 0;
  const f = await fixture(1, { parent: { sandbox: { mode: "workspace-write", provider: { prepare: command => command } }, onAsk: async () => { asks++; return "allow"; } } });
  const { events } = await f.finished; expect(asks).toBe(0);
  expect(f.built()).toBe(0);
  expect(results(events)[0]!.display).toContain("unavailable inside an enforcing parent sandbox");
  expect(events.some(event => event.type === "subagent.spawn")).toBe(false);
});
it("retains a stale candidate and refuses to label it ready after a parent edit", async () => {
  const f = await fixture(1);
  try { await ready(f.entered[0]!.promise, f.finished); await writeFile(join(f.repo, "shared.txt"), "external edit\n"); f.gates[0]!.release();
    const { events } = await f.finished; expect(results(events)[0]!.ok).toBe(false); expect(results(events)[0]!.display).toContain("candidate is stale");
    expect(JSON.parse(await readFile(join(f.cwds[0]!, "..", "candidate.json"), "utf8")).ready).toBe(false);
    expect(await readFile(join(f.repo, "shared.txt"), "utf8")).toBe("external edit\n");
  } finally { f.gates[0]!.release(); await f.finished; }
}, 30_000);
it("retains abort artifacts without a candidate or late parent mutation", async () => {
  const f = await fixture(1);
  try { await ready(f.entered[0]!.promise, f.finished); f.session.control.abort(); f.gates[0]!.release(); await f.finished;
    expect(await readFile(join(f.repo, "shared.txt"), "utf8")).toBe("dirty baseline\n");
    await expect(readFile(join(f.cwds[0]!, "..", "candidate.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { f.gates[0]!.release(); await f.finished; }
}, 30_000);
it.each(["non-git", "retention", "capacity", "child.run"])("fails closed for %s without writing parent files", async kind => {
  const pool = { children: 0, tokens: 0, usd: 0, live: 0 };
  const f = await fixture(1, { pool, noGit: kind === "non-git", runThrows: kind === "child.run",
    ...(kind === "retention" || kind === "capacity" ? { prepare: async (repo: string) => { const root = join(repo, ".git", "agentrig-isolated"); await mkdir(root);
      if (kind === "retention") for (let n = 0; n < 8; n++) await mkdir(join(root, `retained-${n}`));
      else { const file = join(root, "retained.bin"); await writeFile(file, ""); await truncate(file, 400 * 1024 * 1024); }
    } } : {}) });
  const { events } = await f.finished; expect(results(events)[0]!.ok).toBe(false);
  expect(results(events)[0]!.display).toContain(kind === "non-git" ? "not a git repository" : kind === "retention" ? "retention limit" : kind === "capacity" ? "retention capacity" : "injected synchronous child.run failure");
  expect(await readFile(join(f.repo, "shared.txt"), "utf8")).toBe("dirty baseline\n");
  expect(pool.live).toBe(0); expect(pool.children).toBe(1); expect(pool.tokens).toBe(4);
  if (kind === "child.run") {
    expect(events.filter(event => event.type === "subagent.spawn")).toHaveLength(1);
    expect(events.filter(event => event.type === "subagent.end")).toEqual([expect.objectContaining({ reason: "error" })]);
  }
}, 30_000);
