import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { SpendLedger, SpendCapError } from "./spend-ledger.js";

interface SpendContext { ledger: SpendLedger; segment: string; session?: string; unavailable?: boolean;
  onCap?: (error: SpendCapError) => Promise<void>; onUnavailable?: () => Promise<void> }
const context = new AsyncLocalStorage<SpendContext | undefined>();
const sessions = new WeakMap<object, SpendContext>();
export function currentSpend(): SpendContext | undefined { return context.getStore(); }
export function bindSessionSpend(session: object): void { const active = context.getStore(); if (active !== undefined) sessions.set(session, active); }
/** Trusted observer setup: retain the actual run's accounting context, never replay receipts. */
export function withSessionSpend<T>(session: object, work: () => T): T {
  return context.run(sessions.get(session), work);
}
export function withSpendRun<T>(ledger: SpendLedger | undefined, work: () => T): T {
  return context.run(ledger === undefined ? undefined : { ledger, segment: randomUUID() }, work);
}
