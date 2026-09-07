import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { usageUsd, type Pricing } from "./agent.js";
import type { ModelProvider } from "./provider.js";
import { currentSpend } from "./spend-runtime.js";

const integer = z.number().int().nonnegative().safe();
const label = z.string().min(1).max(256).refine(s => !/[\u0000-\u001f\u007f]/u.test(s));
const rates = z.object({ inputUsdPerMTok: z.number().finite().nonnegative(), outputUsdPerMTok: z.number().finite().nonnegative(),
  cacheReadUsdPerMTok: z.number().finite().nonnegative(), cacheWriteUsdPerMTok: z.number().finite().nonnegative() }).strict();
const usage = z.object({ input: integer, output: integer, cacheRead: integer.optional(), cacheWrite: integer.optional() }).strict();
const base = { version: z.literal(1), segment: label, ts: integer };
const admission = z.object({ ...base, type: z.literal("admit"), call: label, model: label, provider: label,
  session: label.optional(), reserve: integer.nullable(), rates: rates.nullable() }).strict();
const settlement = z.object({ ...base, type: z.literal("settle"), call: label, usage: usage.nullable(),
  complete: z.boolean(), cost: integer.nullable() }).strict();
const end = z.object({ ...base, type: z.literal("end"), session: label.nullable() }).strict();
const gap = z.object({ ...base, type: z.literal("gap"), session: label.nullable(), reason: z.enum(["unmetered-provider", "accounting-unavailable"]) }).strict();
export const SpendRecordSchema = z.discriminatedUnion("type", [admission, settlement, end, gap]);
export type SpendRecord = z.infer<typeof SpendRecordSchema>;
type Admission = z.infer<typeof admission>;
type Settlement = z.infer<typeof settlement>;
const BYTE_CAP = 16 * 1024 * 1024;
const RECORD_CAP = 100_000;
const LINE_CAP = 8192;
const day = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

export class SpendCapError extends Error {
  constructor(readonly reason: "exhausted" | "uncertain" | "unavailable" | "unsupported") {
    super(`configured-estimate daily cap: ${reason}`); this.name = "SpendCapError";
  }
}

function safe(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new SpendCapError("unavailable");
  return value;
}
export function dailyCapMicros(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0 || usd > 1_000_000) throw new Error("--daily-cap must be positive and at most 1000000 USD");
  const result = safe(Math.floor(usd * 1_000_000));
  if (result === 0) throw new Error("--daily-cap is below one micro-USD");
  return result;
}
function price(usd: number): number { return safe(Math.ceil(usd * 1_000_000)); }

export interface SpendReport {
  since: string;
  coverageStarted: number | null;
  calls: number;
  completeCalls: number;
  estimatedMicros: number;
  reservedMicros: number;
  unknownCalls: number;
  unresolvedCalls: number;
  unknownSegments: number;
  /** Sum of available last snapshots; incomplete/retried calls remain explicitly unknown. */
  reportedUsage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  overrun: boolean;
}

function fold(records: SpendRecord[]): { calls: Map<string, Admission>; settled: Map<string, Settlement> } {
  const calls = new Map<string, Admission>(); const settled = new Map<string, Settlement>();
  for (const record of records) {
    if (record.type === "admit") {
      if (calls.has(record.call)) throw new SpendCapError("unavailable");
      calls.set(record.call, record);
    } else if (record.type === "settle") {
      const original = calls.get(record.call);
      if (!original || original.segment !== record.segment || settled.has(record.call)) throw new SpendCapError("unavailable");
      if (record.cost !== null && (!record.complete || record.usage === null || original.rates === null ||
        price(usageUsd(record.usage, original.rates)) !== record.cost)) throw new SpendCapError("unavailable");
      settled.set(record.call, record);
    }
  }
  return { calls, settled };
}

/** Bounded append-only accounting, serialized only among cooperating writers. */
export class SpendLedger {
  private readonly live = new Set<string>();
  private tail: Promise<void> = Promise.resolve();
  private waiting = 0;
  private observed = Buffer.alloc(0);
  constructor(readonly projectRoot: string, readonly clock: () => number = Date.now) {}

  private async paths(create: boolean): Promise<{ log: string; lock: string }> {
    if (await realpath(this.projectRoot) !== this.projectRoot) throw new SpendCapError("unavailable");
    const directory = join(this.projectRoot, ".agentrig");
    if (create) await mkdir(directory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    try {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) throw new SpendCapError("unavailable");
    } catch (error) { if (create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const paths = { log: join(directory, "usage.jsonl"), lock: join(directory, "usage.lock") };
    for (const path of Object.values(paths)) {
      try { const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new SpendCapError("unavailable"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return paths;
  }

  async records(): Promise<SpendRecord[]> {
    try { return await this.readRecords(false); } catch { throw new SpendCapError("unavailable"); }
  }
  private async readRecords(track: boolean): Promise<SpendRecord[]> {
    const { log } = await this.paths(false);
    let file;
    try { file = await open(log, "r"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && this.observed.length === 0) return []; throw new SpendCapError("unavailable"); }
    try {
      const stat = await file.stat(); const named = await lstat(log);
      if (!stat.isFile() || stat.dev !== named.dev || stat.ino !== named.ino || stat.size > BYTE_CAP) throw new SpendCapError("unavailable");
      const bytes = Buffer.alloc(BYTE_CAP + 1); let size = 0;
      while (size < bytes.length) { const r = await file.read(bytes, size, bytes.length - size, size); if (!r.bytesRead) break; size += r.bytesRead; }
      if (size > BYTE_CAP) throw new SpendCapError("unavailable");
      if (size < this.observed.length || !bytes.subarray(0, this.observed.length).equals(this.observed)) throw new SpendCapError("unavailable");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
      if (text && !text.endsWith("\n")) throw new SpendCapError("unavailable");
      const lines = text ? text.slice(0, -1).split("\n") : [];
      if (lines.length > RECORD_CAP || lines.some(line => Buffer.byteLength(line) > LINE_CAP)) throw new SpendCapError("unavailable");
      const records = lines.map(line => SpendRecordSchema.parse(JSON.parse(line)));
      fold(records); if (track) this.observed = Buffer.from(bytes.subarray(0, size)); return records;
    } finally { await file.close(); }
  }

  private async locked<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const deadline = performance.now() + 2000;
    if (this.waiting >= 64) throw new SpendCapError("unavailable");
    this.waiting++;
    const previous = this.tail; let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    try {
      await previous;
      signal?.throwIfAborted();
      if (performance.now() >= deadline) throw new SpendCapError("unavailable");
      const { lock } = await this.paths(true);
      let file;
      while (file === undefined) {
        signal?.throwIfAborted();
        try { file = await open(lock, "wx", 0o600); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST" || performance.now() >= deadline) throw new SpendCapError("unavailable");
          await new Promise<void>(resolve => setTimeout(resolve, 20));
        }
      }
      try { signal?.throwIfAborted(); return await work(); } finally { await file.close(); await unlink(lock); }
    } finally { this.waiting--; release(); }
  }

  private async append(record: SpendRecord, prior: SpendRecord[]): Promise<void> {
    const line = JSON.stringify(SpendRecordSchema.parse(record)) + "\n";
    const { log } = await this.paths(true);
    if (Buffer.byteLength(line) > LINE_CAP || prior.length >= RECORD_CAP) throw new SpendCapError("unavailable");
    const file = await open(log, "a", 0o600);
    try {
      const stat = await file.stat(); const named = await lstat(log);
      if (!stat.isFile() || stat.dev !== named.dev || stat.ino !== named.ino || stat.size !== this.observed.length || stat.size + Buffer.byteLength(line) > BYTE_CAP) throw new SpendCapError("unavailable");
      await file.writeFile(line); await file.sync();
      this.observed = Buffer.concat([this.observed, Buffer.from(line)]);
    } finally { await file.close(); }
  }

  async report(since: string, segment?: string): Promise<SpendReport> {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(since) || !Number.isFinite(Date.parse(since)) || day(Date.parse(since)) !== since) throw new Error("--since requires YYYY-MM-DD");
    const records = await this.records(); const { calls, settled } = fold(records);
    const result: SpendReport = { since, coverageStarted: records[0]?.ts ?? null, calls: 0, completeCalls: 0,
      estimatedMicros: 0, reservedMicros: 0, unknownCalls: 0, unresolvedCalls: 0,
      unknownSegments: new Set(records.filter(r => r.type === "gap" && (segment === undefined || r.segment === segment)).map(r => r.segment)).size,
      reportedUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, overrun: false };
    for (const call of calls.values()) {
      if (segment !== undefined && call.segment !== segment) continue;
      const final = settled.get(call.call);
      if (final?.cost !== null && final?.cost !== undefined && call.reserve !== null && final.cost > call.reserve) result.overrun = true;
      // Unresolved earlier-day calls remain visible; midnight cannot erase uncertainty.
      if (!final || !final.complete || final.cost === null) result.unresolvedCalls++;
      if (day(call.ts) < since) continue;
      result.calls++;
      if (final?.usage !== null && final?.usage !== undefined) {
        for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const)
          result.reportedUsage[key] = safe(result.reportedUsage[key] + (final.usage[key] ?? 0));
      }
      if (final?.complete && final.cost !== null) {
        result.completeCalls++; result.estimatedMicros = safe(result.estimatedMicros + final.cost);
      } else {
        result.unknownCalls++; result.reservedMicros = safe(result.reservedMicros + (call.reserve ?? 0));
      }
    }
    return result;
  }

  private gate(records: SpendRecord[], cap: number, reservation: number, ts = this.clock()): void {
    safe(cap); safe(reservation);
    if (records.some(record => record.type === "gap")) throw new SpendCapError("uncertain");
    const { calls, settled } = fold(records); let total = reservation;
    for (const call of calls.values()) {
      const final = settled.get(call.call);
      if ((!final || !final.complete || final.cost === null) && (!this.live.has(call.call) || day(call.ts) !== day(ts))) throw new SpendCapError("uncertain");
      if (final?.cost !== null && final?.cost !== undefined && call.reserve !== null && final.cost > call.reserve) throw new SpendCapError("uncertain");
      if (day(call.ts) === day(ts)) total = safe(total + (final?.cost ?? call.reserve ?? 0));
    }
    if (total > cap || (reservation === 0 && total >= cap)) throw new SpendCapError("exhausted");
  }

  async check(cap: number, signal?: AbortSignal): Promise<void> { await this.locked(async () => this.gate(await this.readRecords(true), cap, 0), signal); }

  async admit(input: Omit<Admission, "version" | "type" | "ts" | "call">, cap?: number, signal?: AbortSignal): Promise<Admission> {
    return this.locked(async () => {
      const records = await this.readRecords(true);
      const ts = this.clock();
      if (this.live.size >= 32) throw new SpendCapError("unavailable");
      if (cap !== undefined) {
        if (input.reserve === null || input.rates === null) throw new SpendCapError("unsupported");
        this.gate(records, cap, input.reserve, ts);
      }
      const record: Admission = { ...input, version: 1, type: "admit", ts, call: randomUUID() };
      await this.append(record, records); this.live.add(record.call); return record;
    }, signal);
  }

  async settle(call: Admission, value: Settlement["usage"], complete: boolean): Promise<void> {
    try {
      await this.locked(async () => {
        const records = await this.readRecords(true); const state = fold(records);
        if (!this.live.has(call.call) || state.settled.has(call.call)) throw new SpendCapError("unavailable");
        const original = state.calls.get(call.call);
        if (original === undefined) throw new SpendCapError("unavailable");
        const cost = complete && value !== null && original.rates !== null ? price(usageUsd(value, original.rates)) : null;
        await this.append({ version: 1, type: "settle", ts: this.clock(), segment: original.segment, call: call.call, usage: value, complete, cost }, records);
      });
    } finally { this.live.delete(call.call); }
  }

  async end(segment: string, session?: string): Promise<void> {
    await this.locked(async () => this.append({ version: 1, type: "end", ts: this.clock(), segment, session: session ?? null }, await this.readRecords(true)));
  }
  async gap(segment: string, session?: string, reason: "unmetered-provider" | "accounting-unavailable" = "unmetered-provider"): Promise<void> {
    await this.locked(async () => this.append({ version: 1, type: "gap", ts: this.clock(), segment, session: session ?? null, reason }, await this.readRecords(true)));
  }
}

export interface SpendMeterOptions {
  segment: string;
  pricing?: Pricing;
  capMicros?: number;
  /** Trusted host assertion, never taken from provider/model response fields. */
  boundedProvider?: boolean;
  onError?: (error: SpendCapError) => void;
  onUnavailable?: () => void;
}
const meters = new WeakMap<ModelProvider, { ledger: SpendLedger; capMicros: number | undefined }>();
export function hasSpendMeter(provider: ModelProvider, ledger: SpendLedger, capMicros?: number): boolean {
  const meter = meters.get(provider); return meter?.ledger === ledger && meter.capMicros === capMicros;
}
export function assertSpendMeter(provider: ModelProvider, ledger: SpendLedger, capMicros?: number): void {
  if (!hasSpendMeter(provider, ledger, capMicros)) throw new SpendCapError("unsupported");
}

/** Wrap once at construction, before sharing the provider with any call lane. */
export function meterProvider(provider: ModelProvider, ledger: SpendLedger, options: SpendMeterOptions): ModelProvider {
  if (meters.has(provider)) throw new Error("provider is already metered; reuse its existing wrapper");
  const pricing = options.pricing === undefined ? null : rates.parse({ ...options.pricing,
    cacheReadUsdPerMTok: options.pricing.cacheReadUsdPerMTok ?? options.pricing.inputUsdPerMTok * (provider.capabilities.cacheReadDiscount ?? 1),
    cacheWriteUsdPerMTok: options.pricing.cacheWriteUsdPerMTok ?? options.pricing.inputUsdPerMTok * (provider.capabilities.cacheWriteMultiplier ?? 1) });
  if (options.capMicros !== undefined && (!options.boundedProvider || pricing === null)) throw new SpendCapError("unsupported");
  const wrapped: ModelProvider = { id: provider.id, model: provider.model, capabilities: provider.capabilities,
    ...(provider.validateHistory === undefined ? {} : { validateHistory: (messages) => provider.validateHistory!(messages) }),
    ...(provider.countTokens === undefined ? {} : { countTokens: provider.countTokens.bind(provider) }),
    async *stream(request, signal) {
      provider.validateHistory?.(request.messages);
      const context = currentSpend();
      const active = context?.ledger === ledger ? context : undefined;
      const unavailable = async (): Promise<void> => {
        if (active !== undefined) { if (active.onUnavailable !== undefined) await active.onUnavailable(); else active.unavailable = true; }
        else if (options.onUnavailable === undefined) console.warn("spend accounting unavailable; model execution is uncapped and usage coverage is unknown");
        options.onUnavailable?.();
      };
      let call: Admission;
      try {
        if (signal.aborted) throw signal.reason;
        const context = safe(provider.capabilities.contextWindow); const output = safe(request.maxTokens);
        if (context === 0 || output === 0) throw new SpendCapError("unsupported");
        const reserve = pricing === null ? null : price((context * Math.max(pricing.inputUsdPerMTok, pricing.cacheReadUsdPerMTok, pricing.cacheWriteUsdPerMTok)
          + output * pricing.outputUsdPerMTok) / 1_000_000);
        call = await ledger.admit({ segment: active?.segment ?? options.segment, ...(active?.session === undefined ? {} : { session: active.session }), model: provider.model, provider: provider.id, reserve, rates: pricing }, options.capMicros, signal);
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        const failure = error instanceof SpendCapError ? error : new SpendCapError("unavailable");
        if (options.capMicros === undefined) {
          await unavailable();
          try { await ledger.gap(active?.segment ?? options.segment, active?.session, "accounting-unavailable"); } catch { /* warned: no durable accounting claim */ }
          yield* provider.stream(request, signal); return;
        }
        options.onError?.(failure); await active?.onCap?.(failure); throw failure;
      }
      let last: Settlement["usage"] = null; let reported = false; let stopped = false; let uncertain = false; let ended = false;
      try {
        signal.throwIfAborted();
        for await (const event of provider.stream(request, signal)) {
          if (event.type === "usage") { last = usage.parse(event.usage); reported = event.reported !== false; }
          if (event.type === "retry") uncertain = true;
          if (event.type === "stop") { stopped = true; if (event.reason === "error") uncertain = true; }
          yield event;
        }
        ended = true;
      } finally {
        try { await ledger.settle(call, last, ended && stopped && reported && !uncertain && !signal.aborted); }
        catch {
          if (options.capMicros === undefined) { await unavailable(); }
          else { const error = new SpendCapError("unavailable"); options.onError?.(error); await active?.onCap?.(error); throw error; }
        }
      }
    } };
  meters.set(wrapped, { ledger, capMicros: options.capMicros });
  return wrapped;
}
