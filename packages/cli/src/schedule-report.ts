import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { Usage, usageUsd, type AuxiliaryReport, type HarnessEvent, type Pricing } from "@agentkitai/agentrig-core";

const Count = z.number().int().nonnegative().safe();
const Money = z.number().finite().nonnegative().nullable();
const Meter = z.object({ usage: Usage.nullable(), complete: z.boolean(), costUsd: Money }).strict();
export const ScheduledAccounting = z.object({ main: Meter, auxiliary: Meter, coverage: z.enum(["complete", "partial"]), costUsd: Money }).strict();
export type ScheduledAccounting = z.infer<typeof ScheduledAccounting>;
export const ScheduleReceipt = z.object({
  version: z.literal(1), seq: Count.positive(), ts: Count.max(8_640_000_000_000_000), minute: Count,
  entry: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u), source: z.enum(["schedule", "heartbeat"]),
  sessionId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u).nullable(),
  // Includes startup hook/MCP/skill failures as well as session-end maintenance failures.
  outcome: z.enum(["done", "budget", "aborted", "error"]), maintenanceFailed: z.boolean(),
  accounting: ScheduledAccounting.nullable(),
}).strict();
export type ScheduleReceipt = z.infer<typeof ScheduleReceipt>;
export type ReceiptInput = Omit<ScheduleReceipt, "version" | "seq">;
export interface FailureNotice { through: number; failures: number; omitted: boolean; uncertain: boolean; since: number | null; text: string | null }
const CAP = 512 * 1024;
const RETAIN = 512;
const Ack = z.object({ version: z.literal(1), through: Count }).strict();
const Uncertain = z.object({ version: z.literal(1), uncertain: z.literal(true) }).strict();
const uncertaintyText = "Scheduled outcome receipts are missing or uncertain. Stop scheduler writers, inspect raw session logs, then remove only .agentrig/schedule-report-uncertain.json. Do not retry model execution.";
function decode<T>(schema: z.ZodType<T>, text: string, kind: string): T {
  try { return schema.parse(JSON.parse(text)); }
  catch {
    const file = kind === "acknowledgement" ? "schedule.ack.json" : kind === "receipt" ? "schedule.log" : "schedule-report-uncertain.json";
    throw new Error(`malformed scheduled ${kind}; retained without overwrite; stop writers and inspect .agentrig/${file}`);
  }
}

/** Operational retention only. Cooperating writers, not an attestation of external edits. */
export class ScheduleReports {
  constructor(readonly projectRoot: string) {}

  private async paths(create: boolean) {
    if (await realpath(this.projectRoot) !== this.projectRoot) throw new Error("reports require canonical project root");
    const dir = join(this.projectRoot, ".agentrig");
    if (create) await mkdir(dir, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    try { const s = await lstat(dir); if (!s.isDirectory() || s.isSymbolicLink() || await realpath(dir) !== dir) throw new Error("unsafe report directory"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const paths = { dir, log: join(dir, "schedule.log"), ack: join(dir, "schedule.ack.json"), lock: join(dir, "schedule-report.lock"), uncertain: join(dir, "schedule-report-uncertain.json") };
    for (const path of [paths.log, paths.ack, paths.lock, paths.uncertain]) {
      try { const s = await lstat(path); if (!s.isFile() || s.isSymbolicLink()) throw new Error("unsafe report file"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return paths;
  }

  private async readFile(path: string, cap: number): Promise<string | null> {
    let file;
    try { file = await open(path, "r"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error(`cannot read scheduled state .agentrig/${basename(path)}; stop writers and inspect access permissions`, { cause: error });
    }
    try {
      const bytes = Buffer.alloc(cap + 1); let size = 0;
      while (size < bytes.length) { const r = await file.read(bytes, size, bytes.length - size, size); if (r.bytesRead === 0) break; size += r.bytesRead; }
      if (size > cap) throw new Error("scheduled report state exceeds its byte bound");
      try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)); }
      catch { throw new Error(`invalid UTF-8 in scheduled state .agentrig/${basename(path)}; retained without overwrite`); }
    } finally { await file.close(); }
  }

  private async state() {
    const paths = await this.paths(false);
    const text = await this.readFile(paths.log, CAP);
    const lines = text === null ? [] : text.trimEnd().split("\n");
    if (lines.length > RETAIN || lines.some(line => Buffer.byteLength(line) + 1 > 1024)) throw new Error("scheduled report retention/line bound exceeded");
    const receipts = lines.map(line => decode(ScheduleReceipt, line, "receipt"));
    for (let i = 1; i < receipts.length; i++) if (receipts[i]!.seq !== receipts[i - 1]!.seq + 1) throw new Error("scheduled report sequence gap");
    const ackText = await this.readFile(paths.ack, 1024);
    const through = ackText === null ? 0 : decode(Ack, ackText, "acknowledgement").through;
    if (through > (receipts.at(-1)?.seq ?? 0)) throw new Error("scheduled acknowledgement exceeds available history");
    return { paths, receipts, through };
  }

  private async replace(path: string, text: string) {
    const paths = await this.paths(true);
    const temporary = join(paths.dir, `.schedule-report-${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(text); await file.sync(); await file.close(); await rename(temporary, path); }
    finally { await file.close(); await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  }

  private async locked<T>(work: () => Promise<T>): Promise<T> {
    const { lock } = await this.paths(true);
    let file;
    try { file = await open(lock, "wx", 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("scheduled reports busy; stop writers before recovering .agentrig/schedule-report.lock; acknowledgement is .agentrig/schedule.ack.json"); throw error; }
    try { return await work(); } finally { await file.close(); await unlink(lock); }
  }

  async append(input: ReceiptInput): Promise<ScheduleReceipt> {
    return this.locked(async () => {
      const { paths, receipts } = await this.state();
      const receipt = ScheduleReceipt.parse({ ...input, version: 1, seq: (receipts.at(-1)?.seq ?? 0) + 1 });
      const line = JSON.stringify(receipt) + "\n";
      if (Buffer.byteLength(line) > 1024) throw new Error("scheduled receipt exceeds one KiB");
      const retained = [...receipts, receipt].slice(-RETAIN);
      await this.replace(paths.log, retained.map(item => JSON.stringify(item) + "\n").join(""));
      return receipt;
    });
  }

  async notice(): Promise<FailureNotice> {
    // No state directory is created when there is no log to inspect.
    const paths = await this.paths(false);
    const marker = await this.readFile(paths.uncertain, 512);
    const uncertain = marker !== null;
    if (marker !== null) decode(Uncertain, marker, "uncertainty marker");
    const logExists = await lstat(paths.log).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
    if (!logExists) {
      const ack = await this.readFile(paths.ack, 1024);
      if (ack !== null && decode(Ack, ack, "acknowledgement").through > 0) throw new Error("scheduled log missing for acknowledged history");
      return { through: 0, failures: 0, omitted: false, uncertain, since: null, text: uncertain ? uncertaintyText : null };
    }
    return this.locked(async () => {
      const { receipts, through } = await this.state();
      const pending = receipts.filter(item => item.seq > through);
      const failed = pending.filter(item => item.outcome !== "done" || item.maintenanceFailed);
      const omitted = (receipts[0]?.seq ?? 1) > through + 1;
      const since = failed[0]?.ts ?? null;
      const countText = omitted && failed.length === 0 ? "Scheduled failure count is unknown"
        : `${omitted ? "At least " : ""}${failed.length} scheduled runs failed`;
      const failureText = failed.length === 0 && !omitted ? null : `${countText}${since === null ? "" : ` since ${new Date(since).toISOString()}`}.${omitted ? " Earlier unacknowledged history was omitted; failure count is incomplete." : ""} See .agentrig/schedule.log.`;
      const text = uncertain ? `${failureText === null ? "" : failureText + " "}${uncertaintyText}` : failureText;
      return { through: receipts.at(-1)?.seq ?? 0, failures: failed.length, omitted, uncertain, since, text };
    });
  }

  async acknowledge(through: number): Promise<void> {
    await this.locked(async () => {
      const state = await this.state(); Count.parse(through);
      if (through > (state.receipts.at(-1)?.seq ?? 0)) throw new Error("cannot acknowledge unseen scheduled reports");
      await this.replace(state.paths.ack, JSON.stringify({ version: 1, through: Math.max(state.through, through) }) + "\n");
    });
  }

  /** Exclusive creation needs no report lock. Never automatically clear a concurrent failure. */
  async markUncertain(): Promise<void> {
    const { uncertain } = await this.paths(true);
    let file;
    try { file = await open(uncertain, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await this.readFile(uncertain, 512);
      decode(Uncertain, existing ?? "null", "uncertainty marker"); return;
    }
    try { await file.writeFile(JSON.stringify({ version: 1, uncertain: true }) + "\n"); await file.sync(); }
    finally { await file.close(); }
  }
}

/** Bounded streaming accounting, not a reconstructed spend ledger. */
export class ScheduledUsage {
  private requests = 0; private pending = 0; private mainComplete = true; private partial = false;
  private ingestSettled = false;
  private ingestMissing = false;
  constructor(private readonly ingestExpected = false, otherUntrackedWork = false) { this.partial = otherUntrackedWork; }
  private auxiliary = new Map<string, { usage: z.infer<typeof Usage>; complete: boolean; costUsd: number | null; failed: boolean }>();
  observe(event: HarnessEvent): void {
    if (event.type === "model.request") { this.requests++; this.pending++; }
    if (event.type === "model.response") { this.pending--; if (event.usageComplete !== true) this.mainComplete = false; }
    if (event.type === "subagent.spawn" || event.type === "context.compact") this.partial = true;
    if (event.type !== "auxiliary.usage") return;
    this.record(`event:${event.id}`, event.report, event.final);
  }
  ingest(report: AuxiliaryReport | undefined, final: boolean): void {
    if (final) this.ingestSettled = true;
    if (report === undefined) { this.ingestMissing = true; this.partial = true; return; }
    this.record("hook:ingest", report, final);
  }
  private record(id: string, r: AuxiliaryReport, final: boolean): void {
    if (!this.auxiliary.has(id) && this.auxiliary.size >= 128) { this.partial = true; return; }
    this.auxiliary.set(id, { usage: { ...r.reportedUsage }, complete: final && r.unknownUsageCalls === 0 && r.calls.every(call => call.usageComplete), costUsd: r.costUsd, failed: r.outcome !== "completed" });
  }
  finish(usage: z.infer<typeof Usage>, pricing: Pricing | undefined, maintenanceFailed: boolean, cacheReadDiscount = 1, cacheWriteMultiplier = 1): ScheduledAccounting {
    const mainComplete = this.mainComplete && this.requests > 0 && this.pending === 0;
    const mainCost = mainComplete && pricing !== undefined ? usageUsd(usage, pricing, cacheReadDiscount, cacheWriteMultiplier) : null;
    const auxiliaryUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let auxiliaryComplete = !this.partial && !maintenanceFailed && (!this.ingestExpected || this.ingestSettled); let auxiliaryCost: number | null = 0;
    for (const item of this.auxiliary.values()) {
      auxiliaryUsage.input += item.usage.input; auxiliaryUsage.output += item.usage.output;
      auxiliaryUsage.cacheRead += item.usage.cacheRead ?? 0; auxiliaryUsage.cacheWrite += item.usage.cacheWrite ?? 0;
      auxiliaryComplete &&= item.complete;
      auxiliaryCost = auxiliaryCost === null || item.costUsd === null ? null : auxiliaryCost + item.costUsd;
    }
    const complete = mainComplete && auxiliaryComplete && !this.partial;
    return ScheduledAccounting.parse({ main: { usage, complete: mainComplete, costUsd: mainCost },
      auxiliary: { usage: auxiliaryUsage, complete: auxiliaryComplete, costUsd: auxiliaryComplete ? auxiliaryCost : null },
      coverage: complete ? "complete" : "partial", costUsd: complete && mainCost !== null && auxiliaryCost !== null ? mainCost + auxiliaryCost : null });
  }
  get failed(): boolean { return this.ingestExpected && (!this.ingestSettled || this.ingestMissing) || [...this.auxiliary.values()].some(item => item.failed); }
}
