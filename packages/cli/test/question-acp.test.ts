import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { client, ndJsonStream } from "@agentclientprotocol/sdk";
import { askUserTool, createAgent, RulePolicy, SessionStore, type ModelProvider, type ModelRequest } from "@agentkitai/agentrig-core";
import { TuiController } from "../src/tui/controller.js";
import { ACP_LIMITS, acpTransport } from "../src/acp-transport.js";
import { serveAcp } from "../src/acp-server.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(answer: (params: { question: { id: string } }) => Promise<unknown>, supported = true) {
  const cwd = await mkdtemp(join(tmpdir(), "agentrig-question-acp-"));
  const input = new PassThrough(); const output = new PassThrough(); const transport = acpTransport(input, output);
  const requests: ModelRequest[] = []; let controller!: TuiController;
  const server = serveAcp(transport.stream, { closeTransport: transport.close, reserveOutput: transport.reserve,
    createSession: async (_request, observe) => {
      const provider: ModelProvider = { id: "fixture", model: "fixture", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 },
        async *stream(req) { requests.push(req); if (requests.length === 1) { yield { type: "tool_use", id: "ask", name: "ask_user", input: { prompt: "Which format?", options: ["Text", "JSON"] } }; yield { type: "stop", reason: "tool_use" }; }
          else yield { type: "stop", reason: "end_turn" }; } };
      controller = new TuiController({ cwd, agent: { run() { throw new Error("not ready"); } }, onSession: observe });
      controller.attach(createAgent({ provider, store: new SessionStore({ root: join(cwd, "logs") }), repoMap: false,
        systemPrompt: "fixture", tools: [askUserTool()], permissions: new RulePolicy([{ class: "read", decision: "allow" }]), onQuestion: controller.askQuestion }));
      return { controller, close: () => controller.shutdown() };
    } });
  const peer = client().onRequest("_agentrig/question", z.object({ question: z.object({ id: z.string() }).passthrough() }).passthrough(), ({ params }) => answer(params))
    .onNotification("session/update", () => {}).connect(ndJsonStream(Writable.toWeb(input), Readable.toWeb(output)));
  cleanups.push(async () => { peer.close(); transport.close(); await server.done; await rm(cwd, { recursive: true, force: true }); });
  await peer.agent.request("initialize", { protocolVersion: 1, clientCapabilities: {}, ...(supported ? { _meta: { agentrig: { questions: 1 } } } : {}) });
  const { sessionId } = await peer.agent.request("session/new", { cwd, mcpServers: [] });
  const prompt = () => peer.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "choose" }] });
  return { peer, sessionId, requests, controller, transport, prompt };
}

it.each(["human", "file"])("negotiated ACP %s answer resumes with its actual source", async source => {
  const f = await fixture(async params => ({ id: params.question.id, reply: { source, answer: { option: 1 } } }));
  expect((await f.prompt()).stopReason).toBe("end_turn");
  expect(f.requests).toHaveLength(2);
  expect(f.requests[1]!.messages.flatMap(m => m.content)).toContainEqual(expect.objectContaining({ type: "tool_result", trust: source === "human" ? "user" : "external" }));
  expect(f.controller.permissionGrants.inspect()).toEqual([]);
});

it("unnegotiated clients fail required questions without sending a question RPC", async () => {
  let called = 0;
  const f = await fixture(async () => { called++; return {}; }, false);
  await expect(f.prompt()).rejects.toThrow();
  expect(called).toBe(0); expect(f.requests).toHaveLength(1);
  expect(f.controller.snapshot().question).toBeNull();
});

it("malformed or mismatched replies cannot answer a question", async () => {
  const f = await fixture(async () => ({ id: "00000000-0000-4000-8000-000000000000", reply: { source: "human", answer: { option: 0 } } }));
  await expect(f.prompt()).rejects.toThrow(); expect(f.requests).toHaveLength(1);
});

it("local unanswered settlement releases the ACP prompt but retains the unanswered SDK reply reservation", async () => {
  let reply!: (value: unknown) => void; let id: string | undefined;
  const f = await fixture(async params => { id = params.question.id; return new Promise(resolve => { reply = resolve; }); });
  const running = f.prompt().catch(() => "refused");
  await vi.waitFor(() => expect(id).toBeDefined());
  f.controller.snapshot().question!.resolve(null);
  expect(await running).toBe("refused");
  expect(await f.peer.agent.request("_agentrig/state", { sessionId: f.sessionId })).toMatchObject({ running: false, pendingQuestion: null });
  expect(f.transport.reservedBytes).toBeGreaterThanOrEqual(ACP_LIMITS.responseBytes);
  reply({ id, reply: { source: "human", answer: { text: "too late" } } });
  await vi.waitFor(() => expect(f.transport.reservedBytes).toBe(0));
  expect(f.requests).toHaveLength(1);
}, 5000);

it("session cancellation joins a pending question whose peer never answers", async () => {
  let waiting = false;
  const f = await fixture(async () => { waiting = true; return new Promise(() => {}); });
  const running = f.prompt();
  await vi.waitFor(() => expect(waiting).toBe(true));
  await f.peer.agent.notify("session/cancel", { sessionId: f.sessionId });
  expect((await running).stopReason).toBe("cancelled");
  expect(f.controller.snapshot().question).toBeNull(); expect(f.requests).toHaveLength(1);
});
