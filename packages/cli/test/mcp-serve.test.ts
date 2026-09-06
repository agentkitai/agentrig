import { PassThrough, Writable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { Client, type Transport, type JSONRPCMessage } from "@modelcontextprotocol/client";
import { BoundedMcpTransport, MCP_SERVE_LIMITS } from "../src/mcp-serve-transport.js";
import { serveMcp, type McpServeRuntime } from "../src/mcp-serve-server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const runtime = (): McpServeRuntime => ({ run: async input => ({ task: input.task }), list: async () => [], read: async id => ({ id }), memory: async query => ({ query }), close: async () => {} });
async function peer(rt = runtime()) {
  const input = new PassThrough(); const output = new PassThrough();
  const sent: JSONRPCMessage[] = [];
  const transport = new BoundedMcpTransport(input, output); const server = serveMcp(transport, rt);
  let text = "";
  const clientTransport: Transport = {
    async start() { output.on("data", chunk => { text += String(chunk); let newline;
      while ((newline = text.indexOf("\n")) >= 0) { const frame = text.slice(0, newline); text = text.slice(newline + 1); clientTransport.onmessage?.(JSON.parse(frame) as JSONRPCMessage); } }); },
    async send(message) { sent.push(message); input.write(JSON.stringify(message) + "\n"); },
    async close() { input.end(); clientTransport.onclose?.(); },
  };
  const client = new Client({ name: "fixture", version: "1" }, { versionNegotiation: { mode: "auto" } });
  cleanups.push(async () => { await client.close(); await server.close(); });
  await client.connect(clientTransport);
  return { client, input, output, transport, server, sent };
}

it("official modern client discovers exactly four tools and calls the same registered runtime", async () => {
  const rt = runtime(); rt.run = vi.fn(rt.run);
  const f = await peer(rt);
  expect(f.client.getProtocolEra()).toBe("modern");
  const list = await f.client.listTools();
  expect(list.tools.map(tool => tool.name)).toEqual(["run_task", "list_sessions", "read_session", "memory_search"]);
  const result = await f.client.callTool({ name: "run_task", arguments: { task: "/new literal" } });
  expect(JSON.stringify(result)).toContain("/new literal"); expect(rt.run).toHaveBeenCalledOnce();
  await expect(f.client.callTool({ name: "run_task", arguments: { task: "x", yolo: true } })).rejects.toThrow("MCP request refused");
  expect(rt.run).toHaveBeenCalledOnce();
  await expect(f.client.callTool({ name: "SECRET_UNKNOWN_TOOL", arguments: {} })).rejects.toThrow("MCP request refused");
  await expect(f.client.callTool({ name: "run_task", arguments: { task: "x", SECRET_UNKNOWN_KEY: true } })).rejects.toThrow("MCP request refused");
});

it("EOF aborts and joins owned handler cleanup before server done resolves", async () => {
  let release!: () => void; let entered!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let cancelled = false; let closed = false;
  const rt = runtime();
  rt.run = async (_input, signal) => { signal.addEventListener("abort", () => { cancelled = true; }, { once: true }); entered(); await barrier; return "done"; };
  rt.close = async () => { closed = true; };
  const f = await peer(rt); cleanups.push(async () => { release(); });
  const call = f.client.callTool({ name: "run_task", arguments: { task: "held" } }).catch(() => undefined);
  await started; f.input.end();
  await vi.waitFor(() => expect(cancelled).toBe(true));
  expect(closed).toBe(false);
  release(); await f.server.done; expect(closed).toBe(true);
  await f.client.close(); await call;
});

it("cancel holds the actual task slot until handler cleanup settles and emits no late answer", async () => {
  let release!: () => void; let started!: () => void; let cancelled!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const sawCancel = new Promise<void>(resolve => { cancelled = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const rt = runtime(); rt.run = async (_input, signal) => { signal.addEventListener("abort", cancelled, { once: true }); started(); await barrier; return "done"; };
  const f = await peer(rt); const abort = new AbortController();
  cleanups.push(async () => { release(); });
  const request = f.client.callTool({ name: "run_task", arguments: { task: "held" } }, { signal: abort.signal }).catch(() => undefined);
  await entered; abort.abort();
  let saw = false; void sawCancel.then(() => { saw = true; });
  await vi.waitFor(() => expect(saw, `pending=${f.transport.pending} sent=${JSON.stringify(f.sent)}`).toBe(true));
  expect(f.transport.pending).toBe(1);
  const busy = await f.client.callTool({ name: "run_task", arguments: { task: "second" } });
  expect(busy.isError).toBe(true); await vi.waitFor(() => expect(f.transport.pending).toBe(1));
  release(); await request; await vi.waitFor(() => expect(f.transport.pending).toBe(0));
  expect((await f.client.listTools()).tools).toHaveLength(4);
});

it("actual SDK unknown/schema responses keep pre-delivery slots while physical stdout is blocked", async () => {
  const input = new PassThrough(); const writes: Array<(error?: Error | null) => void> = [];
  const output = new Writable({ write(_chunk, _encoding, callback) { writes.push(callback); } });
  const transport = new BoundedMcpTransport(input, output); const server = serveMcp(transport, runtime());
  cleanups.push(async () => { await server.close(); output.destroy(); });
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } }) + "\n");
  await vi.waitFor(() => expect(writes).toHaveLength(1)); writes.shift()!();
  await vi.waitFor(() => expect(transport.pending).toBe(0));
  for (let id = 1; id <= 16; id++) input.write(JSON.stringify({ jsonrpc: "2.0", id, method: id % 2 ? "SECRET-UNKNOWN" : "tools/call", params: id % 2 ? {} : { name: 7 } }) + "\n");
  await vi.waitFor(() => expect(writes.length).toBe(1));
  expect(transport.pending).toBe(16); expect(transport.reservedBytes).toBe(MCP_SERVE_LIMITS.output);
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 17, method: "tools/list" }) + "\n");
  expect(transport.pending).toBe(0);
  await transport.closed; expect(transport.pending).toBe(0);
});

it.each(["[{}]\n", "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}\n{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}\n", "x".repeat(MCP_SERVE_LIMITS.frame + 1)])("rejects malformed, duplicate or oversized input before unbounded dispatch (%#)", async frame => {
  const input = new PassThrough(); const output = new PassThrough(); const transport = new BoundedMcpTransport(input, output);
  await transport.start(); input.write(frame); await transport.closed;
  expect(transport.pending).toBe(0);
});
