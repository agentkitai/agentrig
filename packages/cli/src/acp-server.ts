import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { agent, RequestError, type AgentConnection, type NewSessionRequest, type RequestPermissionRequest, type SessionUpdate, type Stream } from "@agentclientprotocol/sdk";
import type { Session, SessionSummary } from "@agentkitai/agentrig-core";
import { TuiController, type PendingPermission } from "./tui/controller.js";
import { permissionEffectLines } from "./tui/permission-prompt.js";
import { ACP_LIMITS, ACP_SESSION_REFUSAL } from "./acp-transport.js";
import { AcpSessionParams, AcpEventsParams, AcpMemoryParams, acpResult } from "./acp-preflight.js";

export interface AcpSessionRuntime {
  controller: TuiController;
  close(): Promise<void>;
  /** Bounded local read-only search/list; no arbitrary client-selected filesystem path. */
  memory?(query: string): Promise<string[]>;
}
export interface AcpServerOptions {
  createSession(request: NewSessionRequest, observe: (session: Session) => void): Promise<AcpSessionRuntime>;
  closeTransport(): void;
  reserveOutput(bytes: number): () => void;
}
interface Entry {
  runtime?: AcpSessionRuntime;
  creating?: Promise<AcpSessionRuntime>;
  busy: boolean;
  raw: boolean;
  turn: number;
  approval: number;
  cancelled: boolean;
  controller: AbortController;
  observing: Promise<void>;
  summary?: SessionSummary;
  stop?: string;
  unsubscribe?: () => void;
  permissionTasks: Set<Promise<void>>;
}
const bounded = (value: string) => value.length > 24_000 ? `${value.slice(0, 24_000)}\n[truncated]` : value;
async function untilAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(new Error("permission cancelled"));
    signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); });
  try { return await Promise.race([work, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

/** Stable ACP v1 mapping over the same headless controller, not a second agent loop. */
export function serveAcp(stream: Stream, options: AcpServerOptions) {
  let initialized = false; let closing = false; let connection: AgentConnection;
  const sessions = new Map<string, Entry>();
  const outstanding = new Set<Promise<void>>();
  const asks = new WeakSet<PendingPermission>();
  function fail(): void { options.closeTransport(); connection?.close(); }
  function send(method: string, params: unknown): Promise<void> {
    if (closing || outstanding.size >= 256) { fail(); return Promise.reject(new Error("ACP output unavailable")); }
    let release: () => void;
    try { release = options.reserveOutput(Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", method, params })) + 64); }
    catch { fail(); return Promise.reject(new Error("ACP output unavailable")); }
    // SDK notify resolves only after its serialized writer finishes the physical write.
    const work = connection.client.notify(method, params).finally(release);
    outstanding.add(work);
    void work.then(() => outstanding.delete(work), () => { outstanding.delete(work); fail(); });
    return work;
  }
  const update = (sessionId: string, update: SessionUpdate) => send("session/update", { sessionId, update });
  function current(id: string): Entry & { runtime: AcpSessionRuntime } {
    const entry = sessions.get(id);
    if (!initialized || closing || entry?.runtime === undefined) throw RequestError.invalidParams();
    return entry as Entry & { runtime: AcpSessionRuntime };
  }
  async function observe(sessionId: string, entry: Entry, session: Session): Promise<void> {
    const turn = entry.turn;
    const toolId = (id: string) => `${turn}:${id}`;
    for await (const event of session.events) {
      if (closing) continue;
      let payload: SessionUpdate | undefined;
      if (event.type === "model.delta") payload = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.text } };
      if (event.type === "model.response") entry.stop = event.stop;
      if (event.type === "tool.call") payload = { sessionUpdate: "tool_call", toolCallId: toolId(event.id), title: event.name,
        kind: "other", status: "in_progress", rawInput: event.input };
      if (event.type === "tool.result") payload = { sessionUpdate: "tool_call_update", toolCallId: toolId(event.id), status: event.ok ? "completed" : "failed",
        content: [{ type: "content", content: { type: "text", text: bounded(event.display) } }] };
      if (payload !== undefined) void update(sessionId, payload).catch(() => {});
      if (entry.raw) {
        const originalBytes = Buffer.byteLength(JSON.stringify(event));
        const payload = originalBytes > 262_144
          ? { version: 1, sessionId, omitted: true, eventType: event.type, seq: event.seq, originalBytes }
          : { version: 1, sessionId, event };
        void send("_agentrig/event", payload).catch(() => {});
      }
    }
    entry.summary = await session.done;
    await Promise.allSettled([...outstanding]);
  }
  function permission(sessionId: string, entry: Entry, pending: PendingPermission): void {
    if (asks.has(pending)) return; asks.add(pending);
    const toolCallId = `${entry.turn}:approval:${++entry.approval}`;
    const text = bounded(permissionEffectLines(pending.req).join("\n"));
    const signal = entry.controller.signal;
    const task = (async () => {
      let decision: "allow" | "deny" = "deny";
      try {
        await update(sessionId, { sessionUpdate: "tool_call", toolCallId, title: `Approval: ${pending.req.tool}`, kind: "other", status: "pending",
          content: [{ type: "content", content: { type: "text", text } }] });
        const request: RequestPermissionRequest = acpResult({ sessionId,
          toolCall: { toolCallId, title: `Approval: ${pending.req.tool}`, kind: "other" as const, status: "pending" as const,
            content: [{ type: "content" as const, content: { type: "text" as const, text } }] },
          options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" as const }, { optionId: "deny", name: "Deny once", kind: "reject_once" as const }] });
        const release = options.reserveOutput(ACP_LIMITS.responseBytes);
        const response = await untilAbort(connection.client.request<"session/request_permission">("session/request_permission", request).finally(release), signal);
        if (!signal.aborted && !closing && entry.runtime?.controller.snapshot().pending === pending &&
          response.outcome.outcome === "selected" && response.outcome.optionId === "allow") decision = "allow";
      } catch { /* cancelled/malformed/disconnected permission is denied */ }
      finally {
        if (entry.runtime?.controller.snapshot().pending === pending) pending.resolve(decision, false);
        if (!closing) await update(sessionId, { sessionUpdate: "tool_call_update", toolCallId,
          status: decision === "allow" ? "completed" : "failed", content: [{ type: "content", content: { type: "text",
            text: decision === "allow" ? "Approved once; this is not an execution result." : "Approval denied." } }] }).catch(() => {});
      }
    })();
    entry.permissionTasks.add(task);
    void task.then(() => entry.permissionTasks.delete(task), () => { entry.permissionTasks.delete(task); fail(); });
  }
  const app = agent()
    .onRequest("initialize", () => {
      if (initialized) throw RequestError.invalidRequest();
      initialized = true;
      return acpResult({ protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "agentrig", version: "0.1.0" },
        authMethods: [], _meta: { agentrig: { version: 1, extensions: ["state", "events", "supervisor", "memory"], rawEventsSensitive: true } } });
    })
    .onRequest("session/new", async ({ params }) => {
      if (!initialized || closing || sessions.size >= ACP_LIMITS.sessions) throw RequestError.invalidRequest();
      if (!isAbsolute(params.cwd) || params.cwd.length > 4096 || params.mcpServers.length > 8 || params.additionalDirectories?.length) throw RequestError.invalidParams();
      const cwd = await realpath(params.cwd);
      if (!(await stat(cwd)).isDirectory()) throw RequestError.invalidParams();
      if (closing || sessions.size >= ACP_LIMITS.sessions) throw RequestError.invalidRequest();
      const id = randomUUID();
      const entry: Entry = { busy: false, raw: false, turn: 0, approval: 0, cancelled: false, controller: new AbortController(), observing: Promise.resolve(), permissionTasks: new Set() };
      sessions.set(id, entry);
      try {
        entry.creating = options.createSession({ ...params, cwd }, session => {
          entry.observing = observe(id, entry, session); void entry.observing.catch(fail);
        });
        entry.runtime = await entry.creating;
        if (closing) { await entry.runtime.close(); throw RequestError.invalidRequest(); }
        entry.unsubscribe = entry.runtime.controller.subscribe(state => { if (state.pending !== null) permission(id, entry, state.pending); });
        return acpResult({ sessionId: id });
      } catch { sessions.delete(id); throw new RequestError(-32000, ACP_SESSION_REFUSAL); }
    })
    .onRequest("session/prompt", async ({ params }) => {
      const entry = current(params.sessionId);
      if (entry.busy || params.prompt.length > 32) throw RequestError.invalidRequest();
      const text: string[] = []; const advisory: string[] = [];
      for (const block of params.prompt) {
        if (block.type === "text") text.push(block.text);
        else if (block.type === "resource_link") {
          if (block.uri.length > 4096 || block.name.length > 512) throw RequestError.invalidParams();
          // Reference metadata only. No automatic fetch, permission or context authority.
          const data = JSON.stringify({ uri: block.uri, name: block.name, title: block.title, description: block.description, mimeType: block.mimeType, size: block.size });
          if (data.length > 32_000) throw RequestError.invalidParams();
          advisory.push(data);
        } else throw RequestError.invalidParams();
      }
      const task = text.join("\n");
      if (Buffer.byteLength(task) > 262_144 || (!task.trim() && !advisory.length)) throw RequestError.invalidParams();
      entry.busy = true; entry.cancelled = false; entry.turn++; delete entry.summary; delete entry.stop; entry.controller = new AbortController();
      try {
        await entry.runtime.controller.prompt(task, advisory.length ? advisory : undefined);
        await entry.observing;
        await Promise.allSettled([...entry.permissionTasks]);
        const summary = (entry as Entry).summary;
        if (summary === undefined || summary.reason === "error") throw new RequestError(-32000, "Agent run failed");
        const stopReason = entry.cancelled || summary.reason === "aborted" ? "cancelled" : summary.reason === "budget" ? "max_turn_requests"
          : entry.stop === "refusal" ? "refusal" : entry.stop === "max_tokens" ? "max_tokens" : "end_turn";
        return acpResult({ stopReason, _meta: { agentrig: { reason: summary.reason } } });
      } catch { throw new RequestError(-32000, "Agent run failed"); }
      finally { entry.busy = false; }
    })
    .onNotification("session/cancel", ({ params }) => {
      const entry = sessions.get(params.sessionId);
      if (entry?.busy) { entry.cancelled = true; entry.controller.abort(); entry.runtime?.controller.abort(); }
    })
    .onRequest("_agentrig/state", AcpSessionParams, ({ params }) => {
      const entry = current(params.sessionId); const state = entry.runtime.controller.snapshot();
      return acpResult({ version: 1, sessionId: params.sessionId, status: state.status, turns: state.turns, model: state.model,
        running: entry.busy, pendingPermission: state.pending !== null, plan: state.plan });
    })
    .onRequest("_agentrig/events", AcpEventsParams, ({ params }) => {
      const entry = current(params.sessionId); entry.raw = params.enabled;
      return acpResult({ version: 1, enabled: entry.raw, sensitive: true, history: false, lossless: false });
    })
    .onRequest("_agentrig/supervisor", AcpSessionParams, ({ params }) => acpResult({ version: 1, signals: current(params.sessionId).runtime.controller.snapshot().signals }))
    .onRequest("_agentrig/memory", AcpMemoryParams, async ({ params }) => {
      const entry = current(params.sessionId);
      if (entry.runtime.memory === undefined || entry.busy) throw RequestError.invalidRequest();
      try { return acpResult({ version: 1, lines: (await entry.runtime.memory(params.query)).slice(0, 32).map(bounded) }); }
      catch { throw new RequestError(-32000, "Memory request refused"); }
    });
  connection = app.connect(stream);
  const done = connection.closed.then(async () => {
    closing = true;
    for (const entry of sessions.values()) { entry.controller.abort(); entry.unsubscribe?.(); entry.runtime?.controller.abort(); }
    await Promise.allSettled([...sessions.values()].map(async entry => { await entry.creating?.catch(() => {}); await entry.runtime?.controller.shutdown();
      await entry.observing.catch(() => {}); await Promise.allSettled([...entry.permissionTasks]); await entry.runtime?.close(); }));
    sessions.clear();
  });
  return { connection, done };
}
