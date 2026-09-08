import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import WebSocket from "ws";
import { type ModelEvent, type ModelRequest } from "@agentkitai/agentrig-core";
import { buildProgram } from "../src/program.js";
import { buildAgent } from "../src/agent-builder.js";
import { WEB_PROTOCOL, type serveWeb } from "../src/web.js";

export async function runtimeFixture(stream: (request: ModelRequest, signal?: AbortSignal) => AsyncIterable<ModelEvent>) {
  const root = await mkdtemp(join(tmpdir(), "agentrig-web-")); const home = join(root, "home"); await mkdir(home);
  let ready!: (s: Awaited<ReturnType<typeof serveWeb>>) => void; const started = new Promise<Awaited<ReturnType<typeof serveWeb>>>(resolve => { ready = resolve; });
  const program = buildProgram({ config: { cwd: root, home, env: {} }, web: { ready,
    build: async (options, extras) => {
      const built = await buildAgent({ ...options, ingestOnEnd: false }, extras);
      built.provider.stream = stream; return built;
    } } });
  // Provider constructor needs a fixture credential; no provider network is ever used.
  const previous = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = "local-fake-provider";
  const running = program.parseAsync(["web", "--root", join(root, "logs"), "--provider", "anthropic", "--model", "fixture", "--trust", "--no-repo-map", "--no-skill-discovery", "--no-extension-discovery"], { from: "user" });
  void running.catch(() => {});
  const server = await Promise.race([started, running.then(() => { throw Error("Web exited before ready"); })]);
  return { root, server, async close() { await server.close(); await running;
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previous;
    await rm(root, { recursive: true, force: true }); } };
}

export async function connect(server: {url: string; token: string}) {
  const socket = new WebSocket(server.url.replace("http:", "ws:") + "/acp", [WEB_PROTOCOL, `bearer.${server.token}`], { origin: server.url });
  const messages: any[] = []; const listeners = new Set<() => void>(); let id = 0;
  socket.on("message", data => { messages.push(JSON.parse(data.toString())); for (const listener of listeners) listener(); });
  socket.on("error", () => {});
  await once(socket, "open");
  const wait = (predicate: (value: any) => boolean): Promise<any> => new Promise((resolve, reject) => {
    const check = () => { const index = messages.findIndex(predicate); if (index >= 0) { cleanup(); resolve(messages.splice(index, 1)[0]); } };
    const timer = setTimeout(() => { cleanup(); reject(Error("Timed out waiting for Web ACP message")); }, 10000);
    const ended = () => { cleanup(); reject(Error("Web ACP connection closed")); };
    function cleanup() { clearTimeout(timer); listeners.delete(check); socket.off("close", ended); }
    socket.once("close", ended); listeners.add(check); check();
  });
  const send = (message: unknown) => socket.send(JSON.stringify(message));
  const request = async (method: string, params: unknown) => { const current = ++id; send({jsonrpc:"2.0",id:current,method,params}); return wait(m => m.id === current && m.method === undefined); };
  return { socket, messages, wait, send, request, async close() { if (socket.readyState === WebSocket.CLOSED) return; const done = once(socket, "close"); socket.close(); await done; } };
}
