import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { createAgent, HarnessEvent, PlanItem, RulePolicy, SessionStore, updatePlanTool,
  type AgentConfig, type ModelEvent, type ModelProvider, type ModelRequest } from "@agentkitai/agentrig-core";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const stop: ModelEvent = { type: "stop", reason: "end_turn" };
const call = (name: string, input: unknown): ModelEvent[] => [{ type: "tool_use", id: name, name, input }, { type: "stop", reason: "tool_use" }];
const items = [{ id: "a", text: "test the change", status: "done" as const, accept: "pnpm test exits 0" },
  { id: "b", text: "old plan item", status: "pending" as const }];
async function fixture(turns: ModelEvent[][]) {
  const root = await mkdtemp(join(tmpdir(), "agentrig-accept-plan-")); roots.push(root);
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = { id: "fixture", model: "fixture", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100000 },
    async *stream(request) { requests.push(structuredClone(request)); yield* turns.shift() ?? [stop]; } };
  const config: AgentConfig = { provider, tools: [updatePlanTool()], systemPrompt: "CUSTOM SYSTEM", repoMap: false,
    permissions: new RulePolicy([{ class: "read", decision: "allow" }, { class: "exec", decision: "allow" }]), store: new SessionStore({ root }) };
  return { root, requests, turns, config };
}

it("the first real request asks for acceptance without replacing custom or hook instructions, forcing a call, or adding requests", async () => {
  const f = await fixture([call("update_plan", { items }), [stop]]);
  f.config.hooks = [{ point: "pre_model", handler: context => ({ action: "modify", patch: { system: `${context.request!.system}\n\nHOOK NOTE` } }) }];
  const session = createAgent(f.config).run("test task", { cwd: f.root }); await session.done;
  expect(f.requests).toHaveLength(2);
  expect(f.requests[0]!.system).toContain("CUSTOM SYSTEM\n\nHOOK NOTE\n\nAcceptance planning:");
  expect(f.requests[0]!.system).toContain("Include an accept field for every item");
  expect(f.requests[1]!.system).not.toContain("Acceptance planning:");
  expect(f.requests[0]!.systemContexts?.at(-1)).toEqual({ principal: "platform", authority: "instruction" });
  const schema = f.requests[0]!.tools.find(tool => tool.name === "update_plan")!.inputSchema as any;
  expect(schema.properties.items.items.properties.accept.maxLength).toBe(1024);
  expect(schema.properties.items.items.required).not.toContain("accept");
  const events = await f.config.store.readAll(session.id);
  expect(events.filter(event => event.type === "tool.call")).toHaveLength(1);
  expect(events.find(event => event.type === "plan.updated")).toMatchObject({ items });
  expect(events.find(event => event.type === "tool.result")).toMatchObject({ display: expect.stringContaining('accept: "pnpm test exits 0" (declared, unverified)') });
  expect(events.find(event => event.type === "tool.result")).toMatchObject({ display: expect.stringContaining("undeclared (unverified)") });
  const manifest = events.find(event => event.type === "context.manifest");
  expect(manifest?.type === "context.manifest" && manifest.blocks.some(block => block.origin === "runtime.acceptance-planning" && block.context?.principal === "platform")).toBe(true);
  expect(events.some(event => event.type === "steer")).toBe(false);
});

it("legacy declarations survive validation and resume; resumed planning is not fresh user consent", async () => {
  const f = await fixture([call("update_plan", { items }), [stop]]); let executed = false;
  f.config.tools.push({ name: "exec", description: "no real external effects", permission: "exec", inputSchema: z.object({}),
    execute: async () => { executed = true; return { output: "done", display: "done" }; } });
  const agent = createAgent(f.config); const first = agent.run("plan", { cwd: f.root }); await first.done;
  f.turns.push(call("exec", {}), [stop]); const resumed = agent.run("", { resume: first.id }); await resumed.done;
  expect(f.requests[2]!.system).toContain("Acceptance planning:");
  expect(f.requests[3]!.system).not.toContain("Acceptance planning:");
  expect(JSON.stringify(f.requests[2]!.messages)).toContain("pnpm test exits 0");
  expect(JSON.stringify(f.requests[2]!.messages)).toContain("old plan item");
  expect(executed).toBe(false);
  expect(await f.config.store.readAll(first.id)).toContainEqual(expect.objectContaining({ type: "permission.expansion", decision: "deny", surface: "exec" }));
});

it("the instruction is absent without a plan tool, and a model may answer without planning", async () => {
  for (const enabled of [false, true]) {
    const f = await fixture([[{ type: "text_delta", text: "answer" }, stop]]);
    if (!enabled) f.config.tools = [];
    const session = createAgent(f.config).run("question", { cwd: f.root }); expect((await session.done).reason).toBe("done");
    expect(f.requests).toHaveLength(1); expect(f.requests[0]!.system.includes("Acceptance planning:")).toBe(enabled);
    expect((await f.config.store.readAll(session.id)).some(event => event.type === "tool.call")).toBe(false);
  }
});

it("canonical and tool schemas share bounded optional checks without interpreting check text as a command", () => {
  const tool = updatePlanTool();
  expect(PlanItem.parse(items[1])).toEqual(items[1]);
  expect(tool.inputSchema.parse({ items })).toEqual({ items });
  for (const accept of ["", " \n\t", "x".repeat(1025), 42]) {
    expect(PlanItem.safeParse({ ...items[0], accept }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ items: [{ ...items[0], accept }] }).success).toBe(false);
  }
  for (const accept of ["x".repeat(1024), "endpoint returns 401 without a token", "echo never-executed; exit 1\nexpect failure"]) {
    const event = HarnessEvent.parse({ type: "plan.updated", items: [{ ...items[0], accept }], seq: 0, ts: 1, sessionId: "s" });
    expect(HarnessEvent.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
  }
});
