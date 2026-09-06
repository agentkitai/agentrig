import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { SpendLedger, SpendCapError } from "./spend-ledger.js";

interface SpendContext { ledger: SpendLedger; segment: string; session?: string; unavailable?: boolean;
  onCap?: (error: SpendCapError) => Promise<void>; onUnavailable?: () => Promise<void> }
const context = new AsyncLocalStorage<SpendContext>();
const sessions = new WeakMap<object, SpendContext>();
export function currentSpend(): SpendContext | undefined { return context.getStore(); }
export function bindSessionSpend(session: object): void { const active = context.getStore(); if (active !== undefined) sessions.set(session, active); }
/** Trusted observer setup: retain the actual run's accounting context, never replay receipts. */
export function withSessionSpend<T>(session: object, work: () => T): T {
  const active = sessions.get(session); return active === undefined ? work() : context.run(active, work);
}
export function withSpendRun<T>(ledger: SpendLedger | undefined, work: () => T): T {
  return ledger === undefined ? work() : context.run({ ledger, segment: randomUUID() }, work);
}
