import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { thinkingFromItem } from "../src/providers/thinking.js";
import { createAgent, createOutputContract, parseOutputJson, RulePolicy, SessionStore, messagesFromEvents,
  type AgentConfig, type ModelEvent, type ModelProvider, type ModelRequest } from "@agentkitai/agentrig-core";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
const text = (value: string, stop: "end_turn" | "max_tokens" | "refusal" = "end_turn"): ModelEvent[] => [
  { type: "text_delta", text: value }, { type: "usage", usage: { input: 10, output: 5 } }, { type: "stop", reason: stop }];

it("reasoning replay survives role refusal and JSON repair without entering final validation", async () => {
  const block = thinkingFromItem("anthropic", { type: "thinking", thinking: "not JSON", signature: "exact-opaque-signature" });
  const f = await fixture([
    [{ type: "thinking", block }, { type: "tool_use", id: "excluded", name: "effect", input: {} }, { type: "stop", reason: "tool_use" }],
    [{ type: "thinking", block }, ...text("invalid")],
    [{ type: "thinking", block }, ...text('{"ok":true}')],
  ], { toolAllowlist: [] });
  const session = f.agent.run("answer", { cwd: f.root });
  expect((await session.done).reason).toBe("done"); expect(f.effects()).toBe(0);
  expect(f.requests).toHaveLength(3); expect(f.requests.every(r => r.tools.length === 0)).toBe(true);
  const retained = f.requests[2]!.messages.flatMap(m => m.content).filter(b => b.type === "thinking");
  expect(retained).toHaveLength(2);
  expect(retained.every(b => b.signature === block.signature && b.replay === block.replay)).toBe(true);
  const events = await f.store.readAll(session.id);
  expect(events).toContainEqual(expect.objectContaining({ type: "tool.denied", name: "effect" }));
  expect(events.filter(e => e.type === "output.validated").map(e => e.valid)).toEqual([false, true]);
  expect((await f.store.readSnapshot(session.id))!.messages).toEqual(messagesFromEvents(events));
});

it("repair refuses a role-allowed call before its strategy can dispatch", async () => {
  let strategies = 0;
  const f = await fixture([text("invalid"), [{ type: "tool_use", id: "repair-role", name: "effect", input: {} }, { type: "stop", reason: "tool_use" }]],
    { toolAllowlist: ["effect"], turnStrategy: { execute: async () => { strategies++; throw Error("not executed"); } } });
  const session = f.agent.run("answer", { cwd: f.root });
  expect((await session.done).reason).toBe("error"); expect(strategies).toBe(0); expect(f.effects()).toBe(0);
  expect(f.requests[0]!.tools.map(t => t.name)).toEqual(["effect"]); expect(f.requests[1]!.tools).toEqual([]);
});
async function fixture(responses: ModelEvent[][], overrides: Partial<AgentConfig> = {}) {
  const root = await mkdtemp(join(tmpdir(), "agentrig-output-")); roots.push(root);
  const store = new SessionStore({ root }); const requests: ModelRequest[] = []; let effects = 0;
  const provider: ModelProvider = { id: "fixture", model: "fixture", capabilities: { tools: true, parallelTools: true, caching: false, contextWindow: 1_000_000 },
    async *stream(request) { requests.push(structuredClone(request)); yield* responses[requests.length - 1] ?? text('{"ok":true}'); } };
  const agent = createAgent({ provider, store, systemPrompt: "fixture", repoMap: false, budget: { maxTurns: 5 },
    outputContract: createOutputContract(schema), permissions: new RulePolicy([], "allow"),
    tools: [{ name: "effect", description: "effect", permission: "exec", effects: "workspace", inputSchema: z.object({}),
      execute: async () => { effects++; return { output: "effect", display: "effect" }; } }], ...overrides });
  return { agent, requests, store, root, effects: () => effects };
}

it("strict bounded schema compilation covers booleans, nullable pairs and exact keywords", () => {
  expect(createOutputContract(true).validate("null")).toBe("valid");
  expect(createOutputContract(false).validate("null")).toBe("schema");
  expect(createOutputContract({ type: ["string", "null"], maxLength: 3 }).validate("null")).toBe("valid");
  expect(createOutputContract({ type: ["string", "null"], maxLength: 3 }).validate('"long"')).toBe("schema");
  for (const invalid of [{ type: "object", typo: true }, { $ref: "https://must-not-fetch" }, { type: "string", pattern: "(a+)+$" },
    { type: "string", default: "x" }, { type: ["string", "number"] }, { type: "array", uniqueItems: true }, { type: "string", minLength: -1 }])
    expect(() => createOutputContract(invalid)).toThrow("Output schema refused");
  expect(() => createOutputContract(schema, "native")).not.toThrow();
  expect(() => createOutputContract({ ...schema, required: [] }, "native")).toThrow();
  expect(() => createOutputContract(true, "native")).toThrow();
  expect(() => createOutputContract({ ...schema, properties: { ok: { type: "array" } } }, "native")).toThrow();
  const mutable = structuredClone(schema), contract = createOutputContract(mutable);
  mutable.properties.ok.type = "string" as "boolean";
  expect(contract.validate('{"ok":true}')).toBe("valid"); expect(Object.isFrozen(contract.schema)).toBe(true);
});
it("bounded parser rejects duplicate escaped keys, malformed numbers, deep/large text and trailing data", () => {
  for (const value of ['{"type":"string","type":"number"}', '{"a":1,"\\u0061":2}', '01', '1e999', 'true false', '{"a":1,}', '"bad\nstring"'])
    expect(() => parseOutputJson(value, 1000, 12)).toThrow();
  expect(() => parseOutputJson("[".repeat(14)+"0"+"]".repeat(14), 1000, 12)).toThrow("bound");
  expect(createOutputContract(true).validate('"' + "a".repeat(65_536) + '"')).toBe("bound");
  expect(createOutputContract(schema).validate('```json\n{"ok":true}\n```')).toBe("json");
});
it.each([{ responses: [text('{"ok":true}')] }, { responses: [text("wrong"), text('{"ok":true}')] }])("validates first answer or one repair while preserving raw messages", async ({ responses }) => {
  const f = await fixture(responses); const session = f.agent.run("give an answer", { cwd: f.root });
  expect((await session.done).reason).toBe("done"); expect(f.requests).toHaveLength(responses.length);
  const events = await f.store.readAll(session.id); expect(events.filter(e => e.type === "output.validated")).toHaveLength(responses.length);
  const replay = messagesFromEvents(events); const snapshot = (await f.store.readSnapshot(session.id))!.messages;
  expect(snapshot).toEqual(replay);
  if (responses.length === 2) {
    expect(JSON.stringify(replay)).toContain("wrong"); expect(f.requests[1]!.tools).toEqual([]);
    expect(f.requests[1]!.messages.flatMap(m => m.content).find(b => b.type === "text" && b.text.includes("Platform output repair"))?.context?.authority).toBe("advisory");
  }
});
it.each([{ response: text("still wrong") }, { response: text('{"ok":', "max_tokens") }])("invalid or truncated repair cannot gain extra turns", async ({ response }) => {
  const f = await fixture([text("wrong"), response]); const session = f.agent.run("answer", { cwd: f.root });
  expect((await session.done).reason).toBe("error"); expect(f.requests).toHaveLength(2);
  expect((await f.store.readAll(session.id)).filter(e => e.type === "turn.continued")).toEqual([]);
});
it("repair tool calls never reach even the actual custom strategy or callbacks and keep paired resumable history", async () => {
  let strategies = 0;
  const f = await fixture([text("wrong"), [{ type: "tool_use", id: "blocked", name: "effect", input: {} }, { type: "stop", reason: "tool_use" }]],
    { turnStrategy: { execute: async () => { strategies++; throw new Error("must never run"); } } });
  const session = f.agent.run("execute if needed", { cwd: f.root });
  expect((await session.done).reason).toBe("error"); expect(strategies).toBe(0); expect(f.effects()).toBe(0);
  const events = await f.store.readAll(session.id);
  expect(messagesFromEvents(events).flatMap(m => m.content).find(b => b.type === "tool_result" && b.toolUseId === "blocked")).toMatchObject({ isError: true, content: expect.stringContaining("not executed") });
  expect((await f.agent.run("", { cwd: f.root, resume: session.id }).done).reason).toBe("done"); expect(f.effects()).toBe(0);
});
it.each(["budget", "veto", "abort"])("%s before repair request produces no false repair result", async gate => {
  const f = await fixture([text("wrong")], gate === "budget" ? { budget: { maxTurns: 1 } } : { hooks: [{ point: "pre_model", handler: async ctx => {
    if (ctx.turn === 2) return { action: "deny", reason: "fixture" }; return { action: "continue" };
  } }] });
  const session = f.agent.run("answer", { cwd: f.root });
  if (gate === "abort") for await (const event of session.events) { if (event.type === "output.validated") { session.control.abort(); break; } }
  expect((await session.done).reason).toBe(gate === "budget" ? "budget" : gate === "abort" ? "aborted" : "error");
  expect(f.requests).toHaveLength(1);
  expect((await f.store.readAll(session.id)).filter(e => e.type === "output.validated" && e.attempt === "repair")).toEqual([]);
});
it("ordinary tool dispatch and H7a continuations remain available before final repair", async () => {
  const f = await fixture([[{ type: "tool_use", id: "ordinary", name: "effect", input: {} }, { type: "stop", reason: "tool_use" }],
    text('{"ok":', "max_tokens"), text('{"ok":true}')]);
  const session = f.agent.run("execute and answer", { cwd: f.root }); expect((await session.done).reason).toBe("done");
  expect(f.effects()).toBe(1); expect(f.requests).toHaveLength(3);
  expect((await f.store.readAll(session.id)).filter(e => e.type === "turn.continued")).toHaveLength(1);
});
it("no-repo-map repeated tool turns and repair each contain exactly one schema instruction", async () => {
  const calls: ModelEvent[][] = [1, 2, 3].map(n => [{ type: "tool_use", id: `effect-${n}`, name: "effect", input: {} }, { type: "stop", reason: "tool_use" }]);
  const f = await fixture([...calls, text("invalid"), text('{"ok":true}')]);
  const session = f.agent.run("perform the task then answer", { cwd: f.root });
  expect((await session.done).reason).toBe("done"); expect(f.requests).toHaveLength(5); expect(f.effects()).toBe(3);
  expect(f.requests.map(req => req.system.split("Return your final answer as one complete JSON value").length - 1)).toEqual([1, 1, 1, 1, 1]);
  expect(f.requests[4]!.messages.flatMap(m => m.content).filter(b => b.type === "text" && b.text.includes("Platform output repair"))).toHaveLength(1);
});
