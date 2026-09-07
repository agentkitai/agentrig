import { Readable, Writable } from "node:stream";
import type WebSocket from "ws";
import { ACP_LIMITS } from "./acp-transport.js";

/** Frame adaptation only. The existing ACP parser and SDK own RPC validation. */
export function webBridge(socket: WebSocket) {
  const queue: Buffer[] = []; let queued = 0; let outbound = 0; let waiting = false; let closed = false;
  const input = new Readable({ highWaterMark: 1, read() {
    const next = queue.shift();
    if (next === undefined) { waiting = true; return; }
    queued -= next.length; this.push(next);
  } });
  const output = new Writable({ highWaterMark: 1, write(chunk: Buffer, _encoding, callback) {
    if (closed || chunk.length > ACP_LIMITS.frameBytes || chunk.at(-1) !== 10 || chunk.subarray(0, -1).includes(10)) {
      callback(new Error("Web ACP output refused")); return;
    }
    // No compression or fragments: ws passes this callback to the final socket.write.
    // This is local write completion, not browser receipt or remote durability.
    socket.send(chunk.subarray(0, -1), { binary: false, compress: false }, callback);
  } });
  const write = output.write.bind(output);
  output.write = ((chunk: Uint8Array | string, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
    const cb = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk, encoding) : chunk.byteLength;
    if (closed || bytes > ACP_LIMITS.frameBytes || outbound + bytes > ACP_LIMITS.outputBytes) {
      close(); cb?.(new Error("Web ACP output capacity exceeded")); return false;
    }
    outbound += bytes; let settled = false;
    const done = (error?: Error | null) => { if (!settled) { settled = true; outbound -= bytes; cb?.(error); } };
    try { return encoding === undefined ? write(chunk, done) : write(chunk, encoding, done); }
    catch { done(new Error("Web ACP write failed")); close(); return false; }
  }) as Writable["write"];
  function close() {
    if (closed) return; closed = true; queue.length = 0; queued = 0;
    input.destroy(); output.destroy(); socket.terminate();
  }
  input.on("error", close); output.on("error", close); socket.on("error", close); socket.on("close", close);
  socket.on("message", (data, binary) => {
    const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
    // Compact NDJSON-compatible ACP frames; pretty/multiple raw-line frames refuse.
    if (closed || binary || queue.length >= 1024 || bytes.includes(10) || bytes.includes(13) ||
      queued + input.readableLength + bytes.length + 1 > ACP_LIMITS.frameBytes) { close(); return; }
    const line = Buffer.concat([bytes, Buffer.from("\n")]);
    if (waiting) { waiting = false; input.push(line); }
    else { queued += line.length; queue.push(line); }
  });
  return { input, output, close, get inputBytes() { return queued + input.readableLength; }, get outputBytes() { return outbound; } };
}
