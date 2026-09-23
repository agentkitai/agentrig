import { mkdtemp, readFile, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extensionFixture } from "./fixtures/extensions.ts";
import { afterEach, expect, it } from "vitest";
import { createAgent, subagentTool, SessionStore, RulePolicy, querySpawnLog,
  loadExtensions, type ToolContext, type Hook, type HookContext, type HarnessEvent, type ModelProvider, type ModelEvent, type AgentRole } from "@agentkitai/agentrig-core";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function provider(turns: ModelEvent[][] = []): ModelProvider {
  return { id: "fixture", model: "fixture", capabilities: { tools: true, parallelTools: true, caching: false, contextWindow: 100_000 },
    async *stream() { yield* turns.shift() ?? [{ type: "stop", reason: "end_turn" }]; } };
}
const task = "  exact task\r\nUnicode: λ\nDo not substitute the label.  ";
const role: AgentRole = { name: "reader", tools: [], "model-role": "subagents", delegable: false,
  body: "Read only", origin: "fixture:role", hash: "1".repeat(64) };
async function fixture(hooks: Hook[], named = true, calls = 1) {
  const cwd = await mkdtemp(join(tmpdir(), "spawn-hooks-")); roots.push(cwd);
  const store = new SessionStore({ root: join(cwd, "logs") }); const order: string[] = [];
  const tool = subagentTool({ roles: [role], maxChildren: 1, childConfig: () => {
    order.push("configure"); return { provider: provider(), tools: [], permissions: new RulePolicy([], "allow"), systemPrompt: "child", store, repoMap: false };
  }, createAgent });
  const session = createAgent({ provider: provider(Array.from({ length: calls }, (_, n) => [
    { type: "tool_use", id: `spawn-${n}`, name: "subagent", input: { task, label: "display label", ...(named ? { agent: "reader" } : {}) } },
    { type: "stop", reason: "tool_use" },
  ])), tools: [tool], permissions: new RulePolicy([], "allow"), systemPrompt: "parent", store, repoMap: false, hooks }).run("delegate", { cwd });
  const events: HarnessEvent[] = []; for await (const event of session.events) events.push(event); await session.done;
  return { session, store, events, order };
}

it.each([true, false])("pre/post see exact task, selected role and parent; post identifies the logged spawn (named=%s)", async named => {
  const seen: Array<{ point: string; spawn: HookContext["spawn"] }> = [];
  const f = await fixture([...["pre_spawn", "post_spawn"].map(point => ({ point, handler: (ctx: HookContext) => {
    seen.push({ point, spawn: ctx.spawn }); return { action: "continue" };
  } } as Hook))], named);
  expect(seen.map(s => s.point)).toEqual(["pre_spawn", "post_spawn"]);
  const spawns = await querySpawnLog(f.store, f.session.id);
  expect(spawns).toHaveLength(1);
  expect(spawns[0]).toMatchObject({ type: "subagent.spawn", sessionId: f.session.id, task: "display label", taskText: task });
  expect(seen[0]!.spawn).toEqual({ task, parent: f.session.id, ...(named ? { role: { name: role.name, origin: role.origin, hash: role.hash, tools: role.tools, modelRole: role["model-role"], delegable: role.delegable } } : {}) });
  expect(seen[1]!.spawn).toEqual({ ...seen[0]!.spawn, childId: spawns[0]!.id });
  expect(seen[0]!.spawn).not.toHaveProperty("childId");
  const child = await f.store.readAll(spawns[0]!.id);
  expect(child.find(e => e.type === "session.start")).toMatchObject({ parent: f.session.id });
  expect(f.order).toEqual(["configure"]);
});

it("denial happens before child configuration and releases the reserved capacity", async () => {
  let attempts = 0; let posts = 0;
  const f = await fixture([
    { point: "pre_spawn", handler: () => ++attempts === 1 ? { action: "deny", reason: "fixture gate" } : { action: "continue" } },
    { point: "post_spawn", handler: () => { posts++; return { action: "continue" }; } },
  ], false, 2);
  expect(attempts).toBe(2); expect(posts).toBe(1); expect(f.order).toEqual(["configure"]);
  expect(f.events.find(e => e.type === "tool.result" && !e.ok)).toMatchObject({ display: expect.stringContaining("fixture gate") });
  expect(await querySpawnLog(f.store, f.session.id)).toHaveLength(1);
});

it.each(["throw", "timeout", "rewrite"])("pre-spawn %s fails closed, with no config or spawn", async mode => {
  const f = await fixture([{ point: "pre_spawn", timeoutMs: 5, handler: () => {
    if (mode === "throw") throw new Error("fixture failure");
    if (mode === "rewrite") return { action: "modify", patch: { systemAppend: "rewrite" } };
    return new Promise(() => {});
  } }]);
  expect(f.order).toEqual([]); expect(await querySpawnLog(f.store, f.session.id)).toEqual([]);
  expect(f.events.some(e => e.type === "tool.result" && !e.ok)).toBe(true);
});

it("post-spawn failure is observational and cannot erase or strand an existing child", async () => {
  const f = await fixture([{ point: "post_spawn", handler: () => { throw new Error("post failure"); } }]);
  const spawns = await querySpawnLog(f.store, f.session.id);
  expect(spawns).toHaveLength(1);
  expect(f.events.find(e => e.type === "subagent.end")).toMatchObject({ id: spawns[0]!.id, reason: "done" });
});

it("queries physical immutable events, filters by id/role, preserves legacy uncertainty and rejects corruption", async () => {
  const f = await fixture([]);
  const spawns = await querySpawnLog(f.store, f.session.id); const spawn = spawns[0]!;
  await f.store.append(f.session.id, { type: "subagent.spawn", id: "legacy-child", task: "legacy label" });
  const path = f.store.pathFor(f.session.id); const before = await readFile(path);
  expect(await querySpawnLog(f.store, f.session.id, { childId: spawn.id, role: "reader" })).toEqual([spawn]);
  expect(await querySpawnLog(f.store, f.session.id, { role: "missing" })).toEqual([]);
  const legacy = await querySpawnLog(f.store, f.session.id, { childId: "legacy-child" });
  expect(legacy).toHaveLength(1); expect(legacy[0]).not.toHaveProperty("taskText"); expect(legacy[0]).not.toHaveProperty("role");
  const fork = await f.store.fork(f.session.id, spawn.seq);
  expect(await querySpawnLog(f.store, fork)).toEqual([]);
  expect(await readFile(path)).toEqual(before);
  await appendFile(path, "{broken\n");
  await expect(querySpawnLog(f.store, f.session.id)).rejects.toThrow();
  await expect(querySpawnLog(f.store, "../escape")).rejects.toThrow();
});


it("a real extension registers both spawn points and blocks the production spawn path", async () => {
  const root = await mkdtemp(join(tmpdir(), "spawn-extension-")); roots.push(root);
  const path = await extensionFixture(root, "spawn-gate", `export function activate(ctx) {
    ctx.hooks.on("pre_spawn", () => ({action:"deny",reason:"extension gate"}));
    ctx.hooks.on("post_spawn", () => ({action:"continue"}));
  }`, { name: "spawn-gate", version: "1", apiVersion: 1, surfaces: ["hooks"] });
  const loaded = await loadExtensions({ candidates: [{ path, precedence: 0 }],
    session: { cwd: root, provider: { id: "fixture", model: "fixture" } },
    builtinToolNames: new Set(), reservedCommandNames: new Set(), onNotice() {} });
  expect(loaded.failed).toEqual([]);
  const f = await fixture(loaded.loaded[0]!.hooks);
  expect(f.order).toEqual([]); expect(await querySpawnLog(f.store, f.session.id)).toEqual([]);
  expect(f.events.find(e => e.type === "tool.result" && !e.ok)).toMatchObject({ display: expect.stringContaining("extension gate") });
});

it("an awaiting pre hook reserves shared capacity and cancellation releases it", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "spawn-reserve-")); roots.push(cwd);
  const store = new SessionStore({ root: join(cwd, "logs") });
  let configured = 0; let enter!: () => void; let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const tool = subagentTool({ maxChildren: 1, childConfig: () => {
    configured++; return { provider: provider(), tools: [], permissions: new RulePolicy([], "allow"), systemPrompt: "child", store, repoMap: false };
  }, createAgent });
  const abort = new AbortController();
  const ctx: ToolContext = { cwd, sessionId: "parent", emit() {}, signal: abort.signal,
    spawnHook: async () => { enter(); await waiting; return {}; } };
  const first = tool.execute({ task }, ctx);
  const rejected = expect(first).rejects.toThrow();
  await entered;
  try {
    const competing = await tool.execute({ task }, ctx);
    expect(competing.isError).toBe(true); expect(competing.display).toContain("the limit");
    expect(configured).toBe(0);
  } finally { abort.abort(); release(); await rejected; }
  const retry = await tool.execute({ task }, { ...ctx, signal: new AbortController().signal, spawnHook: async () => ({ denied: "retry reached gate" }) });
  expect(retry.display).toContain("retry reached gate"); expect(configured).toBe(0);
});
