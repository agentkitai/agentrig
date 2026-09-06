import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import type { Command } from "commander";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { startAcp, type AcpDependencies, type AcpFlags } from "./acp.js";
import { ACP_LIMITS } from "./acp-transport.js";
import { webBridge } from "./web-bridge.js";
import { webAssets } from "./web-assets.js";

export const WEB_PROTOCOL = "agentrig-acp-v1";
export const WEB_LIMITS = { sockets: 16, headers: 16384, idleMs: 5000, heartbeatMs: 15000 } as const;
const addressSchema = z.object({ host: z.literal("127.0.0.1"), port: z.number().int().min(0).max(65535) });
function header(req: IncomingMessage, name: string): string | undefined {
  const values: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i]!.toLowerCase() === name) values.push(req.rawHeaders[i + 1]!);
  return values.length === 1 ? values[0] : undefined;
}

/** One authenticated connection owns one existing ACP runtime, including its closing phase. */
export async function serveWeb(options: { host: string; port: number; run(input: Readable, output: Writable): Promise<void> }) {
  addressSchema.parse(options);
  const token = randomBytes(32).toString("base64url"); const secret = Buffer.from(token);
  const sockets = new Set<Socket>(); let authority = ""; let closing = false;
  let active: { socket: WebSocket; done: Promise<void>; close(): void } | undefined;
  let finished!: () => void; const closed = new Promise<void>(resolve => { finished = resolve; });
  const server = createServer({ maxHeaderSize: WEB_LIMITS.headers, headersTimeout: WEB_LIMITS.idleMs, requestTimeout: WEB_LIMITS.idleMs,
    connectionsCheckingInterval: 1000, keepAliveTimeout: 1000 }, (req, res) => {
    const asset = header(req, "host") === authority && (req.method === "GET" || req.method === "HEAD") ? webAssets.get(req.url ?? "") : undefined;
    res.setHeader("cache-control", "no-store"); res.setHeader("x-content-type-options", "nosniff"); res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("content-security-policy", `default-src 'none'; script-src 'self'; style-src 'self'; connect-src ws://${authority}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
    if (closing || asset === undefined) { res.writeHead(403, { connection: "close", "content-type": "text/plain" }).end("Request refused"); return; }
    res.setHeader("content-type", asset.type); res.setHeader("content-length", Buffer.byteLength(asset.body));
    res.end(req.method === "HEAD" ? undefined : asset.body);
  });
  server.on("connection", socket => {
    if (closing || sockets.size >= WEB_LIMITS.sockets) { socket.destroy(); return; }
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(WEB_LIMITS.idleMs, () => socket.destroy());
  });
  server.on("clientError", (_error, socket) => { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); });
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: ACP_LIMITS.frameBytes,
    handleProtocols: protocols => protocols.has(WEB_PROTOCOL) ? WEB_PROTOCOL : false });
  server.on("upgrade", (req, socket, head) => {
    const protocols = header(req, "sec-websocket-protocol")?.split(",").map(value => value.trim());
    const credential = protocols?.length === 2 && protocols[0] === WEB_PROTOCOL && protocols[1]?.startsWith("bearer.") ? protocols[1].slice(7) : "";
    if (closing || active !== undefined || req.method !== "GET" || req.url !== "/acp" || header(req, "host") !== authority ||
      header(req, "origin") !== `http://${authority}` || credential.length !== secret.length ||
      !/^[A-Za-z0-9_-]{43}$/.test(credential) || !timingSafeEqual(Buffer.from(credential), secret)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return;
    }
    // Synchronous handleUpgrade admission; no await permits a competing connection.
    wss.handleUpgrade(req, socket, head, ws => {
      if (socket instanceof Socket) socket.setTimeout(0);
      const bridge = webBridge(ws); let alive = true;
      ws.on("pong", () => { alive = true; });
      const heartbeat = setInterval(() => { if (!alive) { bridge.close(); return; } alive = false; ws.ping(); }, WEB_LIMITS.heartbeatMs);
      heartbeat.unref(); ws.once("close", () => clearInterval(heartbeat));
      const owner = { socket: ws, close: bridge.close, done: Promise.resolve() };
      active = owner;
      owner.done = Promise.resolve().then(() => options.run(bridge.input, bridge.output)).catch(() => { /* fixed transport refusal, never payload errors */ })
        .finally(() => { clearInterval(heartbeat); bridge.close(); if (active === owner) active = undefined; });
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port, options.host, () => { server.off("error", reject); resolve(); }); });
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("Web listener unavailable");
  authority = `127.0.0.1:${address.port}`;
  let stopping: Promise<void> | undefined;
  const close = () => stopping ??= (async () => {
    closing = true; const owner = active; owner?.close();
    const stopped = new Promise<void>(resolve => server.close(() => resolve()));
    for (const socket of sockets) socket.destroy();
    await Promise.all([stopped, owner?.done]); wss.close(); secret.fill(0); finished();
  })();
  return { url: `http://${authority}`, token, closed, close };
}

export type WebFlags = AcpFlags & { host?: string; port?: string };
export interface WebDependencies extends AcpDependencies { ready?(server: Awaited<ReturnType<typeof serveWeb>>): void }
export async function startWeb(command: Command, flags: WebFlags, dependencies: WebDependencies = {}): Promise<void> {
  if (flags.json || flags.verbose) throw new Error("Web uses ACP updates; raw-event flags are not supported");
  if (flags.port !== undefined && !/^\d{1,5}$/.test(flags.port)) throw new Error("Web port must be a decimal integer");
  const server = await serveWeb({ host: flags.host ?? "127.0.0.1", port: Number(flags.port ?? 0),
    run: (input, output) => startAcp(command, flags, { ...dependencies, input, output }) });
  const stop = () => { void server.close(); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    if (dependencies.ready !== undefined) dependencies.ready(server);
    else { console.error(`AgentRig reference web client: ${server.url}`); console.error(`Sensitive local bearer (paste into page; never share): ${server.token}`); }
    await server.closed;
  } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); await server.close(); }
}
