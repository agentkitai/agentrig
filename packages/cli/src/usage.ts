import { trainUsage } from "@agentkitai/agentrig-train/runtime";
import { SpendLedger, type SpendReport, type SessionSpendSource } from "@agentkitai/agentrig-core";
import { realpath } from "node:fs/promises";

export function formatSpend(report: SpendReport): string {
  return `Configured estimate since ${report.since}: $${(report.estimatedMicros / 1_000_000).toFixed(6)}; ` +
    `$${(report.reservedMicros / 1_000_000).toFixed(6)} reserved; ${report.completeCalls}/${report.calls} calls priced; ` +
    `${report.unresolvedCalls} unresolved calls and ${report.unknownSegments} unmetered segments (including earlier days)${report.overrun ? "; reservation overrun" : ""}.\n` +
    `Available token snapshots: input ${report.reportedUsage.input}, output ${report.reportedUsage.output}, cache-read ${report.reportedUsage.cacheRead}, cache-write ${report.reportedUsage.cacheWrite}; unknown coverage is not zero.\n` +
    `Coverage starts ${report.coverageStarted === null ? "not yet recorded" : new Date(report.coverageStarted).toISOString()}; earlier spend and external services unknown. Not an invoice/billing guarantee.`;
}

export async function costLines(ledger: SpendLedger, session?: string, source?: SessionSpendSource): Promise<string[]> {
  const lines = [formatSpend(await ledger.report(new Date().toISOString().slice(0, 10)))];
  if (source !== undefined) {
    const snapshot = await readRunSpend(source);
    lines.push(`Current run segment ${snapshot.segment}: ${formatSpend(snapshot.report)}${snapshot.unavailable ? "\nRuntime accounting unavailable; coverage unknown." : ""}`);
    return lines;
  }
  if (session !== undefined) {
    const latest = (await ledger.records()).filter(record => record.type !== "settle" && record.session === session).at(-1);
    lines.push(latest === undefined ? "Selected session: no recorded model calls; current run unknown." :
      `Latest recorded segment ${latest.segment} (not a live run identity): ${formatSpend(await ledger.report("1970-01-01", latest.segment))}`);
  }
  return lines;
}

/** Shared footer and /cost source; never derives current identity from recorded prose/ids. */
export function readRunSpend(source: SessionSpendSource): ReturnType<SessionSpendSource["read"]> { return source.read(); }

export async function usageCommand(cwd: string, since: string, json: boolean, options: { row?: string; trainDir?: string } = {}): Promise<void> {
  if (options.row !== undefined) {
    const rows = await trainUsage(options.trainDir ?? cwd);
    const row = rows.find(row => row.row === options.row || `${row.row}.json` === options.row);
    if (row === undefined) throw new Error(`train row not found: ${options.row}; use --train-dir <queue-directory>`);
    const pricingNote = "Configured-rate estimates only. ChatGPT-login calls remain unpriced; raw tokens are reported. No calls is not evidence of free usage.";
    const format = (value: typeof row.totals) => `${value.input} input / ${value.output} output / ${value.cacheRead} cache-read / ${value.cacheWrite} cache-write tokens; ${value.estimatedMicros === null ? "unpriced" : `$${(value.estimatedMicros / 1_000_000).toFixed(6)} configured-rate estimate (priced subset)`}; ${value.unpricedCalls} unpriced / ${value.incompleteCalls} incomplete calls`;
    console.log(json ? JSON.stringify({ ...row, pricingNote }) : [`Row ${row.row}: ${format(row.totals)}`, ...row.sessions.flatMap(session => [`Session ${session.session}: ${format(session.totals)}`, ...session.models.map(model => `  ${session.session} ${model.provider}/${model.model}: ${format(model)}`)]), pricingNote, ...row.coverageWarnings].join("\n"));
    return;
  }
  const report = await new SpendLedger(await realpath(cwd)).report(since);
  console.log(json ? JSON.stringify(report) : formatSpend(report));
}
