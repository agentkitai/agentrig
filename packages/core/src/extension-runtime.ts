import { AsyncLocalStorage } from "node:async_hooks";
import type { EventPayload } from "./events.js";
import type { ExtensionReceipt } from "./extensions.js";
import type { Hook } from "./hooks.js";
import { sanitizeLine } from "./tools/skills.js";

type Failure = { name: string; path: string; phase: "hook" | "tool" | "command"; surface: string; message: string; disabled: true };
type Owner = { name: string; path: string; disabled: boolean; idle?: Failure; notice(message: string): void };
type Run = { signal: AbortSignal; isEnded(): boolean; emit(event: EventPayload): Promise<unknown>; pending: Failure[] };
const owners = new WeakMap<object, Owner>();
const runs = new AsyncLocalStorage<Run>();

/** Internal actual-run binding, never installed on an extension-facing context. */
export function withExtensionRun<T>(run: Omit<Run, "pending">, action: () => T): T {
  return runs.run({ ...run, pending: [] }, action);
}
export async function flushExtensionFailures(): Promise<void> {
  const run = runs.getStore();
  if (run === undefined || run.isEnded()) return;
  for (const failure of run.pending.splice(0)) await run.emit({ type: "extension.error", ...failure });
}
export function createExtensionOwner(receipt: Pick<ExtensionReceipt, "name" | "path">, notice: Owner["notice"]): Owner {
  return { ...receipt, disabled: false, notice };
}
export function ownExtension<T extends object>(value: T, owner: Owner): T { owners.set(value, owner); return value; }
export function extensionDisabled(value: object): boolean { return owners.get(value)?.disabled === true; }
export class ExtensionHandlerError extends Error {}
function refusal(owner: Owner): ExtensionHandlerError { return new ExtensionHandlerError(`extension ${owner.name} is disabled until a new agent build`); }

function fail(owner: Owner, phase: Failure["phase"], surface: string, error: unknown, signal?: AbortSignal): void {
  const run = runs.getStore();
  if (owner.disabled || (signal ?? run?.signal)?.aborted) return;
  owner.disabled = true;
  const failure: Failure = { name: owner.name, path: owner.path, phase, surface,
    message: sanitizeLine(String(error), 1024), disabled: true };
  // A late callback remains attached to its original run, never another concurrent/resumed run.
  if (run !== undefined) {
    // Late faults retain their original run binding: notice only once it has ended, never
    // append after terminal or silently move the failure into a different run's idle receipt.
    if (!run.isEnded()) run.pending.push(failure);
  } else owner.idle = failure;
  try { owner.notice(`extension ${owner.name} disabled (${surface}): ${failure.message}`); }
  catch { /* A diagnostic observer cannot undo the disabled transition or its audit receipt. */ }
}
export function extensionHookFailed(hook: Hook, error: unknown, signal?: AbortSignal): void {
  const owner = owners.get(hook);
  if (owner !== undefined) fail(owner, "hook", hook.point, error, signal);
}
/** Synchronous callbacks retain their shapes. Unknown background work stays conservative. */
export function extensionCallback<T extends (...args: any[]) => any>(owner: Owner, surface: string, callback: T,
  fallback?: () => ReturnType<T>): T {
  return ((...args: Parameters<T>) => {
    if (owner.disabled) { if (fallback !== undefined) return fallback(); throw refusal(owner); }
    try { return callback(...args); }
    catch (error) {
      fail(owner, "tool", surface, error);
      if (fallback !== undefined) return fallback();
      throw new ExtensionHandlerError(`extension ${owner.name} ${surface} failed: ${sanitizeLine(String(error), 1024)}`);
    }
  }) as T;
}
export async function extensionHandler<T>(owner: Owner, phase: "tool" | "command", surface: string,
  action: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
  if (owner.disabled) throw refusal(owner);
  try { return await action(); }
  catch (error) {
    fail(owner, phase, surface, error, signal);
    throw error;
  }
}
export function extensionStartup(receipt: ExtensionReceipt): { disabled?: true; pending?: Failure } {
  const owner = owners.get(receipt);
  if (owner === undefined || !owner.disabled) return {};
  const pending = owner.idle;
  delete owner.idle;
  return { disabled: true, ...(pending === undefined ? {} : { pending }) };
}
