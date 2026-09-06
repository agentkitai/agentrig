import { request as httpRequest, Server as HttpServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import WebSocket from "ws";
import { serveWeb, WEB_PROTOCOL } from "../src/web.js";
import { connect, runtimeFixture } from "./web-fixture.js";
import { acpTransport } from "../src/acp-transport.js";

async function refused(server: {url: string; token: string}, options: { origin?: string; token?: string; host?: string } = {}) {
  return new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(server.url.replace("http:", "ws:") + "/acp", [WEB_PROTOCOL, `bearer.${options.token ?? server.token}`], {
      ...(options.origin === undefined ? {} : { origin: options.origin }), ...(options.host === undefined ? {} : { headers: { host: options.host } }) });
    ws.on("unexpected-response", (req, res) => { const status = res.statusCode!; res.resume(); req.destroy(); resolve(status); });
    ws.on("error", () => {}); ws.on("open", () => { ws.terminate(); reject(Error("Untrusted connection accepted")); });
  });
}
it.each(["0.0.0.0", "localhost", "::1", "127.0.0.2", "example.test"])("refuses nonliteral bind %s before runtime", async host => {
  await expect(serveWeb({ host, port: 0, run: async () => { throw Error("must not start"); } })).rejects.toThrow();
});
it("requires bearer AND exact Origin/Host before creating ACP; fixed assets contain no secret", async () => {
  let runs = 0; const server = await serveWeb({ host: "127.0.0.1", port: 0, run: async () => { runs++; } });
  try {
    for (const origin of [undefined, "null", "https://evil.example", server.url + "/"]) expect(await refused(server, {origin})).toBe(403);
    expect(await refused(server, {origin:server.url,token:"A".repeat(43)})).toBe(403);
    expect(await refused(server, {origin:server.url,host:"evil.example"})).toBe(403);
    expect(runs).toBe(0);
    const response = await fetch(server.url); expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await response.text(); expect(html).not.toContain(server.token); expect(html).toContain("/app.js");
    for (const path of ["/../secret", "/app.js?token=x", "/.agentrig/config.json"]) expect((await fetch(server.url + path)).status).toBe(403);
    const duplicate = await new Promise<number>(resolve => { const req = httpRequest(server.url, { headers: ["Host", new URL(server.url).host, "Host", "evil.example"] }, res => { res.resume(); resolve(res.statusCode!); }); req.end(); });
    expect(duplicate).toBe(403); expect(runs).toBe(0);
  } finally { await server.close(); }
});
it("canonical default-port Host/Origin works without accepting explicit noncanonical port spelling", async () => {
  // Inject only the advertised bound port; real HTTP/WS still use an unprivileged
  // listener, so the port-80 browser normalization contract is portable in CI.
  const original = HttpServer.prototype.address; let port = 0;
  const spy = vi.spyOn(HttpServer.prototype,"address").mockImplementation(function(this: HttpServer) {
    const address = original.call(this); if (address && typeof address !== "string") { port = address.port; return {...address,port:80}; } return address;
  });
  const server = await serveWeb({host:"127.0.0.1",port:0,run:async input => { for await (const _ of input) { /* owned lifetime */ } }});
  spy.mockRestore();
  const actual = `http://127.0.0.1:${port}`;
  const get = (host:string) => new Promise<number>(resolve => { const req = httpRequest(actual,{headers:{host}},res=>{res.resume();resolve(res.statusCode!);}); req.end(); });
  try {
    expect(await get("127.0.0.1")).toBe(200); expect(server.url).toBe("http://127.0.0.1");
    expect(await get("127.0.0.1:80")).toBe(403);
    const socket = new WebSocket(actual.replace("http:","ws:")+"/acp",[WEB_PROTOCOL,`bearer.${server.token}`],{origin:server.url,headers:{host:"127.0.0.1"}});
    await once(socket,"open"); expect(socket.protocol).toBe(WEB_PROTOCOL); const closed=once(socket,"close"); socket.close(); await closed;
  } finally { spy.mockRestore(); await server.close(); }
});
it("holds the exclusive connection slot through runtime join after overflow/close", async () => {
  let release!: () => void; const held = new Promise<void>(r => { release = r; }); let runs = 0;
  const server = await serveWeb({host:"127.0.0.1",port:0,run:async () => { runs++; await held; }});
  try {
    const client = await connect(server); expect(client.socket.protocol).toBe(WEB_PROTOCOL);
    const closed = once(client.socket, "close");
    client.socket.send("x".repeat(600000)); client.socket.send("y".repeat(600000)); await closed;
    expect(runs).toBe(1); expect(await refused(server, {origin:server.url})).toBe(403);
  } finally { release(); await server.close(); }
});
it("authenticated actual ACP remains usable after seven seconds idle beyond HTTP deadlines", async () => {
  const f = await runtimeFixture(async function* () { yield {type:"text_delta",text:"Still connected"}; yield {type:"stop",reason:"end_turn"}; });
  const c = await connect(f.server);
  try {
    await c.request("initialize",{protocolVersion:1,clientCapabilities:{}});
    const sessionId = (await c.request("session/new",{cwd:f.root,mcpServers:[]})).result.sessionId;
    // Real Node HTTP/socket timers, not a fake clock that would miss upgraded parser behavior.
    await new Promise<void>(resolve => setTimeout(resolve,7000));
    expect(c.socket.readyState).toBe(WebSocket.OPEN);
    const response = await c.request("session/prompt",{sessionId,prompt:[{type:"text",text:"Reply after idle"}]});
    expect(response.result.stopReason).toBe("end_turn"); expect(JSON.stringify(c.messages)).toContain("Still connected");
  } finally { await c.close(); await f.close(); }
}, 15000);
it("tiny-frame count limit refuses at 1025 messages independently of byte capacity", async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const server = await serveWeb({host:"127.0.0.1",port:0,run:async () => { await held; }});
  try {
    const c = await connect(server);
    const observed = new Promise<string>(resolve => { c.socket.once("close",()=>resolve("closed")); c.socket.once("pong",()=>resolve("pong")); });
    for (let n = 0; n < 1025; n++) c.socket.send("{}");
    // The ping follows every frame on the same connection; a pong proves the receiver
    // processed the whole flood without closing, avoiding a timing-only negative oracle.
    c.socket.ping(); expect(await observed).toBe("closed");
  } finally { release(); await server.close(); }
});
it.each(["binary", "newline", "oversize"])("refuses %s frames and joins the connection", async mode => {
  const server = await serveWeb({host:"127.0.0.1",port:0,run:async (input) => { for await (const _ of input) { /* consume */ } }});
  try { const client = await connect(server); const closed = once(client.socket, "close");
    client.socket.send(mode === "binary" ? Buffer.from("{}") : mode === "newline" ? "{}\n{}" : "x".repeat(1048577)); await closed;
  } finally { await server.close(); }
});
it("bounds queued output before Node/WS enqueue against a paused real peer", async () => {
  let refusal!: () => void; const refusedWrite = new Promise<void>(r => { refusal = r; });
  let admitted!: () => void; const admission = new Promise<void>(r => { admitted = r; });
  let callbacks = 0; let writes = 0; let maxBuffered = 0;
  const server = await serveWeb({host:"127.0.0.1",port:0,run:async (input, output) => {
    for await (const _ of input) {
      const frame = JSON.stringify({jsonrpc:"2.0",method:"session/update",params:{text:"x".repeat(900000)}}) + "\n";
      for (let n = 0; n < 6; n++) {
        writes++; output.write(frame, error => { callbacks++; if (error?.message === "Web ACP output capacity exceeded") refusal(); });
        maxBuffered = Math.max(maxBuffered, output.writableLength);
      }
      admitted();
      break;
    }
  }});
  try {
    const client = await connect(server); client.socket.pause();
    client.send({jsonrpc:"2.0",id:1,method:"initialize",params:{}});
    await admission; expect(maxBuffered).toBeLessThanOrEqual(4194304); expect(writes).toBe(6); await refusedWrite;
    client.socket.resume(); await client.close(); await server.close();
    expect(callbacks).toBe(writes);
  } finally { await server.close(); }
});
it("releases a failed-startup connection only after its runtime settles", async () => {
  let runs = 0;
  const server = await serveWeb({host:"127.0.0.1",port:0,run:async () => { runs++; throw Error("private startup failure"); }});
  try {
    for (let n = 0; n < 2; n++) { const c = await connect(server); if (c.socket.readyState !== WebSocket.CLOSED) await once(c.socket,"close"); }
    expect(runs).toBe(2);
  } finally { await server.close(); }
});
it("retains actual ACP response reservation until the public WS write callback settles", async () => {
  let release!: () => void; let written!: () => void;
  const callbackReached = new Promise<void>(r => { written = r; });
  let transport: ReturnType<typeof acpTransport> | undefined; let responseDone = false;
  const original = WebSocket.prototype.send;
  const spy = vi.spyOn(WebSocket.prototype,"send").mockImplementation(function(this: WebSocket, data: any, options: any, callback?: any) {
    if (options?.compress === false && callback) return original.call(this,data,options,(error?: Error) => {
      release = () => callback(error); written();
    });
    return original.call(this,data,options,callback);
  });
  const server = await serveWeb({host:"127.0.0.1",port:0,run:async (input,output) => {
    transport = acpTransport(input,output);
    const request = await transport.stream.readable.getReader().read();
    const message = request.value as {id:number};
    await transport.stream.writable.getWriter().write({jsonrpc:"2.0",id:message.id,result:{protocolVersion:1,agentCapabilities:{}}});
    responseDone = true;
  }});
  try {
    const c = await connect(server);
    const response = c.request("initialize",{protocolVersion:1,clientCapabilities:{}});
    await callbackReached; await response; // peer receipt alone does not release our callback ledger
    expect(responseDone).toBe(false); expect(transport!.reservedBytes).toBe(131072);
    release(); await server.close(); expect(responseDone).toBe(true); expect(transport!.reservedBytes).toBe(0);
    await c.close();
  } finally { release?.(); spy.mockRestore(); await server.close(); }
});
it("actual Web ACP permits one explicit write, asks a structured question and streams literal output", async () => {
  let turn = 0;
  const f = await runtimeFixture(async function* () {
    if (++turn === 1) { yield {type:"tool_use",id:"write",name:"write_file",input:{path:"sentinel",content:"approved"}}; yield {type:"stop",reason:"tool_use"}; }
    else if (turn === 2) { yield {type:"tool_use",id:"question",name:"ask_user",input:{prompt:"Choose direction",options:["Left","Right"]}}; yield {type:"stop",reason:"tool_use"}; }
    else { yield {type:"text_delta",text:"<script>untrusted</script> streamed"}; yield {type:"stop",reason:"end_turn"}; }
  });
  const c = await connect(f.server);
  try {
    expect((await c.request("initialize", {protocolVersion:1,clientCapabilities:{},_meta:{agentrig:{questions:1}}})).error).toBeUndefined();
    const sessionId = (await c.request("session/new", {cwd:f.root,mcpServers:[]})).result.sessionId;
    const prompt = c.request("session/prompt", {sessionId,prompt:[{type:"text",text:"Create the requested file and ask me a question"}]});
    const permission = await c.wait(m => m.method === "session/request_permission");
    await expect(readFile(join(f.root,"sentinel"))).rejects.toThrow();
    c.send({jsonrpc:"2.0",id:permission.id,result:{outcome:{outcome:"selected",optionId:"allow"}}});
    const question = await c.wait(m => m.method === "_agentrig/question");
    c.send({jsonrpc:"2.0",id:question.id,result:{id:question.params.question.id,reply:{source:"human",answer:{option:1}}}});
    expect((await prompt).result.stopReason).toBe("end_turn"); expect(await readFile(join(f.root,"sentinel"),"utf8")).toBe("approved");
    expect(JSON.stringify(c.messages)).toContain("<script>untrusted</script> streamed");
  } finally { await c.close(); await f.close(); }
}, 20000);
it("actual Web ACP deny and disconnect cannot authorize pending writes", async () => {
  let turn = 0;
  const f = await runtimeFixture(async function* () {
    if (++turn % 2 === 1) { yield {type:"tool_use",id:"write",name:"write_file",input:{path:"refused",content:"no"}}; yield {type:"stop",reason:"tool_use"}; }
    else yield {type:"stop",reason:"end_turn"};
  });
  const c = await connect(f.server);
  try {
    await c.request("initialize",{protocolVersion:1,clientCapabilities:{}});
    const sessionId = (await c.request("session/new",{cwd:f.root,mcpServers:[]})).result.sessionId;
    const prompt = c.request("session/prompt",{sessionId,prompt:[{type:"text",text:"Create a file"}]});
    const ask = await c.wait(m=>m.method==="session/request_permission");
    c.send({jsonrpc:"2.0",id:ask.id,result:{outcome:{outcome:"selected",optionId:"deny"}}}); await prompt;
    const second = c.request("session/prompt",{sessionId,prompt:[{type:"text",text:"Create another file"}]}).catch(()=>{});
    await c.wait(m=>m.method==="session/request_permission"); await c.close(); await f.server.close();
    await expect(readFile(join(f.root,"refused"))).rejects.toThrow(); void second;
  } finally { await c.close(); await f.close(); }
}, 20000);
