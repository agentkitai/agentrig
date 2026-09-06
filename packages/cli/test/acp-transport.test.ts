import { PassThrough, Writable } from "node:stream";
import { expect, it } from "vitest";
import { agent, client, ndJsonStream } from "@agentclientprotocol/sdk";
import { Readable } from "node:stream";
import { ACP_LIMITS, acpTransport } from "../src/acp-transport.js";

it("speaks real SDK request/response over streams and separates outbound permission IDs", async () => {
  const incoming = new PassThrough(); const outgoing = new PassThrough();
  const transport = acpTransport(incoming, outgoing);
  const server = agent().onRequest("initialize", () => ({ protocolVersion: 1, agentCapabilities: {} }))
    .onRequest("session/new", async ({ client: peer }) => {
      const answer = await peer.request("session/request_permission", { sessionId: "fixture", toolCall: { toolCallId: "approval" },
        options: [{ optionId: "no", name: "Deny once", kind: "reject_once" }] });
      expect(answer.outcome).toEqual({ outcome: "selected", optionId: "no" });
      return { sessionId: "fixture" };
    }).connect(transport.stream);
  const peer = client().onRequest("session/request_permission", () => ({ outcome: { outcome: "selected", optionId: "no" } }))
    .connect(ndJsonStream(Writable.toWeb(incoming), Readable.toWeb(outgoing)));
  try {
    expect(await peer.agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} })).toMatchObject({ protocolVersion: 1 });
    expect(await peer.agent.request("session/new", { cwd: "/fixture", mcpServers: [] })).toEqual({ sessionId: "fixture" });
  } finally { peer.close(); server.close(); transport.close(); }
});

it.each(["malformed", "oversize", "duplicate"])("closes boundedly on %s input without forwarding authority", async kind => {
  const input = new PassThrough(); const output = new PassThrough();
  const transport = acpTransport(input, output); const reader = transport.stream.readable.getReader();
  const consume = (async () => { try { while (!(await reader.read()).done) { /* drain */ } } catch { /* closed */ } })();
  const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  input.write(kind === "malformed" ? "{invalid\n" : kind === "oversize" ? "x".repeat(ACP_LIMITS.frameBytes + 1) : `${request}\n${request}\n`);
  await transport.closed; await consume;
  expect(input.destroyed).toBe(true);
});

it("counts queued bytes while the first actual output write is blocked and closes on overflow", async () => {
  const input = new PassThrough(); let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const output = new Writable({ write(_chunk, _encoding, _callback) { entered(); } });
  const transport = acpTransport(input, output); const writer = transport.stream.writable.getWriter();
  const message = { jsonrpc: "2.0" as const, method: "_agentrig/events", params: { text: "x".repeat(900_000) } };
  const pending = [writer.write(message).catch(() => {})]; await started;
  for (let i = 0; i < 5; i++) pending.push(writer.write(message).catch(() => {}));
  await transport.closed; await Promise.all(pending);
  expect(output.destroyed).toBe(true);
});
