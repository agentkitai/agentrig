/** Standalone maintenance owns SIGINT only while it is running; never races local cleanup. */
export async function withMaintenanceSignal<T>(work: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const signal = parent === undefined ? controller.signal : AbortSignal.any([parent, controller.signal]);
  const abort = (): void => {
    if (controller.signal.aborted) {
      console.error("forcing exit; interrupted maintenance may leave locks or artifacts requiring recovery");
      process.exit(130);
    }
    controller.abort(new DOMException("memory maintenance interrupted", "AbortError"));
    console.error("cancelling memory maintenance; press Ctrl-C again to force exit (may leave recovery artifacts)");
  };
  process.on("SIGINT", abort);
  try { signal.throwIfAborted(); return await work(signal); }
  finally { process.removeListener("SIGINT", abort); }
}
