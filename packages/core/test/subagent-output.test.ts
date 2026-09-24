import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createAgent, createOutputContract, RulePolicy, SessionStore, subagentTool, type ModelEvent, type ModelProvider, type ModelRequest, type ToolContext } from "@agentkitai/agentrig-core";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const schema = { type: "object", properties: { pr: { type: "integer", minimum: 1 } }, required: ["pr"], additionalProperties: false };
async function run(answers: (string | ModelEvent[])[], outputSchema?: unknown, inherited = false, maxTurns = 5) {
  const root = await mkdtemp(join(tmpdir(), "child-output-")); roots.push(root);
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = { id: "fake", model: "fake", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100000 },
    async *stream(request) { requests.push(request); const answer = answers.shift() ?? "exhausted"; if (Array.isArray(answer)) yield* answer; else { yield { type: "text_delta", text: answer }; yield { type: "stop", reason: "end_turn" }; } } };
  const store = new SessionStore({ root });
  const tool = subagentTool({ createAgent, maxTurns, childConfig: () => ({ provider, store, tools: [], permissions: new RulePolicy([]), systemPrompt: "child", ...(inherited ? { outputContract: createOutputContract(schema) } : {}) }) });
  const input = { task: "answer", ...(outputSchema === undefined ? {} : { outputSchema }) };
  const result = await tool.execute(tool.inputSchema.parse(input), { cwd: root, sessionId: "parent", signal: new AbortController().signal, emit() {} } as ToolContext);
  const output = result.output as { result?: unknown; spawn?: { childSessionId: string } };
  const events = output.spawn ? await store.readAll(output.spawn.childSessionId) : [];
  return { result, output, events, requests, tool };
}
it("returns parsed result and child-local output.validated for a valid schema answer", async () => {
  const r = await run(['{"pr":7}'], schema);
  expect(r.output.result).toEqual({ pr: 7 });
  expect(r.events.filter(e => e.type === "output.validated")).toMatchObject([{ valid: true, attempt: "initial" }]);
  expect(r.result.isError).not.toBe(true);
  expect(r.tool.jsonSchema).toHaveProperty("properties.outputSchema");
});
it("repairs once using the headless tool-free repair and preserves raw attempts", async () => {
  const r = await run(['{}', '{"pr":8}'], schema);
  expect(r.output.result).toEqual({ pr: 8 });
  expect(r.events.filter(e => e.type === "output.validated")).toMatchObject([{ valid: false, attempt: "initial" }, { valid: true, attempt: "repair" }]);
  expect(r.requests).toHaveLength(2);
  expect(r.requests[1]!.tools).toEqual([]);
  expect(r.events.filter(e => e.type === "model.delta").map(e => e.text)).toEqual(['{}', '{"pr":8}']);
});
it("rejects still-incomplete output after one repair without a parsed result", async () => {
  const r = await run(['{}', '{}', '{"pr":9}'], schema);
  expect(r.result.isError).toBe(true);
  expect(r.output).not.toHaveProperty("result");
  expect(r.requests).toHaveLength(2);
});
it("keeps free text and does not inherit a configured output constraint", async () => {
  const r = await run(["plain answer"], undefined, true);
  expect(r.result.isError).not.toBe(true);
  expect(r.result.display).toContain("plain answer");
  expect(r.output).not.toHaveProperty("result");
  expect(r.events.some(e => e.type === "output.validated")).toBe(false);
});
it("refuses unsupported schema before creating a child", async () => {
  const r = await run(["unused"], { $ref: "https://example.com/schema" });
  expect(r.result.isError).toBe(true);
  expect(r.requests).toHaveLength(0);
  expect(r.output).not.toHaveProperty("spawn");
});
it("supports boolean schemas and parsed null without falling back to prose", async () => {
  const r = await run(["null"], true);
  expect(r.output).toHaveProperty("result", null);
  const denied = await run(["null", "null"], false);
  expect(denied.result.isError).toBe(true);
});

it("does not raise the child turn budget to permit output repair", async () => {
  const r = await run(['{}', '{"pr":7}'], schema, false, 1);
  expect(r.result.isError).toBe(true);
  expect(r.requests).toHaveLength(1);
  expect(r.output).not.toHaveProperty("result");
});
it("fails a repair that attempts tools without a third turn", async () => {
  const r = await run(['{}', [{ type: "tool_use", id: "t", name: "write_file", input: {} }, { type: "stop", reason: "tool_use" }], '{"pr":7}'], schema);
  expect(r.result.isError).toBe(true);
  expect(r.requests).toHaveLength(2);
  expect(r.events.filter(e => e.type === "output.validated")).toMatchObject([{ valid: false, attempt: "initial" }, { valid: false, attempt: "repair", category: "tool" }]);
  expect(r.events.some(e => e.type === "tool.start")).toBe(false);
});
