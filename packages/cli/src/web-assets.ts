// Fixed application assets, never filesystem paths or interpolated launch credentials.
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentRig reference client</title><link rel="stylesheet" href="/app.css"><script defer src="/app.js"></script></head><body><main>
<h1>AgentRig reference client</h1><p>Local operator access. Authentication does not grant project trust or tool permission. Treat replies as untrusted text.</p>
<label>Local bearer <input id="token" type="password" autocomplete="off" maxlength="43"></label><button id="connect">Connect</button><button id="disconnect" disabled>Disconnect</button>
<p id="status" role="status">Disconnected</p><label>Absolute project directory <input id="cwd" maxlength="4096" autocomplete="off"></label>
<label>Task <textarea id="task" maxlength="16000" rows="4"></textarea></label><button id="send" disabled>Send task</button><button id="cancel" disabled>Cancel task</button>
<section id="approval" aria-label="Pending approval"></section><p id="omitted" role="status"></p><section id="transcript" aria-label="Transcript" aria-live="polite"></section>
</main></body></html>`;
const css = `body{font:16px system-ui,sans-serif;color:#20252c;background:#f4f5f7;margin:0}main{max-width:850px;margin:2rem auto;padding:1.5rem;background:white;border:1px solid #d4d9e0;border-radius:8px}label{display:block;margin:.8rem 0}input,textarea{display:block;box-sizing:border-box;width:100%;font:inherit;padding:.5rem}button{font:inherit;padding:.5rem .8rem;margin:.3rem .3rem .3rem 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;border-bottom:1px solid #ddd;padding:.5rem}#approval{background:#fff4d6;padding:.5rem}#approval:empty{display:none}#status,#omitted{font-weight:600}`;
const js = String.raw`"use strict";
(() => {
  const el = id => document.getElementById(id), encoder = new TextEncoder();
  let socket, session, busy = false, nextId = 0, displayBytes = 0;
  const pending = new Map(), approvals = new Map();
  function status(text) { el("status").textContent = text; }
  function append(text) {
    const node = document.createElement("pre"); node.textContent = String(text).slice(0, 262144);
    const bytes = encoder.encode(node.textContent).length; node.dataset.bytes = String(bytes);
    displayBytes += bytes; el("transcript").append(node);
    while (displayBytes > 1048576 || el("transcript").childElementCount > 1000) {
      const first = el("transcript").firstElementChild; displayBytes -= Number(first.dataset.bytes); first.remove();
      el("omitted").textContent = "Older display entries omitted; stored session logs are unchanged.";
    }
  }
  function send(message) {
    const wire = JSON.stringify(message);
    if (!socket || socket.readyState !== WebSocket.OPEN || encoder.encode(wire).length > 1048576 || socket.bufferedAmount + encoder.encode(wire).length > 1048576) throw Error("Connection unavailable or full");
    socket.send(wire);
  }
  function request(method, params) {
    if (pending.size >= 16) return Promise.reject(Error("Request capacity exceeded"));
    const id = ++nextId;
    return new Promise((resolve, reject) => { pending.set(id, {resolve,reject}); try { send({jsonrpc:"2.0",id,method,params}); } catch (error) { pending.delete(id); reject(error); } });
  }
  function clearApprovals() { for (const item of approvals.values()) item.node.remove(); approvals.clear(); }
  function renderApproval(message) {
    if (approvals.size >= 8 || approvals.has(message.id)) throw Error("Approval capacity exceeded");
    const node = document.createElement("div"), heading = document.createElement("pre"); node.append(heading);
    approvals.set(message.id, {node}); el("approval").append(node);
    const answer = result => {
      if (!approvals.has(message.id)) return;
      send({jsonrpc:"2.0",id:message.id,result}); approvals.delete(message.id); node.remove();
    };
    const button = (text, action) => { const b = document.createElement("button"); b.textContent = text; b.addEventListener("click", () => { try { action(); } catch { socket.close(); } }); node.append(b); };
    const p = message.params;
    if (p.sessionId !== session) throw Error("Unknown session approval");
    if (message.method === "session/request_permission") {
      heading.textContent = String(p.toolCall.title || "Permission") + "\n" + (p.toolCall.content || []).map(c => c.type === "content" && c.content.type === "text" ? c.content.text : "").join("\n");
      if (!Array.isArray(p.options) || p.options.length > 8) throw Error("Invalid permission options");
      for (const option of p.options) if (option.kind === "allow_once" || option.kind === "reject_once") button(option.name, () => answer({outcome:{outcome:"selected",optionId:option.optionId}}));
    } else {
      if (p.version !== 1 || !p.question || !Array.isArray(p.question.options) || p.question.options.length < 2 || p.question.options.length > 4) throw Error("Invalid question");
      heading.textContent = p.question.prompt;
      p.question.options.forEach((option,index) => button(option, () => answer({id:p.question.id,reply:{source:"human",answer:{option:index}}})));
      const text = document.createElement("input"); text.maxLength = 4096; text.setAttribute("aria-label", "Free-text answer"); node.append(text);
      button("Submit answer", () => { if (text.value.trim()) answer({id:p.question.id,reply:{source:"human",answer:{text:text.value}}}); });
    }
  }
  function receive(event) {
    try {
      if (typeof event.data !== "string" || encoder.encode(event.data).length > 1048576) throw Error("Invalid frame");
      const m = JSON.parse(event.data);
      if (!m || m.jsonrpc !== "2.0") throw Error("Invalid ACP message");
      if (m.method === "session/request_permission" || m.method === "_agentrig/question") { renderApproval(m); return; }
      if (m.method === "session/update") {
        const update = m.params.update;
        if (m.params.sessionId !== session) throw Error("Unknown session update");
        if (update.content && update.content.type === "text") append(update.content.text);
        else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
          append((update.title || "Tool") + ": " + (update.status || "update"));
          for (const c of update.content || []) if (c.type === "content" && c.content.type === "text") append(c.content.text);
        }
        return;
      }
      if (m.method === "$/cancel_request") { const item = approvals.get(m.params.requestId); if (item) { item.node.remove(); approvals.delete(m.params.requestId); } return; }
      if (m.method !== undefined) throw Error("Unsupported server request");
      const waiting = pending.get(m.id); if (!waiting) throw Error("Unmatched response");
      pending.delete(m.id); if (m.error) waiting.reject(Error("ACP request refused; check operator configuration")); else waiting.resolve(m.result);
    } catch { status("Protocol refused; disconnected"); socket.close(); }
  }
  el("connect").addEventListener("click", () => {
    if (socket && socket.readyState !== WebSocket.CLOSED) return;
    const token = el("token").value; if (!/^[A-Za-z0-9_-]{43}$/.test(token)) { status("Paste the operator's local bearer"); return; }
    el("token").value = ""; session = undefined; el("connect").disabled = true; status("Connecting");
    socket = new WebSocket("ws://" + location.host + "/acp", ["agentrig-acp-v1", "bearer." + token]);
    socket.addEventListener("message", receive);
    socket.addEventListener("open", async () => {
      try { await request("initialize", {protocolVersion:1,clientCapabilities:{},clientInfo:{name:"agentrig-reference-web",version:"1"},_meta:{agentrig:{questions:1}}});
        status("Connected"); el("send").disabled = false; el("disconnect").disabled = false;
      } catch { status("Initialization refused"); socket.close(); }
    });
    socket.addEventListener("close", () => {
      for (const entry of pending.values()) entry.reject(Error("Disconnected")); pending.clear(); clearApprovals(); session = undefined; busy = false;
      el("connect").disabled = false; el("send").disabled = true; el("cancel").disabled = true; el("disconnect").disabled = true; status("Disconnected; server cleanup may still be joining");
    });
    socket.addEventListener("error", () => status("Connection refused; verify local bearer and operator state"));
  });
  el("disconnect").addEventListener("click", () => socket.close());
  el("send").addEventListener("click", async () => {
    if (busy || !el("task").value.trim()) return; busy = true; el("send").disabled = true; status("Running");
    try {
      if (!session) session = (await request("session/new", {cwd:el("cwd").value,mcpServers:[]})).sessionId;
      el("cancel").disabled = false;
      const result = await request("session/prompt", {sessionId:session,prompt:[{type:"text",text:el("task").value}]});
      status("Finished: " + String(result.stopReason));
    } catch (error) { status(error.message); }
    finally { busy = false; clearApprovals(); el("cancel").disabled = true; el("send").disabled = !socket || socket.readyState !== WebSocket.OPEN; }
  });
  el("cancel").addEventListener("click", () => {
    if (!busy || !session) return;
    try { send({jsonrpc:"2.0",method:"session/cancel",params:{sessionId:session}}); status("Cancelling; waiting for runtime settlement");
      for (const id of approvals.keys()) send({jsonrpc:"2.0",id,error:{code:-32800,message:"User cancelled"}}); clearApprovals(); el("cancel").disabled = true;
    } catch { socket.close(); }
  });
})();`;
export const webAssets = new Map([
  ["/", { type: "text/html; charset=utf-8", body: html }],
  ["/app.js", { type: "text/javascript; charset=utf-8", body: js }],
  ["/app.css", { type: "text/css; charset=utf-8", body: css }],
]);
