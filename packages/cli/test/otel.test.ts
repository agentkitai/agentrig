import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { client, ndJsonStream } from "@agentclientprotocol/sdk";
import { AnthropicProvider, type ModelEvent } from "@agentkitai/agentrig-core";
import type { TuiController } from "../src/tui/controller.js";
const harness = vi.hoisted(() => ({ exercise: undefined as undefined | ((c: TuiController) => Promise<void>) }));
vi.mock("ink", async importOriginal => ({ ...await importOriginal<typeof import("ink")>(), render: (element: { props: { controller: TuiController } }) => ({
  unmount() {}, waitUntilExit: () => harness.exercise!(element.props.controller),
}) }));
import { buildProgram } from "../src/program.js";
import { buildAgent } from "../src/agent-builder.js";
import { startTui } from "../src/tui/start.js";

const roots: string[] = []; const servers: Server[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0;
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agentrig-otel-cli-")); roots.push(root);
  const home = join(root, "home"); const cwd = join(root, "project"); await mkdir(home); await mkdir(cwd);
  const bodies: string[] = []; const server = createServer((req, res) => { let body = "";
    req.on("data", chunk => { body += chunk; }); req.on("end", () => { bodies.push(body); res.setHeader("content-type", "application/json"); res.end("{}"); }); });
  servers.push(server); await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/unchanged`;
  vi.stubEnv("ANTHROPIC_API_KEY", "SECRET_CREDENTIAL");
  vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(AnthropicProvider.prototype, "stream").mockImplementation(async function* (): AsyncIterable<ModelEvent> {
    yield { type: "text_delta", text: "SECRET_ASSISTANT" }; yield { type: "stop", reason: "end_turn" };
  });
  const opts = { root: join(root, "logs"), provider: "anthropic", model: "fixture", maxTurns: "3", maxTokensPerTurn: "100",
    repoMap: false, extensionDiscovery: false, skillDiscovery: false, otelEndpoint: endpoint };
  const spans = () => bodies.flatMap(body => JSON.parse(body).resourceSpans.flatMap((r: any) => r.scopeSpans.flatMap((s: any) => s.spans)));
  return { root, home, cwd, endpoint, bodies, opts, spans, flags: ["--otel-endpoint", endpoint, "--trust", "--no-repo-map", "--no-skill-discovery", "--no-extension-discovery"] };
}
it("actual headless command exports only with explicit flag; environment and project config cannot enable it", async () => {
  const f = await fixture();
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", f.endpoint);
  await buildProgram({ config: { cwd: f.cwd, home: f.home, env: {} } }).parseAsync(["run", "SECRET_TASK", "--headless", "--no-repo-map"], { from: "user" });
  expect(f.bodies).toHaveLength(0);
  await buildProgram({ config: { cwd: f.cwd, home: f.home, env: {} } }).parseAsync(["run", "SECRET_TASK", "--headless", ...f.flags], { from: "user" });
  expect(f.spans().filter((s: any) => s.name === "session")).toHaveLength(1);
  expect(f.spans().find((s: any) => s.name === "session").attributes).toContainEqual({ key: "agentrig.outcome", value: { stringValue: "done" } });
  expect(f.bodies.join("")).not.toContain("SECRET");
  await mkdir(join(f.cwd, ".agentrig"), { recursive: true }); await writeFile(join(f.cwd, ".agentrig/config.json"), JSON.stringify({ otelEndpoint: f.endpoint }));
  const before = f.bodies.length;
  await buildProgram({ config: { cwd: f.cwd, home: f.home, env: {} } }).parseAsync(["run", "x", "--trust", "--headless"], { from: "user" });
  expect(process.exitCode).toBe(1); expect(f.bodies.length).toBe(before);
});
it("actual builder refuses no-network even with YOLO before provider/session/network work", async () => {
  const f = await fixture();
  await expect(buildAgent({ ...f.opts, sandbox: "workspace-write", yolo: true, allow: ["net"] })).rejects.toThrow("--sandbox-network");
  expect(AnthropicProvider.prototype.stream).not.toHaveBeenCalled(); expect(f.bodies).toHaveLength(0);
  if (process.platform === "win32") await expect(buildAgent({ ...f.opts, sandbox: "workspace-write", sandboxNetwork: true })).rejects.toThrow("not supported");
  const built = await buildAgent({ ...f.opts, sandbox: process.platform === "win32" ? "none" : "workspace-write", sandboxNetwork: true });
  await built.agent.run("text only", { cwd: f.cwd }).done; await built.closeTelemetry?.();
  expect(f.bodies.length).toBeGreaterThan(0);
});
it("failed startup retains no exporter owner and closing one build leaves another usable", async () => {
  const f = await fixture();
  await expect(buildAgent({ ...f.opts, maxTurns: "0" })).rejects.toThrow(); expect(f.bodies).toHaveLength(0);
  const first = await buildAgent(f.opts); const second = await buildAgent(f.opts);
  try {
    await first.agent.run("first", { cwd: f.cwd }).done; await first.closeTelemetry?.();
    await second.agent.run("second", { cwd: f.cwd }).done;
  } finally { await first.closeTelemetry?.(); await second.closeTelemetry?.(); }
  expect(f.spans().filter((s: any) => s.name === "session")).toHaveLength(2);
  const third = await buildAgent(f.opts); await third.closeTelemetry?.(); // prior owners really released
});
it("a held collector drain cannot fail a concurrent actual session build", async () => {
  const f = await fixture(); const server = servers.at(-1)!;
  let release!: () => void; let entered!: () => void;
  const held = new Promise<void>(r => { release = r; }); const ready = new Promise<void>(r => { entered = r; });
  server.removeAllListeners("request"); let hits = 0;
  server.on("request", (req, res) => { hits++; req.resume(); req.on("end", () => { entered(); void held.then(() => {
    res.setHeader("content-type", "application/json"); res.end("{}");
  }); }); });
  const first = await buildAgent(f.opts); await first.agent.run("first", { cwd: f.cwd }).done; await ready;
  const closing = first.closeTelemetry!(); let second: Awaited<ReturnType<typeof buildAgent>> | undefined;
  try {
    second = await buildAgent(f.opts);
    expect((await second.agent.run("second during drain", { cwd: f.cwd }).done).reason).toBe("done");
    expect(hits).toBe(1); // no replacement exporter and no implicit different endpoint
    expect(vi.mocked(console.error).mock.calls.flat().join(" ")).toContain("omitted");
  } finally { release(); await closing; await second?.closeTelemetry?.(); }
});
it("existing builder failure guard closes an actual MCP child after late telemetry validation failure", async () => {
  const f = await fixture(); const script = join(f.root, "server.cjs"); const pidFile = join(f.root, "pid");
  await writeFile(script, `const fs=require('node:fs');fs.writeFileSync(process.argv[2],String(process.pid));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const req=JSON.parse(line);if(req.id===undefined)return;
 const result=req.method==='initialize'?{protocolVersion:'2024-11-05'}:{tools:[{name:'fixture',description:'fixture',inputSchema:{type:'object'}}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\\n');
});`);
  const config = join(f.root, "mcp.json"); await writeFile(config, JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [script, pidFile] } } }));
  const opts = { ...f.opts, mcpConfig: config }; let changed = false; let pid: number | undefined;
  let built: Awaited<ReturnType<typeof buildAgent>> | undefined;
  try {
    await expect(buildAgent(opts, { mcpPinRoot: join(f.root, "pins"), onNotice: message => {
      if (message.includes("pinned first-use")) {
        changed = true; opts.otelEndpoint = "file:///invalid"; // trusted callback forces a post-start assembly failure
      }
    } }).then(value => { built = value; })).rejects.toThrow("invalid OTLP endpoint");
    pid = Number(await readFile(pidFile, "utf8"));
    expect(changed).toBe(true); expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid!, 0)).toThrow(); // enclosing assemble catch already joined MCP cleanup
  } finally {
    await Promise.allSettled((built?.mcp ?? []).map(c => c.close())); await built?.closeTelemetry?.();
    if (pid !== undefined) { try { process.kill(pid, "SIGTERM"); } catch { /* owned child already gone */ } }
  }
}, 30000);
it("actual TUI startup and child run share telemetry without ending the parent sink early", async () => {
  const f = await fixture(); let rootTurns = 0;
  vi.mocked(AnthropicProvider.prototype.stream).mockImplementation(async function* (req): AsyncIterable<ModelEvent> {
    const child = JSON.stringify(req.messages).includes("CHILD_MARKER");
    if (!child && rootTurns++ === 0) { yield { type: "tool_use", id: "spawn", name: "subagent", input: { task: "CHILD_MARKER" } }; yield { type: "stop", reason: "tool_use" }; }
    else yield { type: "stop", reason: "end_turn" };
  });
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY"); Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  harness.exercise = async c => { await c.submit("parent"); await c.submit("continue"); };
  try { await startTui({ ...f.opts, subagents: true, allow: ["subagent"] }); }
  finally { if (descriptor === undefined) Reflect.deleteProperty(process.stdin, "isTTY"); else Object.defineProperty(process.stdin, "isTTY", descriptor); }
  const sessions = f.spans().filter((s: any) => s.name === "session"); expect(sessions.length).toBeGreaterThanOrEqual(3);
  expect(new Set(sessions.map((s: any) => s.traceId)).size).toBe(2); // root resume shares identity, child has its own
  expect(f.bodies.join("")).not.toContain("CHILD_MARKER");
});
it("actual ACP session prompt exports and joins on close", async () => {
  const f = await fixture(); const input = new PassThrough(); const output = new PassThrough();
  const running = buildProgram({ config: { cwd: f.cwd, home: f.home, env: {} }, acp: { input, output } }).parseAsync(["acp", ...f.flags], { from: "user" });
  const peer = client().connect(ndJsonStream(Writable.toWeb(input), Readable.toWeb(output)));
  try {
    await peer.agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const session = await peer.agent.request("session/new", { cwd: f.cwd, mcpServers: [] });
    await peer.agent.request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "SECRET_ACP" }] });
  } finally { peer.close(); input.destroy(); output.destroy(); await running; }
  expect(f.spans().some((s: any) => s.name === "session")).toBe(true); expect(f.bodies.join("")).not.toContain("SECRET");
});
it("actual MCP serving task exports while advisory input grants no additional authority", async () => {
  const f = await fixture(); const input = new PassThrough(); const output = new PassThrough(); let buffer = "";
  const replies = new Map<number, (value: any) => void>(); output.on("data", chunk => { buffer += chunk; let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) { const reply = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); replies.get(reply.id)?.(reply); } });
  const request = (id: number, method: string, params: unknown) => new Promise<any>(resolve => { replies.set(id, resolve); input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  const running = buildProgram({ config: { cwd: f.cwd, home: f.home, env: {} }, mcpServe: { input, output } }).parseAsync(["mcp-serve", ...f.flags], { from: "user" });
  try {
    expect(await request(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fixture", version: "1" } })).toHaveProperty("result");
    input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const reply = await request(2, "tools/call", { name: "run_task", arguments: { task: "SECRET_MCP" } });
    expect(reply.result.isError).not.toBe(true);
  } finally { input.end(); await running; output.destroy(); }
  expect(f.spans().some((s: any) => s.name === "session")).toBe(true); expect(f.bodies.join("")).not.toContain("SECRET");
});
