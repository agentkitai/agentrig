import type { AuxiliaryCall, AuxiliaryReport, ModelProvider, Usage } from "@agentkitai/agentrig-core";

export interface MaintenanceLimits {
  timeoutMs: number;
  callTimeoutMs: number;
  maxCalls: number;
  maxInputChars: number;
  maxOutputChars: number;
  maxModelEvents: number;
}
export const DEFAULT_MAINTENANCE_LIMITS: Readonly<MaintenanceLimits> = Object.freeze({
  timeoutMs: 300_000, callTimeoutMs: 30_000, maxCalls: 66,
  maxInputChars: 32_768, maxOutputChars: 65_536, maxModelEvents: 4096,
});

export function positiveLimit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw new Error(`invalid maintenance limit ${name}`);
  return value;
}
export class MaintenanceLimitError extends Error { override name = "MaintenanceLimitError"; }
/** Diagnostic callbacks are not work: neither a throw nor an async rejection changes commits. */
export function maintenanceDiagnostic(callback: () => unknown): void {
  try { void Promise.resolve(callback()).catch(() => {}); } catch { /* diagnostic only */ }
}
const timeout = (ms: number) => new DOMException(`maintenance timed out after ${ms}ms`, "TimeoutError");
function outcome(error: unknown): AuxiliaryCall["outcome"] {
  if (error instanceof MaintenanceLimitError) return "limit";
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  if (error instanceof Error && error.name === "AbortError") return "aborted";
  return "failed";
}

/** Races only external work, never local commits or lock ownership. Late results are ignored.
 * A JS provider that blocks the event loop cannot be preempted; uncooperative remote work may
 * continue outside this process. Its final usage remains unknown.
 */
export class MaintenanceRun {
  localCommitState?: AuxiliaryReport["localCommitState"];
  readonly limits: MaintenanceLimits;
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly started = performance.now();
  private readonly timer: NodeJS.Timeout;
  private readonly calls: AuxiliaryCall[] = [];
  private readonly parent: AbortSignal | undefined;
  private readonly abortParent = () => this.controller.abort(this.parent?.reason);
  private finished = false;

  constructor(private readonly operation: AuxiliaryReport["operation"], limits: Partial<MaintenanceLimits> = {}, signal?: AbortSignal) {
    this.limits = { ...DEFAULT_MAINTENANCE_LIMITS, ...limits };
    for (const [key, value] of Object.entries(this.limits)) positiveLimit(key, value);
    this.signal = this.controller.signal;
    this.parent = signal;
    signal?.addEventListener("abort", this.abortParent, { once: true });
    if (signal?.aborted) this.abortParent();
    this.timer = setTimeout(() => this.controller.abort(timeout(this.limits.timeoutMs)), this.limits.timeoutMs);
  }

  check(): void {
    if (this.finished) throw new Error("maintenance run is closed");
    if (performance.now() - this.started >= this.limits.timeoutMs) this.controller.abort(timeout(this.limits.timeoutMs));
    this.signal.throwIfAborted();
  }

  async call<T>(operation: string, provider: string, fn: (signal: AbortSignal, usage: (value: Usage, complete?: boolean) => void) => Promise<T>, model?: string): Promise<T> {
    this.check();
    if (this.calls.length >= this.limits.maxCalls) throw new MaintenanceLimitError("maintenance call limit exceeded");
    const controller = new AbortController();
    const abort = () => controller.abort(this.signal.reason);
    this.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(timeout(this.limits.callTimeoutMs)), this.limits.callTimeoutMs);
    const started = performance.now();
    const record: AuxiliaryCall = { operation, provider, ...(model === undefined ? {} : { model }),
      outcome: "failed", durationMs: 0, usageComplete: false };
    this.calls.push(record);
    let accepting = true;
    let reported = false;
    let malformedUsage = false;
    let rejectAbort!: () => void;
    try {
      const aborted = new Promise<never>((_, reject) => {
        rejectAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", rejectAbort, { once: true });
        if (controller.signal.aborted) rejectAbort();
      });
      const work = Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return fn(controller.signal, (value, complete = true) => {
          if (!accepting || controller.signal.aborted) return;
          // ModelEvent usage is cumulative per request, not additive per event.
          const valid = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
          if (value === null || typeof value !== "object" || !valid(value.input) || !valid(value.output)
            || (value.cacheRead !== undefined && !valid(value.cacheRead)) || (value.cacheWrite !== undefined && !valid(value.cacheWrite))) {
            malformedUsage = true; reported = false; return;
          }
          record.usage = { input: value.input, output: value.output,
            ...(value.cacheRead === undefined ? {} : { cacheRead: value.cacheRead }),
            ...(value.cacheWrite === undefined ? {} : { cacheWrite: value.cacheWrite }) };
          reported = complete;
        });
      });
      const result = await Promise.race([work, aborted]);
      if (performance.now() - started >= this.limits.callTimeoutMs) controller.abort(timeout(this.limits.callTimeoutMs));
      controller.signal.throwIfAborted(); this.check();
      record.outcome = "completed";
      record.usageComplete = record.usage !== undefined && reported && !malformedUsage;
      return result;
    } catch (error) {
      record.outcome = controller.signal.aborted ? (outcome(controller.signal.reason) === "timeout" ? "timeout" : "aborted") : outcome(error);
      throw error;
    } finally {
      accepting = false;
      record.durationMs = Math.max(0, performance.now() - started);
      clearTimeout(timer);
      this.signal.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", rejectAbort);
      // Abort cooperative abandoned work, without waiting on an uncooperative iterator.return().
      controller.abort(new DOMException("auxiliary call closed", "AbortError"));
    }
  }

  async completeJson(provider: ModelProvider, system: string, user: string, maxTokens: number, opts: { requireEndTurn?: boolean } = {}): Promise<string> {
    positiveLimit("maxTokens", maxTokens);
    if (system.length + user.length > this.limits.maxInputChars) throw new MaintenanceLimitError("maintenance model input limit exceeded");
    return this.call("completion", provider.id, async (signal, usage) => {
      const iterator = provider.stream({ system, messages: [{ role: "user", content: [{ type: "text", text: user }] }], tools: [], maxTokens }, signal)[Symbol.asyncIterator]();
      let closed = false;
      const close = (): void => {
        if (closed) return; closed = true;
        try { void Promise.resolve(iterator.return?.()).catch(() => {}); } catch { /* cleanup cannot mask outcome */ }
      };
      signal.addEventListener("abort", close, { once: true });
      let text = ""; let events = 0; let retried = false; let lastUsage: Usage | undefined; let ended = false;
      try {
        for (;;) {
          signal.throwIfAborted();
          const next = await iterator.next();
          signal.throwIfAborted();
          if (next.done) break;
          if (++events > this.limits.maxModelEvents) throw new MaintenanceLimitError("maintenance model event limit exceeded");
          const ev = next.value;
          if (ev.type === "text_delta") {
            if (text.length + ev.text.length > this.limits.maxOutputChars) throw new MaintenanceLimitError("maintenance model output limit exceeded");
            text += ev.text;
          } else if (ev.type === "usage") { lastUsage = ev.usage; usage(ev.usage, ev.reported !== false && !retried); }
          else if (ev.type === "retry") { retried = true; if (lastUsage !== undefined) usage(lastUsage, false); }
          else if (ev.type === "stop") {
            if (ev.reason !== "end_turn") throw new Error(`auxiliary completion stopped: ${ev.reason}`);
            ended = true;
          }
          // Let timers/abort run even if an adapter yields endless immediately-resolved events.
          if (events % 64 === 0) await new Promise<void>(resolve => setImmediate(resolve));
        }
        if (opts.requireEndTurn === true && !ended) throw new Error("auxiliary completion ended without end_turn");
        return text;
      } finally {
        signal.removeEventListener("abort", close); close();
      }
    }, provider.model);
  }

  finish(error?: unknown): AuxiliaryReport {
    this.finished = true;
    clearTimeout(this.timer);
    this.parent?.removeEventListener("abort", this.abortParent);
    const reportedUsage: Usage = { input: 0, output: 0 };
    for (const call of this.calls) {
      if (!call.usage) continue;
      reportedUsage.input += call.usage.input;
      reportedUsage.output += call.usage.output;
      if (call.usage.cacheRead !== undefined) reportedUsage.cacheRead = (reportedUsage.cacheRead ?? 0) + call.usage.cacheRead;
      if (call.usage.cacheWrite !== undefined) reportedUsage.cacheWrite = (reportedUsage.cacheWrite ?? 0) + call.usage.cacheWrite;
    }
    return { operation: this.operation, outcome: error === undefined ? "completed" : this.signal.aborted ? (outcome(this.signal.reason) === "timeout" ? "timeout" : "aborted") : outcome(error),
      durationMs: Math.max(0, performance.now() - this.started), calls: structuredClone(this.calls), reportedUsage,
      unknownUsageCalls: this.calls.filter(c => !c.usageComplete).length, costUsd: this.calls.length === 0 ? 0 : null,
      ...(this.localCommitState === undefined ? {} : { localCommitState: this.localCommitState }) };
  }
}

export function formatAuxiliaryUsage(report: AuxiliaryReport): string {
  return `auxiliary ${report.operation}: ${report.calls.length} call(s), ${report.reportedUsage.input} input / ${report.reportedUsage.output} output / ${report.reportedUsage.cacheRead ?? 0} cache-read / ${report.reportedUsage.cacheWrite ?? 0} cache-write reported tokens; ${report.unknownUsageCalls} call(s) with unknown total usage; cost ${report.costUsd === null ? "unknown" : `$${report.costUsd}`}; ${report.outcome}${report.localCommitState === undefined ? "" : `; local writes ${report.localCommitState}`}`;
}
