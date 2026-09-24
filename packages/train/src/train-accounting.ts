import { SpendLedger } from "@agentkitai/agentrig-core";
import { SessionStore } from "@agentkitai/agentrig-core";
import { rollupTrainUsage, type RowUsage } from "./train-usage.js";
import { TrainRowSchema, TrainStateSchema } from "./index.js";
import { realpath, lstat, readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
const folders = ["queue", "active", "done", "halted", "logs"] as const;
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
async function regular(path: string): Promise<void> { if (!(await lstat(path)).isFile()) throw new Error("row/receipt must be a regular non-symlink file"); }
async function json(path: string): Promise<unknown> { await regular(path); if ((await lstat(path)).size > 65536) throw new Error("JSON exceeds 64 KiB"); return JSON.parse(await readFile(path, "utf8")) as unknown; }
function rowName(name: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9_-]*\.json$/u.test(name); }
/** Read append-only ledger and recursively follow spawn records, never rewrite either. */
export async function trainUsage(directory: string): Promise<Array<RowUsage & { coverageWarnings: string[] }>> {
  const root = resolve(directory);
  const rows: Array<{ row: string; sessions: string[] }> = [];
  const ledgers = new Map<string, Awaited<ReturnType<SpendLedger["records"]>>>();
  const groups = new Map<string, { rows: typeof rows; providers: Map<string, string>; spawns: Array<{ parent: string; child: string }> }>();
  const warnings = new Map<string, string[]>();
  const identities = new Set<string>();
  for (const folder of folders.slice(0, 4)) {
    for (const name of await readdir(join(root, folder)).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; })) {
      if (!rowName(name)) continue;
      if (identities.has(name)) throw new Error(`duplicate row identity: ${name.slice(0, -5)}`);
      identities.add(name);
      const row = TrainRowSchema.parse(await json(join(root, folder, name)));
      const stem = name.slice(0, -5);
      const statePath = join(root, "logs", `${stem}.state.json`);
      const sessions = await exists(statePath) ? TrainStateSchema.parse(await json(statePath)).sessionIds : [];
      rows.push({ row: stem, sessions });
      const checkout = await realpath(row.environment.checkout);
      if (!ledgers.has(checkout)) ledgers.set(checkout, await new SpendLedger(checkout).records());
      let group = groups.get(checkout);
      if (group === undefined) { group = { rows: [], providers: new Map(), spawns: [] }; groups.set(checkout, group); }
      group.rows.push({ row: stem, sessions });
      const rowWarnings: string[] = [];
      warnings.set(stem, rowWarnings);
      const store = new SessionStore({ root: row.environment.sessionRoot ?? join(root, "logs", "sessions") });
      const visited = new Set<string>();
      const pending = [...sessions];
      for (let index = 0; index < pending.length; index++) {
        const session = pending[index]!;
        if (visited.has(session)) continue;
        visited.add(session);
        if (visited.size > 10000) throw new Error("train usage session bound exceeded");
        try {
          const prefix = await store.readPrefix(session);
          if (prefix.torn) rowWarnings.push(`torn spawn log tail: ${session}; valid prefix used, descendants may be unattributed`);
          for (const event of prefix.events) if (event.type === "context.manifest" && event.providerSelection !== undefined) {
            group.providers.set(session, event.providerSelection.entry);
          }
          for (const event of prefix.events) if (event.type === "subagent.spawn") {
            group.spawns.push({ parent: session, child: event.id }); pending.push(event.id);
          }
        } catch (error) {
          const kind = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
          rowWarnings.push(`${kind} spawn log: ${session}; descendants may be unattributed`);
        }
      }
    }
  }
  const reports = new Map<string, RowUsage>();
  for (const [checkout, group] of groups) {
    const records = ledgers.get(checkout)!;
    const ledgerWarnings: string[] = [];
    const gaps = records.filter(record => record.type === "gap" && record.session === null).length;
    const claimed = new Set(group.rows.flatMap(row => row.sessions));
    let changed = true;
    while (changed) {
      changed = false;
      for (const spawn of group.spawns) if (claimed.has(spawn.parent) && !claimed.has(spawn.child)) { claimed.add(spawn.child); changed = true; }
    }
    const unclaimedGaps = records.filter(record => record.type === "gap" && record.session !== null && !claimed.has(record.session)).length;
    if (unclaimedGaps > 0) ledgerWarnings.push(`ledger-wide (${checkout}): ${unclaimedGaps} coverage gap(s) for unclaimed sessions; not assignable to a row`);
    const unattributed = records.filter(record => record.type === "admit" && record.session === undefined).length;
    if (gaps > 0) ledgerWarnings.push(`ledger-wide (${checkout}): ${gaps} coverage gap(s) without session attribution; not assignable to a row`);
    if (unattributed > 0) ledgerWarnings.push(`ledger-wide (${checkout}): ${unattributed} call(s) without session attribution excluded`);
    for (const row of rollupTrainUsage(records, group.rows, group.spawns, group.providers)) {
      reports.set(row.row, { ...row, coverageWarnings: [...row.coverageWarnings, ...warnings.get(row.row)!, ...ledgerWarnings] });
    }
  }
  return rows.map(row => reports.get(row.row)!);
}

