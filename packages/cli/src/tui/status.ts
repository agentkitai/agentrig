import type { TuiState } from "./controller.js";

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
  state: Pick<TuiState, "model" | "sessionId" | "status" | "activity" | "turns" | "context" | "branch">,
  now = Date.now(),
): string {
  const parts: string[] = [];
  if (state.model !== null) parts.push(state.model);
  parts.push(state.sessionId ?? "no session");
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
  if (state.context !== null) parts.push(`ctx ${formatTokens(state.context)}`);
  if (state.branch !== null) parts.push(`⎇ ${state.branch}`);
  parts.push("/help");
  return parts.join(" · ");
}
