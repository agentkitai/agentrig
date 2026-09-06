import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, expect, it, vi } from "vitest";
import { createAgent, RulePolicy, SessionStore, type AnyTool, type ModelEvent, type ModelProvider, type ModelRequest, type Session } from "@agentkitai/agentrig-core";

// Captured on pre-extraction main 3c09f84. No model calls or host instruction discovery.
// Fixed clock/id and a synthetic cwd keep complete traces portable without dropping fields.
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const stop: ModelEvent = { type: "stop", reason: "end_turn" };
const usage: ModelEvent = { type: "usage", usage: { input: 7, output: 3 } };
const call = (name: string, id: string, input: unknown): ModelEvent => ({ type: "tool_use", name, id, input });
async function fixture(turns: ModelEvent[][], tools: AnyTool[]) {
  const root = await mkdtemp(join(tmpdir(), "agentrig-h6-trace-")); roots.push(root);
  const store = new SessionStore({ root, now: () => 42, newId: () => "trace" });
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    id: "trace", model: "trace", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 },
    async *stream(request) { requests.push(structuredClone(request)); const turn = turns.shift(); if (!turn) throw new Error("missing scripted turn"); yield* turn; },
  };
  return { store, requests, config: { provider, tools, store, systemPrompt: "trace system", repoMap: false as const,
    now: () => 42, permissions: new RulePolicy([{ class: "read" as const, decision: "allow" as const }]) } };
}
function echo(): AnyTool {
  return { name: "echo", description: "echo", permission: "read", inputSchema: z.object({ text: z.string() }),
    execute: async input => ({ output: input.text, display: input.text }) };
}
async function trace(session: Session) {
  const events = []; for await (const event of session.events) events.push(event);
  return { events, summary: await session.done };
}
it("preserves complete sequential permission/hook/tool and resumed traces", async () => {
  const f = await fixture([
    [call("echo", "ok", { text: "original" }), call("denied", "no", {}), call("unknown", "missing", {}), usage, { type: "stop", reason: "tool_use" }],
    [{ type: "text_delta", text: "finished" }, usage, stop],
    [{ type: "text_delta", text: "resumed" }, usage, stop],
  ], [echo(), { ...echo(), name: "denied", permission: "write", inputSchema: z.object({}) }]);
  const agent = createAgent({ ...f.config, hooks: [
    { point: "pre_tool", handler: ctx => ctx.tool?.name === "echo" ? { action: "modify", patch: { text: "patched" } } : { action: "continue" } },
    { point: "post_tool", handler: () => ({ action: "inject", message: "guidance" }) },
  ] });
  const first = await trace(agent.run("trace task", { cwd: "/agentrig-h6-synthetic" }));
  const resumed = await trace(agent.run("continue", { resume: "trace" }));
  expect({ first, resumed, requests: f.requests, snapshot: await f.store.readSnapshot("trace") }).toMatchSnapshot();
});
it("preserves aborted tool settlement, late-emission guard and end ordering", async () => {
  let session!: Session; let late!: () => void;
  const tool: AnyTool = { ...echo(), execute: async (_input, ctx) => {
    late = () => ctx.emit({ type: "memory.note", scope: "project", path: "late" });
    session.control.abort(); return { output: "unused", display: "unused" };
  } };
  const f = await fixture([[call("echo", "cancel", { text: "cancel" }), usage, { type: "stop", reason: "tool_use" }]], [tool]);
  session = createAgent(f.config).run("abort trace", { cwd: "/agentrig-h6-synthetic" });
  const result = await trace(session);
  const append = vi.spyOn(f.store, "append");
  late(); await Promise.resolve();
  expect(append).not.toHaveBeenCalled();
  const replay = []; for await (const event of session.events) replay.push(event);
  expect({ result, replay, requests: f.requests, snapshot: await f.store.readSnapshot("trace") }).toMatchSnapshot();
});
it("preserves tool-emitter authority and released replan state", async () => {
  const tool: AnyTool = { ...echo(), execute: async (_input, ctx) => {
    ctx.emit({ type: "plan.updated", items: [] });
    ctx.emit({ type: "memory.note", scope: "project", path: "kept" });
    return { output: "ok", display: "ok" };
  } };
  const f = await fixture([[call("echo", "emit", { text: "x" }), usage, { type: "stop", reason: "tool_use" }], [usage, stop]], [tool]);
  const session = createAgent(f.config).run("authority trace", { cwd: "/agentrig-h6-synthetic" });
  session.control.requirePlan("revise");
  expect({ result: await trace(session), planRequired: session.control.planRequired(), requests: f.requests }).toMatchSnapshot();
});
