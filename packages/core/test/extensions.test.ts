import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createAgent, discoverExtensions, EventPayload, loadExtensions, RulePolicy, SessionStore,
  TOOL_EMITTABLE_EVENTS,
  type ExtensionCandidate, type HarnessEvent, type ModelProvider } from "@agentkitai/agentrig-core";
import { extensionFixture } from "./fixtures/extensions.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temp() { const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-extensions-"))); roots.push(root); return root; }
const session = { cwd: "/fixture", provider: { id: "fixture", model: "none" } };
const notices: string[] = [];
const load = (paths: string[] | ExtensionCandidate[], timeoutMs?: number) => loadExtensions({
  candidates: paths.map(p => typeof p === "string" ? { path: p, precedence: 0 } : p), session,
  builtinToolNames: new Set(["memory_read"]), reservedCommandNames: new Set(["help", "quit"]),
  onNotice: message => notices.push(message), ...(timeoutMs === undefined ? {} : { timeoutMs }),
});

it("actual module freezes minimal context and seals late registration", async () => {
  const root = await temp();
  const path = await extensionFixture(root, "context", `export let context;
export function activate(ctx) { context=ctx; ctx.registerCommand({name:"test",summary:"test",run(){}}); }`);
  const result = await load([path]); expect(result.failed).toEqual([]);
  expect(result.loaded[0]!.surfaces.commands).toEqual(["test"]);
  const module = await import(pathToFileURL(path).href);
  expect(Object.keys(module.context).sort()).toEqual(["hooks", "log", "name", "registerCommand", "registerTool", "session"]);
  expect(Object.keys(module.context.session).sort()).toEqual(["cwd", "provider"]);
  for (const value of [module.context, module.context.session, module.context.session.provider, module.context.hooks]) expect(Object.isFrozen(value)).toBe(true);
  expect(() => module.context.registerCommand({ name: "late", summary: "late", run() {} })).toThrow(/sealed/);
  expect(notices.some(line => line.includes("ambient Node host code"))).toBe(true);
});

it("ambient-host warning is delivered before actual import executes", async () => {
  const root = await temp(); const sentinel = join(root, "imported");
  const path = await extensionFixture(root, "notice", `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(sentinel)},'yes');export function activate(){}`);
  const seen: boolean[] = [];
  const result = await loadExtensions({ candidates: [{ path, precedence: 0 }], session,
    builtinToolNames: new Set(), reservedCommandNames: new Set(),
    onNotice: message => { if (message.includes("ambient Node host code")) seen.push(existsSync(sentinel)); },
  });
  expect(result.failed).toEqual([]); expect(seen).toEqual([false]); expect(existsSync(sentinel)).toBe(true);
});

it.each(["missing", "unknown", "mismatch", "version", "malformed"])("%s sidecar refuses before import sentinel executes", async mode => {
  const root = await temp(); const sentinel = join(root, "imported");
  const path = await extensionFixture(root, "bad", `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(sentinel)},'executed');export function activate(){}`,
    mode === "missing" ? null : { name: mode === "mismatch" ? "other" : "bad", version: "1", apiVersion: mode === "version" ? 2 : 1,
      surfaces: [], ...(mode === "unknown" ? { permissions: "*" } : {}) });
  if (mode === "malformed") await writeFile(join(root, "bad.json"), "{");
  const result = await load([path]); expect(result.loaded).toEqual([]); expect(result.failed[0]!.phase).toBe("manifest");
  await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
});

it("declared-surface and reserved-name failures poison the whole draft even if activation catches them", async () => {
  const root = await temp();
  for (const [index, code] of [
    'ctx.hooks.on("pre_tool",()=>({action:"continue"}))',
    'ctx.registerCommand({name:"help",summary:"bad",run(){}})',
    ...["update_plan", "bash_job", "memory_read", "mcp__foreign", "skill"].map(name => `ctx.registerTool({name:${JSON.stringify(name)},description:"bad",permission:"read",inputSchema:{parse(x){return x}},jsonSchema:{type:"object"},execute(){return {output:{},display:"bad"}}})`),
  ].entries()) {
    const name = `bad${index}`;
    const path = await extensionFixture(root, name, `export function activate(ctx){ctx.registerCommand({name:"safe",summary:"safe",run(){}});try{${code}}catch{}}`,
      { name, version: "1", apiVersion: 1, surfaces: ["commands", "tools"] });
    const result = await load([path]); expect(result.loaded).toEqual([]); expect(result.failed[0]!.phase).toBe("activate");
  }
});

it("deterministic name precedence and same-level duplicate refusal happen before import", async () => {
  const root = await temp();
  const a = await extensionFixture(join(root, "a")); const b = await extensionFixture(join(root, "b"));
  expect((await load([a, b])).loaded).toEqual([]);
  expect((await load([{ path: b, precedence: 1 }, { path: a, precedence: 0 }])).loaded.map(e => e.path)).toEqual([a]);
  expect((await load([a, a])).loaded).toHaveLength(1);
  const other = await extensionFixture(root, "other");
  const collisions = await load([a, other]); expect(collisions.loaded).toHaveLength(1); expect(collisions.failed[0]!.phase).toBe("activate");
});

it("timeout seals drafts, late completion cannot publish and a rejected activation leaves nothing", async () => {
  const root = await temp();
  const path = await extensionFixture(root, "hang", `export let context;export function activate(ctx){context=ctx;ctx.registerCommand({name:"draft",summary:"draft",run(){}});return new Promise(()=>{})}`);
  const result = await load([path], 100); expect(result.loaded).toEqual([]); expect(result.failed[0]!.message).toMatch(/timed out/);
  const module = await import(pathToFileURL(path).href);
  expect(() => module.context.registerCommand({name:"late",summary:"late",run(){}})).toThrow(/sealed/);
  const rejected = await extensionFixture(root, "reject", 'export function activate(){return Promise.reject(new Error("no"))}');
  expect((await load([rejected])).failed[0]!.phase).toBe("activate");
  const missing = await extensionFixture(root, "missing", 'export const nope=1;');
  expect((await load([missing])).failed[0]!.phase).toBe("import");
});

it("bounded project discovery and module/manifest symlinks fail closed", async () => {
  const root = await temp(); const path = await extensionFixture(join(root, ".agentrig/extensions"));
  expect(await discoverExtensions(root)).toEqual([{ path, precedence: 1 }]);
  await expect(load(Array.from({ length: 33 }, () => path))).rejects.toThrow(/limit 32/);
  const link = join(root, ".agentrig/extensions/link.mjs");
  try { await symlink(path, link); } catch (error) { if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return; throw error; }
  await writeFile(link.slice(0, -4) + ".json", JSON.stringify({ name: "link", version: "1", apiVersion: 1, surfaces: [] }));
  expect((await load([link])).loaded).toEqual([]);
});

it("actual startup receipts round-trip after start/resume", async () => {
  expect(TOOL_EMITTABLE_EVENTS.has("extension.loaded")).toBe(false);
  expect(TOOL_EMITTABLE_EVENTS.has("extension.error")).toBe(false);
  const root = await temp(); const path = await extensionFixture(root);
  const extensions = await load([path]); const loaded = extensions.loaded[0]!;
  const provider: ModelProvider = { id: "fixture", model: "fixture", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100000 },
    async *stream() { yield { type: "text_delta", text: "done" }; yield { type: "stop", reason: "end_turn" }; } };
  const store = new SessionStore({ root: join(root, "logs") });
  const agent = createAgent({ provider, tools: loaded.tools, hooks: loaded.hooks, extensions, permissions: new RulePolicy([], "deny"), systemPrompt: "fixture", store, repoMap: false });
  let id: string | undefined;
  for (const resume of [false, true]) {
    const run = agent.run("fixture", { cwd: root, ...(resume ? { resume: id! } : {}) }); id = run.id;
    const events: HarnessEvent[] = []; for await (const event of run.events) events.push(event); await run.done;
    const event = events.find(e => e.type === "extension.loaded")!;
    expect(event.seq).toBeGreaterThan(events.find(e => e.type === (resume ? "session.resume" : "session.start"))!.seq);
    expect(EventPayload.parse(event)).toMatchObject({ type: "extension.loaded", name: "hello", surfaces: loaded.surfaces });
    expect((await store.readAll(id)).some(e => e.type === "extension.loaded")).toBe(true);
  }
});
