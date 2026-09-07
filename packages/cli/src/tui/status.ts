import type { TuiState } from "./controller.js";
import type { StatusDetails } from "./status-snapshot.js";

function safe(text: string, cap = 120): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu, "�").slice(0, cap);
}
function accountingLabel(value: StatusDetails["accounting"]): string {
  if (value.state !== "reported") return `cost:${value.state === "loading" ? "pending" : value.state === "unknown" ? "unknown" : "unavailable"}`;
  const { report: r, unavailable } = value.snapshot;
  const unknown = unavailable || r.unknownCalls > 0 || r.unresolvedCalls > 0 || r.unknownSegments > 0 || r.coverageStarted === null;
  const hasUsage = (r.usageSnapshots ?? 0) > 0 ||
    (r.usageSnapshots === undefined && Object.values(r.reportedUsage).some(count => count > 0));
  const cost = r.completeCalls === 0 && !hasUsage
    ? "run tokens:unreported cost:?"
    : r.calls > 0 && r.completeCalls === 0
    ? `run tokens:${r.reportedUsage.input}/${r.reportedUsage.output}/${r.reportedUsage.cacheRead}/${r.reportedUsage.cacheWrite} cost:?`
    : `run~$${(r.estimatedMicros / 1e6).toFixed(6)}${unknown ? "+?" : ""}`;
  return `${cost}${r.reservedMicros > 0 ? ` reserved~$${(r.reservedMicros / 1e6).toFixed(6)}` : ""}${r.overrun ? " overrun" : ""}${value.stale ? " stale" : ""}`;
}

function statusParts(details: StatusDetails): string[] {
  const supervisor = details.supervisor;
  const highest = typeof supervisor === "object" ? [...supervisor.next].sort((a, b) => b.level - a.level || a.signal.localeCompare(b.signal))[0] : undefined;
  const sup = typeof supervisor === "string" ? supervisor : supervisor.exhausted ? "exhausted" : highest === undefined ? "ready"
    : `${highest.signal}:next${highest.level + 1}=${highest.rung ?? "none"}${supervisor.next.length > 1 ? ` +${supervisor.next.length - 1}` : ""}`;
  return [`asks:${details.prompts}`, `${details.posture === "ask" ? "ask(policy)" : details.posture} grants:${details.grants}${details.auditBlocked ? " blocked" : ""}`,
    `sb:${safe(details.sandbox, 24)}`, accountingLabel(details.accounting), `sup:${sup}`];
}

/**
 * The one-line footer, built here rather than in JSX so a test can assert what it says without
 * rendering a terminal. The view truncates it to the window width; this function only decides
 * the content.
 */

/** 999 → "999", 12_345 → "12.3k", 1_234_567 → "1.2M". Rounded down: a context gauge that never overstates. */
export function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  const scaled = n < 1_000_000 ? [n / 1_000, "k"] : ([n / 1_000_000, "M"] as const);
  const [value, unit] = scaled as [number, string];
  // one decimal, floored — 1_999_999 is "1.9M", not a premature "2.0M"
  const floored = Math.floor(value * 10) / 10;
  return `${floored % 1 === 0 ? floored.toFixed(0) : floored.toFixed(1)}${unit}`;
}

export function statusLine(
  state: Pick<TuiState, "model" | "sessionId" | "status" | "activity" | "turns" | "context" | "branch" | "statusDetails">,
  now = Date.now(),
): string {
  const parts: string[] = [];
  if (state.statusDetails !== undefined) parts.push(...statusParts(state.statusDetails));
  else {
    if (state.model !== null) parts.push(safe(state.model));
    parts.push(safe(state.sessionId ?? "no session"));
  }
  parts.push(state.status);
  if (state.activity !== null) {
    const elapsed = Math.max(0, Math.floor((now - state.activity.startedAt) / 1_000));
    if (state.activity.kind === "thinking") {
      parts.push(`thinking ${elapsed}s`);
    } else {
      const detail = state.activity.detail === undefined ? "" : ` ${state.activity.detail}`;
      parts.push(`${state.activity.name}${detail} ${elapsed}s`);
    }
  }
  if (state.turns > 0) parts.push(`turn ${state.turns}`);
  if (state.statusDetails !== undefined) {
    if (state.model !== null) parts.push(safe(state.model));
    parts.push(safe(state.sessionId ?? "no session"));
  }
  if (state.context !== null) parts.push(`ctx ${formatTokens(state.context)}`);
  if (state.branch !== null) parts.push(`⎇ ${state.branch}`);
  parts.push("/help");
  return parts.map(part => safe(part)).join(" · ").slice(0, 1024);
}
