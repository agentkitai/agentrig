import type { Readable, Writable } from "node:stream";
import { parseJSONRPCMessage, type JSONRPCMessage, type Transport } from "@modelcontextprotocol/server";
import { MCP_TOOL_INPUTS } from "./mcp-serve-schema.js";

export const MCP_SERVE_LIMITS = Object.freeze({ frame: 1_048_576, input: 8_388_608,
  output: 4_194_304, response: 262_144, pending: 16, notifications: 64 });
type Slot = { bytes: number; cancelled: boolean; settled: boolean; abort: AbortController };

/** Public SDK transport: reserves capacity before delivery, releases after physical writes.
 * No credentials/errors from SDK handlers are reflected verbatim onto the wire. */
export class BoundedMcpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private buffer = Buffer.alloc(0);
  private slots = new Map<string | number, Slot>();
  private cancelledIds = new Set<string | number>();
  private inputBytes = 0;
  private notifications = 0;
  private notificationBytes = 0;
  private ended = false;
  private started = false;
  private finishClosed!: () => void;
  readonly closed = new Promise<void>(resolve => { this.finishClosed = resolve; });
  constructor(private input: Readable, private output: Writable) {}
  get pending(): number { return this.slots.size; }
  get reservedBytes(): number { return this.slots.size * MCP_SERVE_LIMITS.response; }

  async start(): Promise<void> {
    if (this.started) throw new Error("MCP transport already started");
    this.started = true;
    this.input.on("data", this.data);
    this.input.on("end", this.stop);
    this.input.on("close", this.stop);
    this.input.on("error", this.stop);
    this.output.on("error", this.stop);
    this.output.on("close", this.stop);
  }
  private stop = (): void => { void this.close(); };
  private data = (chunk: Buffer | string): void => {
    if (this.ended) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    // A single stream chunk may contain multiple bounded frames; process without
    // constructing an unbounded concatenated buffer.
    let from = 0;
    while (from < bytes.length && !this.ended) {
      const newline = bytes.indexOf(10, from);
      const to = newline < 0 ? bytes.length : newline;
      if (this.buffer.length + to - from > MCP_SERVE_LIMITS.frame) { this.stop(); return; }
      this.buffer = Buffer.concat([this.buffer, bytes.subarray(from, to)]);
      if (newline < 0) return;
      const frame = this.buffer; this.buffer = Buffer.alloc(0); from = newline + 1;
      try { this.deliver(frame); } catch { this.stop(); }
    }
  };
  private deliver(frame: Buffer): void {
    const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid frame");
    let message = parseJSONRPCMessage(raw);
    if (!("method" in message) || message.method.length > 128) throw new Error("unexpected response");
    if ("id" in message) {
      const id = message.id;
      if (!(typeof id === "string" && id.length <= 128 || typeof id === "number" && Number.isSafeInteger(id)) ||
        this.slots.has(id) || this.cancelledIds.has(id) || this.slots.size >= MCP_SERVE_LIMITS.pending ||
        this.inputBytes + this.notificationBytes + frame.length > MCP_SERVE_LIMITS.input) throw new Error("capacity exceeded");
      this.slots.set(id, { bytes: frame.length, cancelled: false, settled: false, abort: new AbortController() });
      this.inputBytes += frame.length;
      if (message.method === "tools/call") {
        const name = message.params?.name;
        const schema = typeof name === "string" && Object.hasOwn(MCP_TOOL_INPUTS, name)
          ? MCP_TOOL_INPUTS[name as keyof typeof MCP_TOOL_INPUTS] : undefined;
        if (schema === undefined || !schema.safeParse(message.params?.arguments ?? {}).success) {
          // SDK tool-validation errors are content results and may quote hostile
          // keys/names. Route them to a fixed SDK error without reflecting input.
          message = { ...message, method: "_agentrig/refused", params: { _meta: message.params?._meta } };
        }
      }
    } else {
      if (++this.notifications > MCP_SERVE_LIMITS.notifications ||
        this.inputBytes + this.notificationBytes + frame.length > MCP_SERVE_LIMITS.input) throw new Error("notification capacity exceeded");
      this.notificationBytes += frame.length; // conservatively retained for the connection lifetime
      if (message.method === "notifications/cancelled") {
        const id = message.params?.requestId;
        if (typeof id !== "string" && typeof id !== "number") throw new Error("invalid cancellation");
        const slot = this.slots.get(id);
        if (slot) { this.cancelledIds.add(id); slot.cancelled = true; slot.abort.abort(); if (slot.settled) this.release(id); }
      } else if (message.method !== "notifications/initialized") throw new Error("unsupported notification");
    }
    this.onmessage?.(message);
  }
  /** Called by the actual owned tool handler only after its cleanup has settled. */
  signal(id: string | number): AbortSignal {
    return this.slots.get(id)?.abort.signal ?? AbortSignal.abort();
  }
  settled(id: string | number): void {
    const slot = this.slots.get(id);
    if (slot) { slot.settled = true; if (slot.cancelled) this.release(id); }
  }
  private release(id: string | number): void {
    const slot = this.slots.get(id);
    if (slot) { this.inputBytes -= slot.bytes; this.slots.delete(id); }
  }
  async send(message: JSONRPCMessage): Promise<void> {
    if (this.ended) throw new Error("MCP connection closed");
    if ("method" in message || !("id" in message) || message.id == null) {
      this.stop(); throw new Error("unsupported outbound message");
    }
    const id = message.id;
    if (this.cancelledIds.has(id)) return; // including SDK's numeric-zero cancellation edge
    const slot = this.slots.get(id);
    if (!slot) { this.stop(); throw new Error("unreserved response"); }
    if (slot.cancelled) return;
    let safe: JSONRPCMessage = message;
    if ("error" in message) safe = { jsonrpc: "2.0", id, error: { code: message.error.code, message: "MCP request refused" } };
    let bytes = Buffer.from(JSON.stringify(safe) + "\n");
    if (bytes.length > MCP_SERVE_LIMITS.response) {
      bytes = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: "MCP response exceeds output bound" } }) + "\n");
    }
    // The slot remains reserved while Node/OS stdout is blocked, not merely until
    // the SDK has accepted or queued the response.
    await new Promise<void>((resolve, reject) => {
      this.output.write(bytes, error => {
        if (error) { this.stop(); reject(new Error("MCP write failed")); }
        else { this.release(id); resolve(); }
      });
    });
  }
  async close(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.input.off("data", this.data); this.input.off("end", this.stop); this.input.off("close", this.stop);
    // Keep idempotent error listeners through owned runtime cleanup: a late EPIPE
    // must not become an uncaught exception that abandons the cleanup join.
    this.buffer = Buffer.alloc(0);
    for (const slot of this.slots.values()) slot.abort.abort();
    this.slots.clear(); this.cancelledIds.clear(); this.inputBytes = 0; this.notificationBytes = 0;
    this.input.pause();
    this.onclose?.(); this.finishClosed();
  }
}
