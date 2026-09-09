import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAgent, subagentTool, builtinTools, SessionStore, RulePolicy, PermissionGrantRegistry, discoverAgentRoles,
  parseAgentRoleFrontmatter, snapshotAgentRoles, type AgentRole, type AgentConfig, type AnyTool,
  type HarnessEvent, type ModelEvent, type ModelProvider, type ModelRequest } from "@agentkitai/agentrig-core";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const path = await mkdtemp(join(tmpdir(), "agentrig-roles-")); roots.push(path); return path; }
const role = (name: string, tools: string[], patch: Partial<AgentRole> = {}): AgentRole => ({ name, tools,
  "model-role": "subagents", delegable: false, body: "ROLE BODY: inspect the assigned task", origin: "fixture:role", hash: "1".repeat(64), ...patch });
const call = (name: string, input: unknown): ModelEvent[] => [{ type: "tool_use", id: `call-${name}`, name, input }, { type: "stop", reason: "tool_use" }];
function provider(turns: ModelEvent[][], requests: ModelRequest[] = []): ModelProvider {
  return { id: "fixture", model: "fixture", capabilities: { tools: true, parallelTools: true, caching: false, contextWindow: 100_000 },
    async *stream(req) { requests.push(req); yield* turns.shift() ?? [{ type: "stop", reason: "end_turn" }]; } };
}
async function collect(session: ReturnType<ReturnType<typeof createAgent>["run"]>): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = []; for await (const event of session.events) events.push(event); await session.done; return events;
}
const probe = (name: string, calls: string[]): AnyTool => ({ name, description: "fixture", permission: "read", effects: "read-only",
  inputSchema: z.object({}), execute: async () => { calls.push(name); return { display: name, output: name }; } });

it.each([false, true])("advertises role availability and recovers an unknown role with a generic child (roles=%s)", async configured => {
  const cwd = await root(), store = new SessionStore({ root: join(cwd, "logs") });
  const choices: unknown[] = [], requests: ModelRequest[] = [];
  const tool = subagentTool({ roles: configured ? [role("reader", [])] : [], maxChildren: 1, createAgent,
    childConfig: choice => { choices.push(choice); return { provider: provider([]), tools: [],
      permissions: new RulePolicy([], "allow"), systemPrompt: "child", store, repoMap: false }; } });
  expect(tool.description).toContain(configured ? "reader" : "No local agent roles are configured");
  expect(tool.description).toContain("omit agent");
  const events = await collect(createAgent({ provider: provider([
    call("subagent", { task: "inspect", agent: "builder" }),
    call("subagent", { task: "inspect" }),
  ], requests), tools: [tool], permissions: new RulePolicy([], "allow"), systemPrompt: "parent", store, repoMap: false }).run("delegate", { cwd }));
  const schema = requests[0]!.tools.find(t => t.name === "subagent")!.inputSchema as { properties: Record<string, { enum?: string[] }>; required: string[] };
  if (configured) expect(schema.properties.agent?.enum).toEqual(["reader"]);
  else expect(schema.properties).not.toHaveProperty("agent");
  expect(schema.required).not.toContain("agent");
  const refused = events.find(e => e.type === "tool.result" && !e.ok);
  expect(refused).toMatchObject({ display: expect.stringContaining("omit agent") });
  expect(refused).toMatchObject({ display: expect.stringContaining(configured ? "reader" : "No local agent roles are configured") });
  expect(events.filter(e => e.type === "subagent.spawn")).toHaveLength(1);
  expect(choices).toEqual([undefined]);
});

it("validates role fields without loosening the skill frontmatter dialect", () => {
  expect(parseAgentRoleFrontmatter('---\nschema: 1\ntools: ["read_file"]\n---\nInspect only.').fields)
    .toEqual({ schema: "1", tools: ["read_file"], "model-role": "subagents", delegable: false });
  for (const fields of ['tools: ["bash", "bash"]', 'tools: []\nallow: true', 'tools: []\ndelegable: "true"',
    'tools: []\nmax-turns: 0', 'tools: []\nmax-turns: 1.5', 'tools: []\nmodel-role: new-provider',
    'tools: []\nschema: 2', 'tools: []\ntools: ["bash"]', 'tools:\n  - bash', 'tools: &alias []']) {
    expect(() => parseAgentRoleFrontmatter(`---\n${fields}\n---\nbody`)).toThrow();
  }
  expect(() => parseAgentRoleFrontmatter('---\ntools: []\n---\n' + "x".repeat(32769))).toThrow();
  const original = role("reader", ["read_file"]); const snap = snapshotAgentRoles([original]); original.tools.push("bash");
  expect(snap[0]!.tools).toEqual(["read_file"]);
  expect(() => snapshotAgentRoles([original, original])).toThrow("duplicate");
});

it("discovers bounded canonical local files, refuses bad units and never follows an external directory link", async () => {
  const cwd = await root(); const dir = join(cwd, ".agentrig", "agents"); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "reader.md"), '---\ntools: ["read_file"]\n---\nInspect only.');
  await writeFile(join(dir, "bad.md"), '---\ntools: []\nyolo: true\n---\nNever load this.');
  const errors: Error[] = []; const roles = await discoverAgentRoles(cwd, error => errors.push(error));
  expect(roles.map(r => r.name)).toEqual(["reader"]); expect(errors).toHaveLength(1);
  expect(roles[0]!.hash).toMatch(/^[a-f0-9]{64}$/);
  const outside = await root(); await mkdir(join(outside, ".agentrig"));
  await symlink(dir, join(outside, ".agentrig", "agents"), process.platform === "win32" ? "junction" : "dir");
  await expect(discoverAgentRoles(outside)).rejects.toThrow("agent role directory must be a regular directory; symlinked .agentrig/agents paths are not supported");
  expect(await readFile(join(dir, "bad.md"), "utf8")).toContain("yolo");
});

it("canonicalizes a direct SDK project alias without treating linked role directories as trusted", async () => {
  const cwd = await root(), links = await root(); const dir = join(cwd, ".agentrig", "agents");
  await mkdir(dir, { recursive: true }); await writeFile(join(dir, "reader.md"), "---\ntools: []\n---\nRead only.");
  const alias = join(links, "project"); await symlink(cwd, alias, process.platform === "win32" ? "junction" : "dir");
  expect((await discoverAgentRoles(alias)).map(role => role.name)).toEqual(["reader"]);
});

it.each([false, true])("actual spawn narrows bash despite parent blanket authority (allowed=%s), and records project advisory role", async allowed => {
  const cwd = await root(), store = new SessionStore({ root: join(cwd, "logs") }), calls: string[] = [], requests: ModelRequest[] = [];
  const childConfigs: AgentConfig[] = [];
  const childProvider = provider([call("bash", {})], requests);
  const tool = subagentTool({ roles: [role("reader", allowed ? ["bash"] : [])],
    childConfig: () => ({ provider: childProvider, tools: [probe("bash", calls)], permissions: new RulePolicy([], "allow"),
      systemPrompt: "child default", store, repoMap: false }),
    createAgent: config => { childConfigs.push(config); return createAgent(config); } });
  const parent = createAgent({ provider: provider([call("subagent", { task: "work", agent: "reader" })]), tools: [tool],
    permissions: new RulePolicy([], "allow"), systemPrompt: "parent", store, repoMap: false });
  const events = await collect(parent.run("delegate", { cwd }));
  expect(calls).toEqual(allowed ? ["bash"] : []);
  expect(events.find(e => e.type === "subagent.spawn")).toMatchObject({ role: { name: "reader", tools: allowed ? ["bash"] : [], delegable: false } });
  expect(requests[0]!.system).toContain("ROLE BODY");
  expect(requests[0]!.tools.some(t => t.name === "bash")).toBe(allowed);
  const spawn = events.find(e => e.type === "subagent.spawn")!;
  if (spawn.type !== "subagent.spawn") throw Error("missing spawn");
  const childEvents = await store.readAll(spawn.id);
  expect(childEvents.some(e => e.type === "context.manifest" && e.blocks.some(b => b.origin === "fixture:role" && b.authority === "data" && b.context?.authority === "advisory"))).toBe(true);
  if (!allowed) expect(childEvents.some(e => e.type === "tool.denied" && e.name === "bash")).toBe(true);
  // Same trusted role-built agent config keeps its live restrictions on resume; log metadata does not grant anything.
  childConfigs[0]!.provider = provider([call("bash", {})]);
  await collect(createAgent(childConfigs[0]!).run("", { cwd, resume: spawn.id }));
  expect(calls).toEqual(allowed ? ["bash", "bash"] : []);
});

it.each([undefined, "broad"])("grandchild cannot restore excluded bash by role=%s", async grandchildRole => {
  const cwd = await root(), store = new SessionStore({ root: join(cwd, "logs") }), calls: string[] = [];
  let n = 0;
  const p = provider([call("subagent", { task: "nested", ...(grandchildRole === undefined ? {} : { agent: grandchildRole }) }), call("bash", {})]);
  const configs: AgentConfig[] = [];
  const tool = subagentTool({ maxDepth: 3, roles: [role("narrow", ["subagent"], { delegable: true, "max-turns": 2 }), role("broad", ["bash", "subagent"], { delegable: true })],
    childConfig: () => ({ provider: n++ === 0 ? p : provider([call("bash", {})]), tools: [probe("bash", calls)],
      permissions: new RulePolicy([], "allow"), systemPrompt: "child", store, repoMap: false }),
    createAgent: config => { configs.push(config); return createAgent(config); } });
  await collect(createAgent({ provider: provider([call("subagent", { task: "outer", agent: "narrow" })]), tools: [tool],
    permissions: new RulePolicy([], "allow"), systemPrompt: "parent", store, repoMap: false }).run("delegate", { cwd }));
  expect(configs).toHaveLength(2); expect(calls).toEqual([]);
  expect(configs.every(c => c.budget?.maxTurns === 2 && !c.tools.some(t => t.name === "bash"))).toBe(true);
});

it("unknown roles, conflicting provider choice and default nondelegable role cannot start unexpected children", async () => {
  const cwd = await root(), store = new SessionStore({ root: join(cwd, "logs") }), configs: AgentConfig[] = [];
  const tool = subagentTool({ maxDepth: 3, roles: [role("leaf", ["subagent"])], providerChoices: { names: ["known"], default: "known", main: "known" },
    childConfig: () => ({ provider: provider([call("subagent", { task: "forbidden" })]), tools: [], permissions: new RulePolicy([], "allow"), systemPrompt: "child", store, repoMap: false }),
    createAgent: config => { configs.push(config); return createAgent(config); } });
  await collect(createAgent({ provider: provider([call("subagent", { task: "missing", agent: "missing" }),
    call("subagent", { task: "conflict", agent: "leaf", provider: "known" }), call("subagent", { task: "leaf", agent: "leaf" })]),
    tools: [tool], permissions: new RulePolicy([], "allow"), systemPrompt: "parent", store, repoMap: false }).run("delegate", { cwd }));
  expect(configs).toHaveLength(1); expect(configs[0]!.tools).toEqual([]);
});

it("restricted live grant views intersect descendants without copying authority and preserve revocation/expiry", async () => {
  const registry = new PermissionGrantRegistry(); const task = registry.beginRun("root");
  const grant = registry.grant({ subject: registry.subject, operation: { class: "read", tool: "read_file" }, resource: "*", constraints: {},
    duration: { kind: "session", id: "root" }, delegable: true, decision: "allow" });
  await registry.flush(async () => {});
  const child = registry.childView(["read_file"]), grandchild = child.childView(["read_file", "bash"]);
  const request = { tool: "read_file", class: "read" as const, cwd: process.cwd(), input: {} };
  expect(child.authorize(request)).toMatchObject({ decision: "allow", grantId: grant.id });
  expect(grandchild.decide({ ...request, tool: "bash" })).toBe("deny");
  registry.revoke(grant.id); await registry.flush(async () => {}); expect(child.decide(request)).toBe("ask");
  registry.endRun(task); registry.beginRun("root"); expect(child.decide(request)).toBe("deny");
});

it("role routing selects an existing configured model role and caps actual child requests", async () => {
  const cwd = await root(), store = new SessionStore({ root: join(cwd, "logs") });
  const choices: unknown[] = [], requests: ModelRequest[] = [], calls: string[] = [];
  const selected = provider([call("probe", {}), call("probe", {}), call("probe", {})], requests);
  const tool = subagentTool({ roles: [role("reviewer", ["probe"], { "model-role": "supervisor", "max-turns": 1 })],
    modelRoles: { supervisor: "review-model" }, maxTurns: 5, createAgent,
    childConfig: choice => { choices.push(choice); return { provider: selected, tools: [probe("probe", calls)],
      permissions: new RulePolicy([], "allow"), systemPrompt: "base", store, repoMap: false }; } });
  const events = await collect(createAgent({ provider: provider([call("subagent", { task: "review", agent: "reviewer" })]),
    tools: [tool], permissions: new RulePolicy([], "allow"), systemPrompt: "parent", store, repoMap: false }).run("delegate", { cwd }));
  expect(choices).toEqual([{ provider: "review-model" }]); expect(requests).toHaveLength(1);
  expect(events.find(e => e.type === "subagent.spawn")).toMatchObject({ role: { modelRole: "supervisor", maxTurns: 1 } });
});

it("an unavailable role is rejected even when the catalogue is absent", async () => {
  const cwd = await root(), store = new SessionStore({ root: join(cwd, "logs") });
  const childConfig = vi.fn((): AgentConfig => { throw Error("must not construct a generic child"); });
  const events = await collect(createAgent({ provider: provider([call("subagent", { task: "inspect", agent: "missing" })]),
    tools: [subagentTool({ childConfig, createAgent })], permissions: new RulePolicy([], "allow"), systemPrompt: "parent", store, repoMap: false }).run("delegate", { cwd }));
  expect(childConfig).not.toHaveBeenCalled(); expect(events.some(e => e.type === "subagent.spawn")).toBe(false);
  expect(events.find(e => e.type === "tool.result")).toMatchObject({ ok: false, display: expect.stringContaining("unavailable") });
});

it("a role explicitly selecting only runtime output recovery advertises exactly that capability", async () => {
  const cwd = await root(), store = new SessionStore({ root: join(cwd, "logs") }), requests: ModelRequest[] = [];
  const tool = subagentTool({ roles: [role("recovery", ["read_output"])], createAgent,
    childConfig: () => ({ provider: provider([], requests), tools: [], permissions: new RulePolicy([], "allow"), systemPrompt: "child", store, repoMap: false }) });
  await collect(createAgent({ provider: provider([call("subagent", { task: "recover", agent: "recovery" })]), tools: [tool],
    permissions: new RulePolicy([], "allow"), systemPrompt: "parent", store, repoMap: false }).run("delegate", { cwd }));
  expect(requests[0]!.tools.map(t => t.name)).toEqual(["read_output"]);
});

it.each([false, true])("actual role spawn requires explicit internal checker allowance (allowed=%s)", async allowed => {
  const cwd = await root(), store = new SessionStore({ root: join(cwd, "logs") });
  const tools = builtinTools({ diagnostics: [{ parser: "tsc", extensions: [".ts"], executable: process.execPath,
    args: ["-e", 'require("fs").writeFileSync("checked", "yes")'] }] });
  const tool = subagentTool({ roles: [role("writer", allowed ? ["write_file", "core:diagnostics"] : ["write_file"])], createAgent,
    childConfig: () => ({ provider: provider([call("write_file", { path: "target.ts", content: "written" })]), tools,
      permissions: new RulePolicy([], "allow"), systemPrompt: "child", store, repoMap: false }) });
  const events = await collect(createAgent({ provider: provider([call("subagent", { task: "write target", agent: "writer" })]),
    tools: [tool], permissions: new RulePolicy([], "allow"), systemPrompt: "parent", store, repoMap: false }).run("delegate", { cwd }));
  const spawn = events.find(e => e.type === "subagent.spawn"); if (spawn?.type !== "subagent.spawn") throw Error("no spawn");
  expect(await readFile(join(cwd, "target.ts"), "utf8")).toBe("written");
  const childEvents = await store.readAll(spawn.id);
  expect(childEvents.find(e => e.type === "tool.result" && e.id === "call-write_file")).toMatchObject({ diagnostics: { status: allowed ? "reported" : "unavailable" } });
  if (allowed) expect(await readFile(join(cwd, "checked"), "utf8")).toBe("yes");
  else await expect(readFile(join(cwd, "checked"))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([false, true])("actual role child keeps live revocation and base deny precedence (base deny=%s)", async baseDeny => {
  const cwd = await root(), store = new SessionStore({ root: join(cwd, "logs") }), calls: string[] = [];
  const registry = new PermissionGrantRegistry(); registry.beginSession("parent");
  const grant = registry.grant({ subject: registry.subject, operation: { tool: "probe" }, resource: "*", constraints: {},
    duration: { kind: "session", id: "parent" }, delegable: true, decision: "allow" });
  let turn = 0;
  const child: ModelProvider = { ...provider([]), async *stream() {
    turn++;
    if (turn === 2) registry.revoke(grant.id);
    yield* turn <= 2 ? call("probe", {}) : [{ type: "stop" as const, reason: "end_turn" as const }];
  } };
  const policy = new RulePolicy([{ tool: "subagent", decision: "allow" }, { tool: "probe", decision: baseDeny ? "deny" : "ask" }]);
  const tool = subagentTool({ roles: [role("reader", ["probe"])], createAgent,
    childConfig: () => ({ provider: child, tools: [probe("probe", calls)], permissionGrants: registry,
      permissions: policy, systemPrompt: "child", store, repoMap: false }) });
  const events = await collect(createAgent({ provider: provider([call("subagent", { task: "inspect", agent: "reader" })]),
    tools: [tool], permissionGrants: registry, permissions: policy, systemPrompt: "parent", store, repoMap: false }).run("delegate", { cwd, id: "parent" }));
  expect(calls).toEqual(baseDeny ? [] : ["probe"]);
  const spawn = events.find(e => e.type === "subagent.spawn"); if (spawn?.type !== "subagent.spawn") throw Error("missing child");
  const childEvents = await store.readAll(spawn.id);
  expect(childEvents.filter(e => e.type === "tool.denied" && e.name === "probe")).toHaveLength(baseDeny ? 2 : 1);
});

it("discovery bounds the catalogue and refuses file links without consuming their contents", async () => {
  const cwd = await root(), dir = join(cwd, ".agentrig", "agents"); await mkdir(dir, { recursive: true });
  await Promise.all(Array.from({ length: 33 }, (_, i) => writeFile(join(dir, `role${i}.md`), '---\ntools: []\n---\nbody')));
  await expect(discoverAgentRoles(cwd)).rejects.toThrow("too many");
  await rm(dir, { recursive: true }); await mkdir(dir);
  await writeFile(join(dir, "large.md"), "x".repeat(65537));
  const errors: Error[] = []; expect(await discoverAgentRoles(cwd, error => errors.push(error))).toEqual([]);
  expect(errors).toHaveLength(1);
  if (process.platform !== "win32") {
    const outside = join(await root(), "outside.md"); await writeFile(outside, '---\ntools: ["bash"]\n---\nexternal');
    await symlink(outside, join(dir, "linked.md")); expect(await discoverAgentRoles(cwd)).toEqual([]);
  }
});
