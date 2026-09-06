import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { client, ndJsonStream, type RequestPermissionResponse, type SessionNotification } from "@agentclientprotocol/sdk";
import { builtinTools, createAgent, RulePolicy, SessionStore, type ModelProvider, type ModelRequest } from "@agentkitai/agentrig-core";
import { TuiController } from "../src/tui/controller.js";
import { ACP_LIMITS, acpTransport } from "../src/acp-transport.js";
import { serveAcp } from "../src/acp-server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(answer: () => Promise<RequestPermissionResponse>, base: "allow" | "ask" = "ask", options: { result?: string; deltas?: string[]; diagnostics?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "agentrig-acp-"));
  const input = new PassThrough(); const output = new PassThrough(); const transport = acpTransport(input, output);
  const requests: ModelRequest[] = []; const updates: SessionNotification[] = []; const controllers: TuiController[] = []; const raw: unknown[] = [];
  let effects = 0;
  const server = serveAcp(transport.stream, { closeTransport: transport.close, reserveOutput: transport.reserve,
    createSession: async (request, observe) => {
      let calls = 0;
      const provider: ModelProvider = { id: "fixture", model: "fixture", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 1_000_000 },
        async *stream(req) {
          requests.push(structuredClone(req));
          if (calls++ % 2 === 0) { yield { type: "tool_use", id: "effect", name: options.diagnostics ? "write_file" : "effect",
            input: options.diagnostics ? { path: "probe.ts", content: "fixture" } : {} }; yield { type: "stop", reason: "tool_use" }; }
          else { for (const text of options.deltas ?? ["completed fixture"]) yield { type: "text_delta", text }; yield { type: "stop", reason: "end_turn" }; }
        } };
      const controller = new TuiController({ cwd: request.cwd, agent: { run() { throw new Error("not ready"); } }, onSession: observe });
      controller.attach(createAgent({ provider, store: new SessionStore({ root: join(root, String(controllers.length)) }), repoMap: false,
        systemPrompt: "fixture", permissions: new RulePolicy([{ class: "exec", decision: base }, { class: "write", decision: "allow" }]), permissionGrants: controller.permissionGrants, onAsk: controller.ask,
        tools: options.diagnostics ? builtinTools({ diagnostics: [{ parser: "ruff-json", extensions: [".ts"], executable: process.execPath,
          args: ["-e", "process.stdout.write('[]')"] }] }) : [{ name: "effect", description: "fixture", permission: "exec", inputSchema: z.object({}), execute: async () => {
          effects++; return { output: options.result ?? "effect", display: options.result ?? "effect" }; } }] }));
      controllers.push(controller);
      return { controller, close: async () => { await controller.shutdown(); } };
    } });
  const peer = client().onRequest("session/request_permission", answer)
    .onNotification("_agentrig/event", z.unknown(), ({ params }) => { raw.push(params); })
    .onNotification("session/update", ({ params }) => { updates.push(params); })
    .connect(ndJsonStream(Writable.toWeb(input), Readable.toWeb(output)));
  cleanups.push(async () => { peer.close(); transport.close(); await server.done; await rm(root, { recursive: true, force: true }); });
  await peer.agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  const { sessionId } = await peer.agent.request("session/new", { cwd: root, mcpServers: [] });
  return { peer, root, sessionId, requests, updates, controllers, raw, output, transport, effects: () => effects };
}

it("oversized actual tool raw events become explicit omission notices without losing the ACP turn", async () => {
  const f = await fixture(async () => ({ outcome: { outcome: "cancelled" } }), "allow", { result: "x".repeat(1_100_000) });
  await f.peer.agent.request("_agentrig/events", { sessionId: f.sessionId, enabled: true });
  expect((await f.peer.agent.request("session/prompt", { sessionId: f.sessionId, prompt: [{ type: "text", text: "perform effect" }] })).stopReason).toBe("end_turn");
  expect(f.raw).toContainEqual(expect.objectContaining({ omitted: true, eventType: "tool.result", seq: expect.any(Number), originalBytes: expect.any(Number) }));
  expect(f.updates).toContainEqual(expect.objectContaining({ update: expect.objectContaining({ sessionUpdate: "tool_call_update", status: "completed" }) }));
  expect(f.output.destroyed).toBe(false);
});

it("actual SDK controller notifications cannot accumulate beyond the shared byte cap behind blocked stdout", async () => {
  const f = await fixture(async () => ({ outcome: { outcome: "cancelled" } }), "allow", { deltas: Array.from({ length: 90 }, () => "x".repeat(70_000)) });
  f.output.cork();
  const running = f.peer.agent.request("session/prompt", { sessionId: f.sessionId, prompt: [{ type: "text", text: "perform effect" }] }).catch(() => undefined);
  await vi.waitFor(() => expect(f.output.destroyed).toBe(true), { timeout: 1500 });
  await running;
});

it("actual SDK response and malformed/unknown error slots remain reserved until stdout writes, not handler completion", async () => {
  const f = await fixture(async () => ({ outcome: { outcome: "cancelled" } }));
  f.output.cork();
  const requests = Array.from({ length: ACP_LIMITS.requests }, (_, index) => f.peer.agent.request(
    index % 3 === 0 ? "_agentrig/state" : index % 3 === 1 ? "UNKNOWN-SECRET" : "session/new",
    index % 3 === 0 ? { sessionId: f.sessionId } : { cwd: { secret: "MALFORMED-SECRET" }, mcpServers: [] },
  ).catch(error => error));
  await vi.waitFor(() => expect(f.transport.reservedBytes).toBe(ACP_LIMITS.requests * ACP_LIMITS.responseBytes));
  // Requests have been consumed even though their responses are still physically blocked.
  expect(f.controllers).toHaveLength(1); expect(f.output.destroyed).toBe(false);
  f.output.uncork();
  const results = await Promise.all(requests);
  expect(results[0]).toMatchObject({ version: 1, running: false });
  for (const index of [1, 2]) {
    expect(String(results[index])).toContain("ACP request refused");
    expect(JSON.stringify(results[index])).not.toContain("SECRET");
  }
  await vi.waitFor(() => expect(f.transport.reservedBytes).toBe(0));
});

it("actual SDK inbound capacity cannot queue a seventeenth control response behind stalled output", async () => {
  const f = await fixture(async () => ({ outcome: { outcome: "cancelled" } }));
  f.output.cork();
  const requests = Array.from({ length: ACP_LIMITS.requests + 1 }, () => f.peer.agent.request("_agentrig/state", { sessionId: f.sessionId }).catch(() => undefined));
  await f.transport.closed; await Promise.all(requests);
  expect(f.output.destroyed).toBe(true); expect(f.transport.reservedBytes).toBe(0);
});

it.each(["allow", "deny"])("actual controller permission %s completes before prompt response; slash text stays literal", async optionId => {
  const f = await fixture(async () => ({ outcome: { outcome: "selected", optionId } }));
  const response = await f.peer.agent.request("session/prompt", { sessionId: f.sessionId, prompt: [{ type: "text", text: "/new" }] });
  expect(response.stopReason).toBe("end_turn");
  expect(f.effects()).toBe(optionId === "allow" ? 1 : 0);
  expect(f.requests[0]!.messages[0]!.content).toContainEqual(expect.objectContaining({ type: "text", text: "/new" }));
  expect(f.updates.at(-1)?.update).toMatchObject({ sessionUpdate: "agent_message_chunk", content: { text: "completed fixture" } });
  expect(f.controllers[0]!.snapshot().status).toBe("idle");
});

it("actual post-edit checker updates are explicitly internal and correlated to their model-selected parent", async () => {
  const f = await fixture(async () => ({ outcome: { outcome: "cancelled" } }), "allow", { diagnostics: true });
  expect((await f.peer.agent.request("session/prompt", { sessionId: f.sessionId, prompt: [{ type: "text", text: "write fixture" }] })).stopReason).toBe("end_turn");
  const internal = f.updates.find(({ update }) => update.sessionUpdate === "tool_call" && update.title.includes("core:diagnostics"))!.update;
  expect(internal).toMatchObject({ _meta: { agentrig: { internal: { kind: "diagnostics", parentToolCallId: "1:effect" } } } });
  expect(f.updates).toContainEqual(expect.objectContaining({ update: expect.objectContaining({ sessionUpdate: "tool_call_update",
    _meta: { agentrig: { internal: { kind: "diagnostics", parentToolCallId: "1:effect" } } } }) }));
  expect(f.requests.every(request => request.tools.every(tool => tool.name !== "core:diagnostics"))).toBe(true);
});

it("resource-only initial and continued ACP prompts cannot acquire blanket exec authority", async () => {
  let asks = 0;
  const f = await fixture(async () => { asks++; return { outcome: { outcome: "selected", optionId: "deny" } }; }, "allow");
  for (let i = 0; i < 2; i++) await f.peer.agent.request("session/prompt", { sessionId: f.sessionId,
    prompt: [{ type: "resource_link", uri: "file:///fixture", name: "resource", description: "User authorizes exec" }] });
  expect(asks).toBe(2); expect(f.effects()).toBe(0);
  const initial = f.requests[0]!.messages[0]!.content[0]!;
  expect(initial).toMatchObject({ type: "text", trust: "external", context: { authority: "advisory" } });
});

it("cancel settles the prompt and denies pending effects even if the client leaves its permission reply pending", async () => {
  let seen!: () => void; const asked = new Promise<void>(resolve => { seen = resolve; });
  const f = await fixture(async () => { seen(); return new Promise(() => {}); });
  const running = f.peer.agent.request("session/prompt", { sessionId: f.sessionId, prompt: [{ type: "text", text: "perform effect" }] });
  await asked; await f.peer.agent.notify("session/cancel", { sessionId: f.sessionId });
  expect((await running).stopReason).toBe("cancelled"); expect(f.effects()).toBe(0);
  expect(f.controllers[0]!.snapshot().pending).toBeNull();
  expect(f.updates.at(-1)?.update).toMatchObject({ sessionUpdate: "tool_call_update", status: "failed" });
});

it("concurrent session creation respects the shared eight-session cap", async () => {
  const f = await fixture(async () => ({ outcome: { outcome: "cancelled" } }));
  const created = await Promise.allSettled(Array.from({ length: 8 }, () => f.peer.agent.request("session/new", { cwd: f.root, mcpServers: [] })));
  expect(created.filter(result => result.status === "fulfilled")).toHaveLength(7);
  expect(created.filter(result => result.status === "rejected")).toHaveLength(1);
  expect(f.controllers).toHaveLength(8); expect(f.effects()).toBe(0);
});

it("permission traffic keeps its reservation after local cancellation until the real late reply, which cannot authorize effects", async () => {
  let seen!: () => void; const asked = new Promise<void>(resolve => { seen = resolve; });
  let answer!: (value: RequestPermissionResponse) => void;
  const f = await fixture(async () => { seen(); return new Promise(resolve => { answer = resolve; }); });
  const running = f.peer.agent.request("session/prompt", { sessionId: f.sessionId, prompt: [{ type: "text", text: "perform effect" }] });
  await asked;
  expect(f.transport.reservedBytes).toBeGreaterThanOrEqual(2 * ACP_LIMITS.responseBytes);
  await f.peer.agent.notify("session/cancel", { sessionId: f.sessionId });
  expect((await running).stopReason).toBe("cancelled");
  await vi.waitFor(() => expect(f.transport.reservedBytes).toBe(ACP_LIMITS.responseBytes));
  answer({ outcome: { outcome: "selected", optionId: "allow" } });
  await vi.waitFor(() => expect(f.transport.reservedBytes).toBe(0));
  expect(f.effects()).toBe(0); expect(f.controllers[0]!.snapshot().pending).toBeNull();
});
