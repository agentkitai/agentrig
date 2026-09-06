import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]] as const;

function cronFields(expression: string): Set<number>[] {
  const fields = expression.trim().split(/\s+/u);
  if (fields.length !== 5 || expression.length > 128) throw new Error("expected five bounded UTC cron fields");
  return fields.map((field, index) => {
    const [min, max] = RANGES[index]!;
    const values = new Set<number>();
    for (const component of field.split(",")) {
      const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/u.exec(component);
      if (!match) throw new Error("unsupported cron grammar");
      const base = match[1]!;
      const step = match[2] === undefined ? 1 : Number(match[2]);
      if (!Number.isSafeInteger(step) || step < 1 || step > max - min + 1 || (match[2] !== undefined && base !== "*" && !base.includes("-"))) throw new Error("invalid cron step");
      const endpoints = base === "*" ? [min, max] : base.split("-").map(Number);
      const first = endpoints[0]!;
      const last = endpoints[1] ?? first;
      if (first < min || last > max || first > last) throw new Error("cron value outside field range");
      for (let value = first; value <= last; value += step) values.add(value);
    }
    return values;
  });
}

export function cronDue(expression: string, date: Date): boolean {
  if (!Number.isFinite(date.getTime())) throw new Error("invalid scheduler clock");
  const fields = cronFields(expression);
  const parts = expression.trim().split(/\s+/u);
  const dom = fields[2]!.has(date.getUTCDate());
  const dow = fields[4]!.has(date.getUTCDay());
  const day = parts[2] === "*" ? dow : parts[4] === "*" ? dom : dom || dow;
  return fields[0]!.has(date.getUTCMinutes()) && fields[1]!.has(date.getUTCHours()) && fields[3]!.has(date.getUTCMonth() + 1) && day;
}

export const ScheduleFlagsSchema = z.object({
  maxTurns: z.number().int().min(1).max(50).default(5),
  maxTokens: z.number().int().min(1).max(100_000).default(10_000),
  maxMinutes: z.number().int().min(1).max(30).default(5),
}).strict();
export const ScheduleEntrySchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u),
  cron: z.string().max(128).refine(value => { try { cronFields(value); return true; } catch { return false; } }, "invalid five-field UTC cron"),
  task: z.string().min(1).max(8_192).refine(value => value.trim().length > 0),
  flags: ScheduleFlagsSchema.default({}),
  lastClaimedMinute: z.number().int().nonnegative().safe().optional(),
}).strict();
export type ScheduleEntry = z.output<typeof ScheduleEntrySchema>;
const TableSchema = z.object({ version: z.literal(1), entries: z.array(ScheduleEntrySchema).max(100), lastHeartbeatMinute: z.number().int().nonnegative().safe().optional() }).strict()
  .refine(table => new Set(table.entries.map(entry => entry.id)).size === table.entries.length, "duplicate schedule IDs");
type Table = z.output<typeof TableSchema>;
const BYTE_CAP = 256 * 1024;
export interface Heartbeat { task: string; empty: boolean }
export type ScheduleLaunch = ScheduleEntry & { heartbeat?: "empty" | "checklist" };

/** Cooperative command lock, not protection against external path replacement races. */
export class ScheduleStore {
  constructor(readonly projectRoot: string) {}

  private async paths(create: boolean): Promise<{ directory: string; table: string; lock: string }> {
    if (await realpath(this.projectRoot) !== this.projectRoot) throw new Error("scheduler requires canonical project root");
    const directory = join(this.projectRoot, ".agentrig");
    if (create) {
      try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    try {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) throw new Error("unsafe scheduler directory");
    } catch (error) { if (create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const table = join(directory, "schedule.json");
    const lock = join(directory, "schedule.lock");
    for (const path of [table, lock]) {
      try { const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe scheduler file"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return { directory, table, lock };
  }

  async read(): Promise<Table> {
    const { table } = await this.paths(false);
    let handle;
    try { handle = await open(table, "r"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, entries: [] }; throw error; }
    try {
      const bytes = Buffer.alloc(BYTE_CAP + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, length);
        if (result.bytesRead === 0) break;
        length += result.bytesRead;
      }
      if (length > BYTE_CAP) throw new Error("schedule table exceeds 256 KiB");
      return TableSchema.parse(JSON.parse(bytes.subarray(0, length).toString("utf8")));
    } finally { await handle.close(); }
  }

  async heartbeat(): Promise<Heartbeat | null> {
    await this.paths(false);
    const path = join(this.projectRoot, "HEARTBEAT.md");
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || await realpath(path) !== path) throw new Error("unsafe HEARTBEAT.md");
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    const file = await open(path, "r");
    try {
      const bytes = Buffer.alloc(4097); let length = 0;
      while (length < bytes.length) {
        const result = await file.read(bytes, length, bytes.length - length, length);
        if (result.bytesRead === 0) break;
        length += result.bytesRead;
      }
      if (length > 4096) throw new Error("HEARTBEAT.md exceeds 4096 bytes");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
      const empty = text.trim() === "";
      return { empty, task: empty ? "HEARTBEAT.md is empty. Nothing applies; stop after this one tool-free turn."
        : `Work through this advisory HEARTBEAT.md checklist; stop when nothing applies. Do not invent work or produce a report when nothing applies.\n\n${text}` };
    } finally { await file.close(); }
  }

  private async write(table: Table): Promise<void> {
    const bytes = JSON.stringify(TableSchema.parse(table), null, 2) + "\n";
    if (Buffer.byteLength(bytes) > BYTE_CAP) throw new Error("schedule table exceeds 256 KiB");
    const paths = await this.paths(true);
    const temporary = join(paths.directory, `.schedule-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes); await handle.sync(); await handle.close();
      await rename(temporary, paths.table);
    } finally { await handle.close(); await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
  }

  private async locked<T>(work: () => Promise<T>): Promise<T> {
    const { lock } = await this.paths(true);
    let handle;
    try { handle = await open(lock, "wx", 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`scheduler busy; never remove ${lock} until all writers have stopped`); throw error; }
    try { return await work(); } finally { await handle.close(); await unlink(lock); }
  }

  async add(input: unknown): Promise<void> {
    const entry = ScheduleEntrySchema.omit({ lastClaimedMinute: true }).parse(input);
    await this.locked(async () => {
      const table = await this.read();
      if (table.entries.some(existing => existing.id === entry.id)) throw new Error("schedule ID already exists");
      table.entries.push(entry); await this.write(table);
    });
  }

  async remove(id: string): Promise<void> {
    await this.locked(async () => {
      const table = await this.read();
      if (!table.entries.some(entry => entry.id === id)) throw new Error("unknown schedule ID");
      table.entries = table.entries.filter(entry => entry.id !== id); await this.write(table);
    });
  }

  async tick(date: Date, execute?: (entry: ScheduleLaunch, minute: number) => Promise<void>, signal?: AbortSignal, heartbeatTurns?: number): Promise<string[]> {
    const minute = Math.floor(date.getTime() / 60_000);
    if (!Number.isSafeInteger(minute) || minute < 0) throw new Error("invalid scheduler clock");
    const work = async (): Promise<string[]> => {
      const table = await this.read();
      if (heartbeatTurns !== undefined && (!Number.isInteger(heartbeatTurns) || heartbeatTurns < 1 || heartbeatTurns > 50)) throw new Error("heartbeat turns must be 1–50");
      const due = table.entries.filter(entry => (entry.lastClaimedMinute ?? -1) < minute && cronDue(entry.cron, date));
      if (due.length > 10) throw new Error("more than 10 schedules due; no entries launched");
      for (const entry of due) {
        signal?.throwIfAborted();
        if (execute === undefined) continue;
        entry.lastClaimedMinute = minute;
        await this.write(table);
        await execute(structuredClone(entry), minute);
      }
      if (heartbeatTurns !== undefined && !table.entries.some(entry => cronDue(entry.cron, date)) && (table.lastHeartbeatMinute ?? -1) < minute) {
        signal?.throwIfAborted();
        const heartbeat = await this.heartbeat();
        if (heartbeat !== null) {
          if (execute !== undefined) {
            table.lastHeartbeatMinute = minute;
            await this.write(table);
            await execute({ id: "heartbeat", cron: "* * * * *", task: heartbeat.task,
              flags: ScheduleFlagsSchema.parse({ maxTurns: heartbeat.empty ? 1 : heartbeatTurns }),
              heartbeat: heartbeat.empty ? "empty" : "checklist" }, minute);
          }
          return ["heartbeat"];
        }
      }
      return due.map(entry => entry.id);
    };
    return execute === undefined ? work() : this.locked(work);
  }
}
