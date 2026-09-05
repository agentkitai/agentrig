/** Standalone maintenance owns SIGINT only while it is running; never races local cleanup. */
export async function withMaintenanceSignal<T>(work: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const signal = parent === undefined ? controller.signal : AbortSignal.any([parent, controller.signal]);
  const abort = (): void => { controller.abort(new DOMException("memory maintenance interrupted", "AbortError")); };
  process.on("SIGINT", abort);
  try { signal.throwIfAborted(); return await work(signal); }
  finally { process.removeListener("SIGINT", abort); }
}
