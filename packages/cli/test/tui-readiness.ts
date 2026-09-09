import type { TuiController, TuiState } from "../src/tui/controller.ts";

/** Test readiness, not a production latency contract. Never treats an absent prompt as ready. */
export function waitForTuiState(
  controller: Pick<TuiController, "subscribe" | "snapshot">,
  run: Promise<unknown>,
  description: string,
  ready: (state: TuiState) => boolean,
  timeoutMs = 4000,
): Promise<TuiState> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    const finish = (error?: Error, state?: TuiState) => {
      if (settled) return;
      settled = true; clearTimeout(timer); unsubscribe?.();
      if (error) reject(error); else resolve(state!);
    };
    const failure = (reason: string) => {
      const state = controller.snapshot();
      return new Error(`${description}: ${reason}; pending=${state.pending?.req.tool ?? "none"}; ` +
        `status=${state.status}; recent=${state.lines.slice(-4).map(line => line.text.slice(0, 200)).join(" | ")}`);
    };
    const timer = setTimeout(() => finish(failure(`not ready within ${timeoutMs}ms`)), timeoutMs);
    unsubscribe = controller.subscribe(state => {
      try { if (ready(state)) finish(undefined, state); }
      catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
    // subscribe immediately publishes its current state, before it returns the disposer.
    if (settled) unsubscribe();
    void run.then(
      () => { if (!settled) finish(failure("run settled before readiness")); },
      error => { if (!settled) finish(failure(`run rejected before readiness: ${String(error).slice(0, 200)}`)); },
    );
  });
}
