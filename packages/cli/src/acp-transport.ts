import type { Readable, Writable } from "node:stream";
import type { AnyMessage, JsonRpcId, Stream } from "@agentclientprotocol/sdk";

export const ACP_LIMITS = { frameBytes: 1_048_576, outputBytes: 4_194_304, requests: 32, permissions: 8, sessions: 8 } as const;
export const ACP_SESSION_REFUSAL = "Session refused; check trusted configuration, cwd and existing MCP pins using the CLI";
const idKey = (id: JsonRpcId): string => JSON.stringify(id);
const validId = (value: unknown): value is JsonRpcId => value === null ||
  (typeof value === "string" && value.length <= 128) || (typeof value === "number" && Number.isSafeInteger(value));

/** Bounded ACP framing, not a second RPC dialect. The SDK owns method/schema handling. */
export function acpTransport(input: Readable, output: Writable) {
  let ended = false; let buffered = Buffer.alloc(0); let queuedBytes = 0;
  let readableControl: ReadableStreamDefaultController<AnyMessage>;
  let writableControl: WritableStreamDefaultController;
  const inbound = new Set<string>();
  const outbound = new Map<string, JsonRpcId>();
  let finish!: () => void;
  const closed = new Promise<void>(resolve => { finish = resolve; });
  const iterator = input[Symbol.asyncIterator]();
  function close(): void {
    if (ended) return;
    ended = true;
    const error = new Error("ACP transport closed");
    readableControl?.error(error); writableControl?.error(error);
    inbound.clear(); outbound.clear();
    input.destroy(); output.destroy(); finish();
  }
  input.on("error", close); output.on("error", close);
  function decode(line: Buffer): AnyMessage {
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)); }
    catch { throw new Error("invalid ACP frame"); }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid ACP envelope");
    const value = parsed as Record<string, unknown>;
    if (value.jsonrpc !== "2.0" || ("id" in value && !validId(value.id))) throw new Error("invalid ACP envelope");
    if (typeof value.method === "string") {
      if (value.method.length > 256 || "result" in value || "error" in value) throw new Error("invalid ACP request");
      if ("id" in value) {
        const key = idKey(value.id as JsonRpcId);
        if (inbound.has(key) || inbound.size >= ACP_LIMITS.requests) throw new Error("ACP request capacity exceeded");
        inbound.add(key);
      }
    } else {
      if (!("id" in value) || (("result" in value) === ("error" in value))) throw new Error("invalid ACP response");
      const key = idKey(value.id as JsonRpcId);
      if (!outbound.has(key)) throw new Error("unknown ACP response");
      value.id = outbound.get(key)!; outbound.delete(key);
    }
    return value as unknown as AnyMessage;
  }
  const readable = new ReadableStream<AnyMessage>({
    start(controller) { readableControl = controller; },
    async pull(controller) {
      try {
        while (!ended) {
          const newline = buffered.indexOf(10);
          if (newline >= 0) {
            if (newline > ACP_LIMITS.frameBytes) throw new Error("ACP frame exceeds limit");
            const line = buffered.subarray(0, newline); buffered = buffered.subarray(newline + 1);
            if (!line.toString("utf8").trim()) continue;
            controller.enqueue(decode(line)); return;
          }
          if (buffered.length > ACP_LIMITS.frameBytes) throw new Error("ACP frame exceeds limit");
          const next = await iterator.next();
          if (next.done) { close(); return; }
          const bytes = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value as string);
          // Node readable chunks are bounded; reject arbitrary injected oversized chunks too.
          if (bytes.length > ACP_LIMITS.frameBytes) throw new Error("ACP input chunk exceeds limit");
          buffered = Buffer.concat([buffered, bytes]);
        }
      } catch { close(); }
    },
    cancel() { close(); },
  }, { highWaterMark: 1 });
  const writable = new WritableStream<AnyMessage>({
    start(controller) { writableControl = controller; },
    async write(message) {
      const size = Buffer.byteLength(JSON.stringify(message)) + 64;
      try {
        if (ended) throw new Error("ACP transport closed");
        let wire: AnyMessage = message;
        if ("method" in message && "id" in message) {
          if (outbound.size >= ACP_LIMITS.permissions) throw new Error("ACP permission capacity exceeded");
          const id = `agentrig:${idKey(message.id)}`;
          if (outbound.has(idKey(id))) throw new Error("duplicate outbound ACP request");
          outbound.set(idKey(id), message.id); wire = { ...message, id };
        } else if ("method" in message && message.method === "$/cancel_request") {
          const params = message.params as { requestId?: JsonRpcId } | undefined;
          if (params?.requestId !== undefined) {
            const requestId = `agentrig:${idKey(params.requestId)}`;
            wire = { ...message, params: { requestId } };
          }
        } else if (!("method" in message) && "id" in message) {
          // SDK-generated errors must never echo invalid client credentials or config values.
          if ("error" in message) wire = { jsonrpc: "2.0", id: message.id,
            error: { code: message.error.code, message: message.error.message === ACP_SESSION_REFUSAL ? ACP_SESSION_REFUSAL : "ACP request refused" } };
        }
        const data = Buffer.from(`${JSON.stringify(wire)}\n`);
        if (data.length > ACP_LIMITS.frameBytes) throw new Error("ACP output frame exceeds limit");
        await new Promise<void>((resolve, reject) => {
          const failed = () => { cleanup(); reject(new Error("ACP output closed")); };
          const cleanup = () => { output.off("close", failed); };
          output.once("close", failed);
          output.write(data, error => { cleanup(); if (error) reject(error); else resolve(); });
        });
        if (!("method" in message) && "id" in message) inbound.delete(idKey(message.id));
      } catch (error) { close(); throw error; }
      finally { queuedBytes -= size; }
    },
    close, abort: close,
  }, { highWaterMark: ACP_LIMITS.outputBytes,
    size(message) {
      // Called synchronously on enqueue, including messages behind a blocked write.
      const bytes = Buffer.byteLength(JSON.stringify(message)) + 64;
      if (ended || bytes > ACP_LIMITS.frameBytes || queuedBytes + bytes > ACP_LIMITS.outputBytes) {
        close(); throw new Error("ACP output capacity exceeded");
      }
      queuedBytes += bytes; return bytes;
    },
  });
  const stream: Stream = { readable, writable };
  return { stream, closed, close, get queuedBytes() { return queuedBytes; } };
}
