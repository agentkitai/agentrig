import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgent, describeShellOperation, HarnessEvent, PermissionGrantRegistry, PermissionGrantSchema, RulePolicy, SessionStore, subagentTool,
  type AnyTool, type ModelEvent, type ModelProvider, type PermissionGrantSpec, type PermissionRequest } from "@agentkitai/agentrig-core";

const cwd = resolve("grant-fixture");
const request = (command = "git status"): PermissionRequest => ({ tool: "bash", class: "exec", cwd, input: { command }, operation: describeShellOperation(command, "/bin/sh") });
function spec(registry: PermissionGrantRegistry, overrides: Partial<PermissionGrantSpec> = {}): PermissionGrantSpec {
  return { subject: registry.subject, operation: { tool: "bash", class: "exec", commandPrefix: ["git", "status"] },
    resource: "*", constraints: {}, duration: { kind: "session", id: registry.context.sessionId! }, delegable: false, decision: "allow", ...overrides };
}
function registry() { const r = new PermissionGrantRegistry(); r.beginRun("session-one"); return r; }

describe("live grant records", () => {
  it("matches parsed argv, subject and explicit constraints, never input descriptions", () => {
    const r = registry(); const grant = r.grant(spec(r, { constraints: { cwd } }));
    expect(r.decide(request())).toBe("allow");
    for (const command of ["git statusx", "git status; true", "git $(printf status)", "echo git status"]) expect(r.decide(request(command))).toBe("ask");
    expect(r.decide({ ...request(), cwd: join(cwd, "elsewhere") })).toBe("ask");
    expect(r.decide({ ...request(), operation: undefined, input: { operation: request().operation, readOnlyHint: true } })).toBe("ask");
    expect(() => r.grant(spec(r, { subject: "another-subject" }))).toThrow("subject/duration");
    expect(() => r.grant(spec(r, { duration: { kind: "session", id: "another-session" } }))).toThrow("subject/duration");
    grant.operation.commandPrefix![0] = "echo";
    r.list()[0]!.operation.commandPrefix![0] = "echo";
    expect(r.decide(request())).toBe("allow");
    expect(r.list()[0]!.delegable).toBe(false); // metadata until R12d, not an isolation promise
  });
  it("requires nonempty declared paths and every lexical path under an absolute scope", () => {
    const r = registry(); r.grant(spec(r, { operation: { tool: "write_file", class: "write" }, resource: { kind: "path-prefix", path: join(cwd, "allowed") } }));
    const req: PermissionRequest = { tool: "write_file", class: "write", cwd, input: {} };
    for (const paths of [undefined, [], ["allowed/a", "outside/b"], ["allowed/../../escape"], ["allowed-other/a"]]) expect(r.decide({ ...req, ...(paths === undefined ? {} : { paths }) })).toBe("ask");
    expect(r.decide({ ...req, paths: ["allowed/a", "allowed/sub/b"] })).toBe("allow");
    expect(() => r.grant(spec(r, { resource: { kind: "path-prefix", path: "relative" } }))).toThrow();
  });
  it("expires task grants but retains session grants on same-session continuation", async () => {
    const r = registry(); const task = r.context.taskId!;
    r.grant(spec(r, { duration: { kind: "task", id: task } }));
    const sessionGrant = r.grant(spec(r, { operation: { tool: "other" } }));
    r.endRun(task);
    expect(r.decide(request())).toBe("ask"); expect(r.list()).toEqual([sessionGrant]);
    r.beginRun("session-one"); expect(r.list()).toEqual([sessionGrant]);
    r.endRun(r.context.taskId!); r.beginRun("session-two"); expect(r.list()).toEqual([]);
    const events: unknown[] = []; await r.flush(async event => { events.push(event); });
    expect(events).toContainEqual(expect.objectContaining({ type: "permission.revoked", reason: "task-ended" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "permission.revoked", reason: "session-changed" }));
  });
  it("rejects malformed/unknown constraints, durations and schema widening", () => {
    const r = registry(); const valid = r.grant(spec(r));
    for (const patch of [{ constraints: { net: true } }, { duration: { kind: "forever", id: "session-one" } }, { duration: { kind: "session", id: "" } }, { delegable: "true" }, { operation: { tool: "bash", commandPrefix: [] } }, { unknown: true }]) expect(PermissionGrantSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
  it("caps live grants and audit queue, blocks authority on overflow and retains unlogged changes", async () => {
    const r = new PermissionGrantRegistry({ maxGrants: 1, maxPending: 1 }); r.beginRun("session-one");
    const grant = r.grant(spec(r));
    expect(() => r.grant(spec(r))).toThrow("registry is full");
    expect(() => r.revoke(grant.id)).toThrow("audit queue is full");
    expect(r.decide(request())).toBe("deny");
    const events: unknown[] = []; await r.flush(async event => { events.push(event); });
    expect(events).toEqual([{ type: "permission.granted", grant }]);
    r.clear(); await r.flush(async event => { events.push(event); });
    expect(events[1]).toMatchObject({ type: "permission.revoked", grantId: grant.id });
    expect(r.decide(request())).toBe("ask");
  });
  it("does not consume failed audit writes and serializes concurrent drains", async () => {
    const r = registry(); const grant = r.grant(spec(r));
    await expect(r.flush(async () => { throw new Error("disk refused"); })).rejects.toThrow("disk refused");
    const events: unknown[] = []; const emit = async (event: unknown) => { await Promise.resolve(); events.push(event); };
    await Promise.all([r.flush(emit), r.flush(emit)]);
    expect(events).toEqual([{ type: "permission.granted", grant }]);
    r.revoke(grant.id); await r.flush(emit); expect(events).toHaveLength(2);
  });
  it("never supplies sandbox escalation or MCP definition consent", () => {
    const r = registry(); r.remember(request(), "allow");
    for (const origin of ["sandbox-escalation", "mcp-definition-change"]) {
      expect(r.decide({ ...request(), origin })).toBe("ask");
      expect(() => r.remember({ ...request(), origin }, "allow")).toThrow("separate consent");
    }
  });
});

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "agentrig-grants-")); dirs.push(root); return new SessionStore({ root }); }
class Provider implements ModelProvider {
  id = "fake"; model = "fake"; capabilities = { tools: true, parallelTools: false, caching: false, contextWindow: 100000 };
  constructor(private readonly commands: string[]) {}
  async *stream(): AsyncIterable<ModelEvent> {
    const command = this.commands.shift();
    if (command !== undefined) yield { type: "tool_use", id: `t-${this.commands.length}`, name: "bash", input: { command } };
    yield { type: "stop", reason: command === undefined ? "end_turn" : "tool_use" };
  }
}
function tool(executed: string[]): AnyTool {
  return { name: "bash", description: "test operation", inputSchema: z.object({ command: z.string() }), permission: "exec",
    operation: (input: { command: string }) => describeShellOperation(input.command, "/bin/sh"),
    execute: async (input: { command: string }) => { executed.push(input.command); return { output: input.command, display: input.command }; } };
}
async function collect(session: ReturnType<ReturnType<typeof createAgent>["run"]>) {
  const events: HarnessEvent[] = []; for await (const event of session.events) events.push(event);
  return { events, summary: await session.done };
}

describe("core grant enforcement and audit", () => {
  it("preserves explicitly shared child authority, with delegable still metadata until R12d", async () => {
    const store = await fixture(); const r = new PermissionGrantRegistry(); const id = store.create(); r.beginSession(id);
    r.grant(spec(r, { delegable: false })); const executed: string[] = [];
    const permissions = new RulePolicy([{ tool: "subagent", decision: "allow" }]);
    const subagent = subagentTool({ createAgent, childConfig: () => ({ provider: new Provider(["git status"]), tools: [tool(executed)],
      permissions, permissionGrants: r, store, systemPrompt: "child", origin: "subagent" }) });
    let turn = 0;
    const provider: ModelProvider = { id: "fake", model: "fake", capabilities: new Provider([]).capabilities,
      async *stream(): AsyncIterable<ModelEvent> {
        if (turn++ === 0) yield { type: "tool_use", id: "spawn", name: "subagent", input: { task: "status" } };
        yield { type: "stop", reason: turn === 1 ? "tool_use" : "end_turn" };
      } };
    const { events } = await collect(createAgent({ provider, tools: [subagent], permissions, permissionGrants: r, store, systemPrompt: "parent" }).run("spawn", { id, cwd: store.root }));
    expect(executed).toEqual(["git status"]); expect(events.some(e => e.type === "subagent.spawn")).toBe(true);
    expect(r.list()[0]!.delegable).toBe(false);
  });
  it("an already-running child cannot adopt grants from a different root session", async () => {
    const store = await fixture(); const r = registry(); const oldTask = r.context.taskId!; const executed: string[] = [];
    let release!: () => void; let started!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; }); const entered = new Promise<void>(resolve => { started = resolve; });
    let turn = 0;
    const provider: ModelProvider = { id: "fake", model: "fake", capabilities: new Provider([]).capabilities,
      async *stream(): AsyncIterable<ModelEvent> {
        if (turn++ === 0) { started(); await barrier; yield { type: "tool_use", id: "late", name: "bash", input: { command: "git status" } }; }
        yield { type: "stop", reason: turn === 1 ? "tool_use" : "end_turn" };
      } };
    const child = createAgent({ provider, tools: [tool(executed)], permissions: new RulePolicy([]), permissionGrants: r, store, systemPrompt: "child" }).run("wait", { parent: "oldparent", cwd: store.root });
    const work = collect(child); await entered;
    r.endRun(oldTask); r.beginRun("session-two"); r.grant(spec(r)); release();
    const { events } = await work; expect(executed).toEqual([]); expect(events.some(e => e.type === "tool.denied")).toBe(true);
  });
  it("uses a real grant after ask, audits before dispatch and observes revocation before the next call", async () => {
    const store = await fixture(); const r = new PermissionGrantRegistry(); const executed: string[] = []; let asks = 0; let grantId = "";
    const agent = createAgent({ provider: new Provider(["git status", "git status"]), tools: [tool(executed)], permissions: new RulePolicy([]), permissionGrants: r,
      store, systemPrompt: "test", onAsk: async () => { if (asks++ > 0) return "deny"; grantId = r.grant(spec(r)).id; return "allow"; },
      hooks: [{ point: "post_tool", handler: () => { r.revoke(grantId); return { action: "continue" }; } }] });
    const { events } = await collect(agent.run("run", { cwd: store.root }));
    expect(executed).toEqual(["git status"]); expect(asks).toBe(2);
    expect(events.findIndex(e => e.type === "permission.granted")).toBeLessThan(events.findIndex(e => e.type === "tool.call"));
    expect(events.some(e => e.type === "permission.revoked")).toBe(true);
    for (const event of events.filter(e => e.type.startsWith("permission."))) expect(HarnessEvent.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
  });
  it.each(["allow", "deny"] as const)("retains explicit base %s even against the opposite grant", async base => {
    const store = await fixture(); const r = new PermissionGrantRegistry(); const id = store.create(); r.beginSession(id);
    r.grant(spec(r, { decision: base === "allow" ? "deny" : "allow" })); const executed: string[] = [];
    const agent = createAgent({ provider: new Provider(["git status"]), tools: [tool(executed)], permissions: new RulePolicy([], base), permissionGrants: r, store, systemPrompt: "test" });
    await collect(agent.run("run", { id, cwd: store.root })); expect(executed).toHaveLength(base === "allow" ? 1 : 0);
  });
  it("failed permission audit append prevents dispatch and retains the queued grant", async () => {
    const store = await fixture(); const r = new PermissionGrantRegistry(); const executed: string[] = [];
    const append = store.append.bind(store);
    vi.spyOn(store, "append").mockImplementation(async (id, event) => { if (event.type === "permission.granted") throw new Error("permission audit disk failure"); return append(id, event); });
    const agent = createAgent({ provider: new Provider(["git status"]), tools: [tool(executed)], permissions: new RulePolicy([]), permissionGrants: r,
      store, systemPrompt: "test", onAsk: async () => { r.grant(spec(r)); return "allow"; } });
    const { summary } = await collect(agent.run("run", { cwd: store.root }));
    expect(summary.reason).toBe("error"); expect(executed).toEqual([]);
    const pending: unknown[] = []; await r.flush(async event => { pending.push(event); });
    expect(pending).toHaveLength(1); expect(pending[0]).toMatchObject({ type: "permission.granted" });
  });
  it("a fresh live registry cannot regain authority by resuming a grant-bearing log", async () => {
    const store = await fixture(); const first = new PermissionGrantRegistry(); const executed: string[] = [];
    const initial = createAgent({ provider: new Provider(["git status"]), tools: [tool(executed)], permissions: new RulePolicy([]), permissionGrants: first,
      store, systemPrompt: "test", onAsk: async () => { first.grant(spec(first)); return "allow"; } }).run("run", { cwd: store.root });
    await collect(initial); expect(executed).toHaveLength(1);
    const fresh = new PermissionGrantRegistry();
    const resumed = createAgent({ provider: new Provider(["git status"]), tools: [tool(executed)], permissions: new RulePolicy([]), permissionGrants: fresh,
      store, systemPrompt: "test" }).run("continue", { resume: initial.id });
    const { events } = await collect(resumed); expect(executed).toHaveLength(1); expect(events.some(e => e.type === "tool.denied")).toBe(true); expect(fresh.list()).toEqual([]);
  });
});
