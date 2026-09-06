import { createHmac, randomBytes } from "node:crypto";
import type { Session } from "./agent.js";
import type { HarnessEvent } from "./events.js";
import { OTEL_LIMITS, OtlpExporter, type OtlpSpan, type OtelCounters } from "./otel-exporter.js";
export { OTEL_LIMITS, otelEndpoint, OtlpExporter } from "./otel-exporter.js";
export type { OtlpSpan, OtelCounters } from "./otel-exporter.js";

type Open = Omit<OtlpSpan, "endTimeUnixNano">;
const nano = (ts: number) => (BigInt(Math.max(0, Math.floor(ts))) * 1_000_000n).toString();
const integer = (key: string, value: number): OtlpSpan["attributes"][number] => ({ key, value: { intValue: String(Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value)))) } });
const text = (key: string, value: string): OtlpSpan["attributes"][number] => ({ key, value: { stringValue: value } });

/** Optional observer: only this bounded allowlist crosses the exporter boundary. */
export class OtelSink {
  private readonly key = randomBytes(32);
  private sessions = new Set<{ stop(): void }>();
  private readonly seen = new WeakSet<Session>();
  private readonly pumps = new Set<Promise<void>>();
  private activeSpans = 0;
  private closed = false;
  private closing: Promise<void> | undefined;
  constructor(readonly exporter: Pick<OtlpExporter, "push" | "close" | "counters">) {}
  get counters(): Readonly<OtelCounters> { return this.exporter.counters; }
  get retained() { return { sessions: this.sessions.size, activeSpans: this.activeSpans }; }
  private hash(value: string): string { return createHmac("sha256", this.key).update(value).digest("hex"); }
  observe(session: Session): void {
    if (this.seen.has(session)) return;
    if (this.closed || this.sessions.size >= OTEL_LIMITS.sessions) { this.exporter.counters.dropped++; return; }
    this.seen.add(session);
    const traceId = this.hash(session.id).slice(0, 32);
    let root: Open | undefined; let turn: Open | undefined; let last = Date.now(); let stopped = false;
    let input = 0; let output = 0; let cacheRead = 0; let cacheWrite = 0; let usageComplete = true;
    const calls = new Map<number, Open>(); const ids = new Map<string, number>();
    const start = (name: Open["name"], seq: number, parent?: Open): Open | undefined => {
      if (this.activeSpans >= OTEL_LIMITS.activeSpans) { this.exporter.counters.dropped++; return; }
      this.activeSpans++;
      return { traceId, spanId: randomBytes(8).toString("hex"), ...(parent === undefined ? {} : { parentSpanId: parent.spanId }),
        name, kind: 1, startTimeUnixNano: nano(last), attributes: [integer("agentrig.seq", seq)] };
    };
    const finish = (span: Open | undefined, outcome: string, error = false) => {
      if (span === undefined) return;
      this.activeSpans--;
      if (outcome === "incomplete") this.exporter.counters.incomplete++;
      this.exporter.push({ ...span, endTimeUnixNano: String(BigInt(nano(last)) < BigInt(span.startTimeUnixNano) ? BigInt(span.startTimeUnixNano) : BigInt(nano(last))),
        attributes: [...span.attributes, text("agentrig.outcome", outcome)], ...(error ? { status: { code: 2 } } : {}) });
    };
    const endCalls = () => { for (const call of calls.values()) finish(call, "incomplete"); calls.clear(); ids.clear(); };
    let stopWait: (() => void) | undefined;
    const stopPump = () => stopWait?.();
    const token = { stop: () => {
      if (stopped) return; stopped = true;
      stopPump();
      endCalls(); finish(turn, "incomplete"); turn = undefined; finish(root, "incomplete"); root = undefined;
      this.sessions.delete(token);
    } };
    this.sessions.add(token);
    const event = (e: HarnessEvent) => {
      if (stopped) return;
      last = e.ts;
      if (root === undefined) root = start("session", e.seq);
      if (root === undefined) { token.stop(); return; }
      switch (e.type) {
        case "turn.start": endCalls(); finish(turn, "incomplete"); turn = start("turn", e.seq, root);
          input = 0; output = 0; cacheRead = 0; cacheWrite = 0; usageComplete = true;
          turn?.attributes.push(integer("agentrig.turn", e.n)); break;
        case "turn.end": endCalls(); finish(turn, "completed"); turn = undefined; break;
        case "model.response":
          if (turn !== undefined) {
            input += e.usage.input; output += e.usage.output; cacheRead += e.usage.cacheRead ?? 0; cacheWrite += e.usage.cacheWrite ?? 0;
            usageComplete &&= e.usageComplete === true;
            turn.attributes = turn.attributes.filter(a => !a.key.startsWith("agentrig.usage."));
            turn.attributes.push(integer("agentrig.usage.input", input), integer("agentrig.usage.output", output),
              integer("agentrig.usage.cache_read", cacheRead), integer("agentrig.usage.cache_write", cacheWrite),
              { key: "agentrig.usage.complete", value: { boolValue: usageComplete } });
          }
          break;
        case "tool.call": {
          const parentSeq = e.internal === undefined ? undefined : ids.get(this.hash(e.internal.parentToolUseId));
          const call = start("tool", e.seq, parentSeq === undefined ? turn ?? root : calls.get(parentSeq) ?? turn ?? root);
          if (call !== undefined) { calls.set(e.seq, call); ids.set(this.hash(e.id), e.seq); }
          break;
        }
        case "tool.result": {
          const key = this.hash(e.id); const seq = e.toolCallSeq ?? ids.get(key);
          const call = seq === undefined ? undefined : calls.get(seq);
          if (call !== undefined) {
            if (e.permission !== undefined) call.attributes.push(text("agentrig.permission", e.permission));
            finish(call, e.ok ? "completed" : "error", !e.ok); calls.delete(seq!);
            if (ids.get(key) === seq) ids.delete(key);
          }
          break;
        }
        case "tool.denied": {
          const key = this.hash(e.id); const seq = ids.get(key);
          if (seq !== undefined) { finish(calls.get(seq), "denied", true); calls.delete(seq); ids.delete(key); }
          else {
            const attempt = start("tool", e.seq, turn ?? root);
            attempt?.attributes.push(text("agentrig.phase", "refused-attempt"));
            finish(attempt, "denied", true); // zero-duration refused attempt, not execution
          }
          break;
        }
        case "session.end": endCalls(); finish(turn, "incomplete"); turn = undefined;
          finish(root, e.reason, e.reason === "error"); root = undefined; stopped = true; stopPump(); this.sessions.delete(token); break;
      }
    };
    // No network await or per-observer event queue. The core's shared replay buffer is unchanged.
    const iterator = session.events[Symbol.asyncIterator]();
    const nextOrStop = () => new Promise<IteratorResult<HarnessEvent> | undefined>((resolve, reject) => {
      let settled = false;
      const finish = (value: IteratorResult<HarnessEvent> | undefined, error?: unknown) => {
        if (settled) return; settled = true; stopWait = undefined;
        if (error !== undefined) reject(error); else resolve(value);
      };
      stopWait = () => finish(undefined);
      try { void Promise.resolve(iterator.next()).then(value => finish(value), error => finish(undefined, error)); }
      catch (error) { finish(undefined, error); }
      if (stopped) stopWait?.();
    });
    const pump = (async () => {
      try {
        while (!stopped) {
          const next = await nextOrStop();
          if (next === undefined || next.done || stopped) break;
          event(next.value);
        }
      } catch { this.exporter.counters.failed++; }
      finally {
        token.stop();
        // A custom iterator's pending next/return cannot be forcibly completed. No later
        // event is consumed by this pump; the shared core replay store remains its owner.
        try { void Promise.resolve(iterator.return?.()).catch(() => {}); } catch { /* host iterator */ }
      }
    })();
    this.pumps.add(pump); void pump.finally(() => this.pumps.delete(pump));
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.closed = true; for (const session of this.sessions) session.stop();
      await Promise.all(this.pumps); await this.exporter.close();
    })();
  }
}
