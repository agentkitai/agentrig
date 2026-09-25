import { SpendRecordSchema, type SpendRecord } from "./spend-ledger.js";

export interface UsageTotals {
  calls: number; input: number; output: number; cacheRead: number; cacheWrite: number;
  /** Priced subset only; null means no priced calls, never free usage. */
  estimatedMicros: number | null; unpricedCalls: number; incompleteCalls: number;
}
export interface RowUsage {
  row: string; totals: UsageTotals; coverageWarnings: string[];
  sessions: Array<{ session: string; builderProvider: string | null; totals: UsageTotals; models: Array<UsageTotals & { provider: string; model: string }> }>;
}
const empty = (): UsageTotals => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimatedMicros: null, unpricedCalls: 0, incompleteCalls: 0 });
function add(target: UsageTotals, source: UsageTotals): void {
  for (const key of ["calls", "input", "output", "cacheRead", "cacheWrite", "unpricedCalls", "incompleteCalls"] as const) target[key] += source[key];
  if (source.estimatedMicros !== null) target.estimatedMicros = (target.estimatedMicros ?? 0) + source.estimatedMicros;
}
/** Join by call, then session/model; traverse spawn ancestry rather than counting child costs twice. */
export function rollupTrainUsage(records: SpendRecord[], rows: Array<{ row: string; sessions: string[] }>, spawns: Array<{ parent: string; child: string; provider?: string }>): RowUsage[] {
  // Propagate every claim to a fixed point before accounting. A conflicting parent
  // contaminates its descendants too, regardless of edge order or cycles.
  const owners = new Map<string, Set<string>>();
  const assign = (session: string, row: string): boolean => {
    let claims = owners.get(session);
    if (claims === undefined) { claims = new Set(); owners.set(session, claims); }
    const added = !claims.has(row); claims.add(row); return added;
  };
  for (const row of rows) for (const session of row.sessions) assign(session, row.row);
  let changed = true;
  while (changed) {
    changed = false;
    for (const spawn of spawns) for (const row of owners.get(spawn.parent) ?? []) changed = assign(spawn.child, row) || changed;
  }
  const admissions = new Map<string, Extract<SpendRecord, { type: "admit" }>>();
  const settlements = new Map<string, Extract<SpendRecord, { type: "settle" }>>();
  for (const raw of records) {
    const record = SpendRecordSchema.parse(raw);
    if (record.type !== "admit" && record.type !== "settle") continue;
    const prior = record.type === "admit" ? admissions.get(record.call) : settlements.get(record.call);
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(record)) throw new Error(`conflicting usage call ${record.call}`);
    if (record.type === "admit") admissions.set(record.call, record); else settlements.set(record.call, record);
  }
  return rows.map(row => {
    const coverageWarnings: string[] = [];
    for (const [session, claims] of owners) if (claims.size > 1 && claims.has(row.row)) {
      coverageWarnings.push(`ambiguous session ${session} claimed by multiple rows (${[...claims].sort().join(", ")}); excluded`);
    }
    for (const record of records) if (record.type === "gap" && record.session !== null && owners.get(record.session)?.has(row.row)) {
      coverageWarnings.push(`session ${record.session}: ledger coverage gap; row totals exclude unmetered calls`);
    }
    const sessions = new Map<string, Map<string, UsageTotals & { provider: string; model: string }>>();
    // Include children that have not made a metered call yet. Never infer actual routing from row intent.
    for (const [session, claims] of owners) if (claims.size === 1 && claims.has(row.row)) sessions.set(session, new Map());
    for (const admission of admissions.values()) {
      if (admission.session === undefined || (owners.get(admission.session)?.size !== 1 || !owners.get(admission.session)?.has(row.row))) continue;
      let models = sessions.get(admission.session);
      if (models === undefined) { models = new Map(); sessions.set(admission.session, models); }
      const key = JSON.stringify([admission.provider, admission.model]);
      let model = models.get(key);
      if (model === undefined) { model = { ...empty(), provider: admission.provider, model: admission.model }; models.set(key, model); }
      const settled = settlements.get(admission.call);
      if (settled !== undefined && settled.segment !== admission.segment) throw new Error(`usage segment mismatch ${admission.call}`);
      const priced = admission.provider !== "openai-chatgpt" && admission.rates !== null && settled?.complete === true && settled.cost !== null;
      add(model, { ...empty(), ...settled?.usage, cacheRead: settled?.usage?.cacheRead ?? 0, cacheWrite: settled?.usage?.cacheWrite ?? 0, calls: 1, estimatedMicros: priced ? settled!.cost : null,
        unpricedCalls: priced ? 0 : 1, incompleteCalls: settled?.complete === true ? 0 : 1 });
    }
    const totals = empty();
    const grouped = [...sessions].sort(([a], [b]) => a.localeCompare(b)).map(([session, models]) => ({ session, builderProvider: spawns.find(spawn => spawn.child === session)?.provider ?? null, totals: empty(), models: [...models.values()].sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`)) }));
    for (const session of grouped) for (const model of session.models) { add(totals, model); add(session.totals, model); }
    return { row: row.row, totals, sessions: grouped, coverageWarnings };
  });
}
