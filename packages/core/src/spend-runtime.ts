import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { SpendLedger, SpendCapError, SpendReport } from "./spend-ledger.js";

interface SpendContext { ledger: SpendLedger; segment: string; session?: string; unavailable?: boolean;
  onCap?: (error: SpendCapError) => Promise<void>; onUnavailable?: () => Promise<void> }
const context = new AsyncLocalStorage<SpendContext | undefined>();
const sessions = new WeakMap<object, SpendContext>();
export function currentSpend(): SpendContext | undefined { return context.getStore(); }
export function bindSessionSpend(session: object): void { const active = context.getStore(); if (active !== undefined) sessions.set(session, active); }
export interface SessionSpendSource {
  readonly segment: string;
  /** Read-only accounting, not a capability to admit or settle calls. */
  read(): Promise<{ segment: string; report: SpendReport; unavailable: boolean }>;
}
/** Actual runtime binding only: a construction segment or replayed id cannot select this. */
export function sessionSpendSource(session: object): SessionSpendSource | undefined {
  const active = sessions.get(session);
  if (active === undefined) return undefined;
  return Object.freeze({ segment: active.segment, read: async () => ({ segment: active.segment,
    report: await active.ledger.report("1970-01-01", active.segment), unavailable: active.unavailable === true }) });
}
/** Trusted observer setup: retain the actual run's accounting context, never replay receipts. */
export function withSessionSpend<T>(session: object, work: () => T): T {
  return context.run(sessions.get(session), work);
}
export function withSpendRun<T>(ledger: SpendLedger | undefined, work: () => T): T {
  return context.run(ledger === undefined ? undefined : { ledger, segment: randomUUID() }, work);
}
