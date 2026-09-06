import { performance } from "node:perf_hooks";
import { z } from "zod";

export const OTEL_LIMITS = Object.freeze({ sessions: 128, activeSpans: 1024, identities: 1024,
  queuedSpans: 1024, queuedBytes: 1_048_576, batchSpans: 128, batchBytes: 262_144,
  responseBytes: 65_536, requestMs: 2000, batchMs: 4500, closeMs: 5000 });
export interface OtlpSpan {
  traceId: string; spanId: string; parentSpanId?: string; name: "session" | "turn" | "tool";
  kind: 1; startTimeUnixNano: string; endTimeUnixNano: string;
  attributes: Array<{ key: string; value: { intValue: string } | { boolValue: boolean } | { stringValue: string } }>;
  status?: { code: 2 };
}
export interface OtelCounters { dropped: number; failed: number; partial: number; incomplete: number; exported: number }
export function otelEndpoint(value: string): string {
  try {
    if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) throw new Error();
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return url.href;
  } catch { throw new Error("invalid OTLP endpoint: use an explicit HTTP(S) traces URL without credentials, query or fragment"); }
}
const responseSchema = z.object({ partialSuccess: z.object({
  rejectedSpans: z.union([z.string().regex(/^\d{1,16}$/), z.number().int().nonnegative().safe()]).optional(),
  errorMessage: z.string().optional(),
}).optional() });
const envelope = (spans: OtlpSpan[]) => JSON.stringify({ resourceSpans: [{ resource: {
  attributes: [{ key: "service.name", value: { stringValue: "agentrig" } }],
}, scopeSpans: [{ scope: { name: "agentrig.events", version: "1" }, spans }] }] });

/** Bounded lossy transport. Never receives raw events, and never invokes model code. */
export class OtlpExporter {
  readonly counters: OtelCounters = { dropped: 0, failed: 0, partial: 0, incomplete: 0, exported: 0 };
  private queue: Array<{ span: OtlpSpan; bytes: number }> = [];
  private bytes = 0;
  private count = 0;
  private active: Promise<void> | undefined;
  private closing = false;
  private stopped = new AbortController();
  private closePromise: Promise<void> | undefined;
  readonly endpoint: string;
  constructor(endpoint: string, private readonly fetcher: typeof fetch = fetch) { this.endpoint = otelEndpoint(endpoint); }
  get retained() { return { spans: this.count, bytes: this.bytes }; }
  push(span: OtlpSpan): void {
    const bytes = Buffer.byteLength(JSON.stringify(span));
    if (this.closing || bytes > OTEL_LIMITS.batchBytes - 1024 || this.count >= OTEL_LIMITS.queuedSpans ||
      this.bytes + bytes > OTEL_LIMITS.queuedBytes) { this.counters.dropped++; return; }
    this.queue.push({ span, bytes }); this.bytes += bytes; this.count++;
    this.start();
  }
  private start(): void {
    if (this.active !== undefined || this.queue.length === 0 || this.stopped.signal.aborted) return;
    this.active = this.pump().catch(() => { this.counters.failed++; }).finally(() => {
      this.active = undefined; if (this.queue.length) this.start();
    });
  }
  private async pump(): Promise<void> {
    while (this.queue.length && !this.stopped.signal.aborted) {
      const batch: typeof this.queue = []; let bytes = 1024;
      while (this.queue.length && batch.length < OTEL_LIMITS.batchSpans && bytes + this.queue[0]!.bytes <= OTEL_LIMITS.batchBytes) {
        const entry = this.queue.shift()!; batch.push(entry); bytes += entry.bytes;
      }
      try { await this.send(envelope(batch.map(entry => entry.span)), batch.length); }
      finally { for (const entry of batch) { this.bytes -= entry.bytes; this.count--; } }
    }
  }
  private async send(body: string, count: number): Promise<void> {
    const deadline = performance.now() + OTEL_LIMITS.batchMs;
    for (let attempt = 0; attempt < 2 && !this.stopped.signal.aborted; attempt++) {
      const abort = new AbortController();
      const signal = AbortSignal.any([abort.signal, this.stopped.signal]);
      const timer = setTimeout(() => abort.abort(), Math.min(OTEL_LIMITS.requestMs, Math.max(1, deadline - performance.now())));
      let retry = false; let delay = 100; let headersReceived = false;
      try {
        const response = await this.fetcher(this.endpoint, { method: "POST", redirect: "manual", signal,
          headers: { "content-type": "application/json", accept: "application/json" }, body });
        headersReceived = true;
        if (response.status !== 200) {
          await response.body?.cancel();
          retry = [429, 502, 503, 504].includes(response.status);
          const after = response.headers.get("retry-after");
          if (after !== null) {
            const seconds = /^\d+$/.test(after) ? Number(after) * 1000 : Date.parse(after) - Date.now();
            if (Number.isFinite(seconds)) delay = Math.max(0, seconds);
          }
        } else {
          if ((response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase() !== "application/json") {
            await response.body?.cancel(); throw new Error("invalid response");
          }
          const reader = response.body?.getReader(); const parts: Uint8Array[] = []; let size = 0;
          try {
            if (reader !== undefined) while (true) {
              const next = await reader.read(); if (next.done) break;
              size += next.value.byteLength;
              if (size > OTEL_LIMITS.responseBytes) { await reader.cancel(); throw new Error("response bound"); }
              parts.push(next.value);
            }
          } finally { reader?.releaseLock(); }
          const parsed = responseSchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts))));
          if (!parsed.success) throw new Error("invalid response");
          if (parsed.data.partialSuccess !== undefined) this.counters.partial += count;
          else this.counters.exported += count;
          return;
        }
      } catch (error) {
        // Fetch transport/timeout failures may retry; parsing/refusal failures never do.
        retry = signal.aborted || (!headersReceived && error instanceof TypeError);
      } finally { clearTimeout(timer); }
      if (!retry || attempt === 1 || performance.now() + delay >= deadline || this.stopped.signal.aborted) break;
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(wait); this.stopped.signal.removeEventListener("abort", finish); resolve(); };
        const wait = setTimeout(finish, delay); this.stopped.signal.addEventListener("abort", finish, { once: true });
        if (this.stopped.signal.aborted) finish();
      });
    }
    this.counters.failed++; this.counters.dropped += count;
  }
  close(): Promise<void> {
    return this.closePromise ??= this.finish();
  }
  private async finish(): Promise<void> {
    this.closing = true;
    const timer = setTimeout(() => this.stopped.abort(), OTEL_LIMITS.closeMs);
    try { while (this.active !== undefined) await this.active; }
    finally {
      clearTimeout(timer); this.stopped.abort();
      this.counters.dropped += this.queue.length; this.queue = []; this.count = 0; this.bytes = 0;
    }
  }
}
