import { SpendLedger, type SpendReport } from "@agentkitai/agentrig-core";
import { realpath } from "node:fs/promises";

export function formatSpend(report: SpendReport): string {
  return `Configured estimate since ${report.since}: $${(report.estimatedMicros / 1_000_000).toFixed(6)}; ` +
    `$${(report.reservedMicros / 1_000_000).toFixed(6)} reserved; ${report.completeCalls}/${report.calls} calls priced; ` +
    `${report.unresolvedCalls} unresolved calls and ${report.unknownSegments} unmetered segments (including earlier days)${report.overrun ? "; reservation overrun" : ""}.\n` +
    `Available token snapshots: input ${report.reportedUsage.input}, output ${report.reportedUsage.output}, cache-read ${report.reportedUsage.cacheRead}, cache-write ${report.reportedUsage.cacheWrite}; unknown coverage is not zero.\n` +
    `Coverage starts ${report.coverageStarted === null ? "not yet recorded" : new Date(report.coverageStarted).toISOString()}; earlier spend and external services unknown. Not an invoice/billing guarantee.`;
}

export async function costLines(ledger: SpendLedger, session?: string): Promise<string[]> {
  const lines = [formatSpend(await ledger.report(new Date().toISOString().slice(0, 10)))];
  if (session !== undefined) {
    const latest = (await ledger.records()).filter(record => record.type !== "settle" && record.session === session).at(-1);
    lines.push(latest === undefined ? "Current run segment: no recorded model calls yet." :
      `Current run segment ${latest.segment}: ${formatSpend(await ledger.report("1970-01-01", latest.segment))}`);
  }
  return lines;
}

export async function usageCommand(cwd: string, since: string, json: boolean): Promise<void> {
  const report = await new SpendLedger(await realpath(cwd)).report(since);
  console.log(json ? JSON.stringify(report) : formatSpend(report));
}
