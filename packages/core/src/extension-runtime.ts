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
/**
 * Synchronous callbacks retain their shapes. Unknown background work stays conservative.
 *
 * These descriptors are typed synchronous and are consumed synchronously — a permission class is
 * compared, a path list is iterated, a probe is used as a boolean. TypeScript says so; a JavaScript
 * extension is not obliged to agree, and neither an `async` implementation nor a wrong return type
 * is a contract this host can honour by guessing. Both are treated as the extension fault they are:
 * the owner is disabled and the caller gets the conservative fallback, or a refusal.
 *
 * `validate` runs on the returned value only. It describes the callback's own contract, not the
 * policy the value later feeds — widening a class or trusting a path is still core's decision.
 */
export function extensionCallback<T extends (...args: any[]) => any>(owner: Owner, surface: string, callback: T,
  fallback?: () => ReturnType<T>, validate?: (value: unknown) => void): T {
  const refuse = (error: unknown): ReturnType<T> => {
    fail(owner, "tool", surface, error);
    if (fallback !== undefined) return fallback();
    throw new ExtensionHandlerError(`extension ${owner.name} ${surface} failed: ${sanitizeLine(String(error), 1024)}`);
  };
  return ((...args: Parameters<T>) => {
    if (owner.disabled) { if (fallback !== undefined) return fallback(); throw refusal(owner); }
    let result: unknown;
    try { result = callback(...args); }
    catch (error) { return refuse(error); }
    if (typeof (result as { then?: unknown } | null | undefined)?.then === "function") {
      // Settle it here. A rejected promise nobody awaited is an unhandled rejection that, under
      // Node's default, ends the harness process with a stack naming core rather than the
      // extension — and it would do so long after this call already returned a thenable that the
      // permission check quietly read as "not read-only".
      void Promise.resolve(result).then(() => {}, () => {});
      return refuse(new Error("must return synchronously; async or thenable results are unsupported"));
    }
    try { validate?.(result); } catch (error) { return refuse(error); }
    return result;
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
