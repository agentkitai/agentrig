import { afterEach, expect, it, vi } from "vitest";
import { TuiController } from "../src/tui/controller.ts";
import { waitForTuiState } from "./tui-readiness.ts";

afterEach(() => vi.useRealTimers());
function fixture() {
  const controller = new TuiController({ cwd: process.cwd(), agent: { run() { throw Error("unused"); } } as never });
  const disposers: ReturnType<typeof vi.fn>[] = [];
  const subscribe = controller.subscribe.bind(controller);
  vi.spyOn(controller, "subscribe").mockImplementation(listener => {
    const dispose = vi.fn(subscribe(listener)); disposers.push(dispose); return dispose;
  });
  return { controller, disposers };
}
const pendingRun = () => new Promise<unknown>(() => {});

it.each(["resolved", "rejected"])("does no diagnostic snapshot work after readiness when the run is later %s", async outcome => {
  const { controller } = fixture();
  let finish!: () => void;
  const run = new Promise<void>((resolve, reject) => { finish = outcome === "resolved" ? resolve : () => reject(Error("late failure")); });
  await waitForTuiState(controller, run, "already ready", () => true);
  const snapshot = vi.spyOn(controller, "snapshot");
  finish(); await Promise.resolve(); await Promise.resolve();
  expect(snapshot).not.toHaveBeenCalled();
  snapshot.mockRestore(); await controller.shutdown();
});

it("waits through absent pending and a delayed stage beyond the old 1s budget", async () => {
  vi.useFakeTimers(); const { controller, disposers } = fixture(); let ready = false;
  const waiting = waitForTuiState(controller, pendingRun(), "probe approval", state => state.pending?.req.tool === "probe")
    .then(state => { ready = true; return state; });
  await vi.advanceTimersByTimeAsync(1100); expect(ready).toBe(false);
  const answer = controller.ask({ tool: "probe", class: "write", cwd: process.cwd(), input: {} }, {});
  expect((await waiting).pending?.req.tool).toBe("probe");
  expect(disposers[0]).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  controller.answerPermission("deny"); expect(await answer).toBe("deny"); await controller.shutdown();
});

it("cleans up a subscription that immediately observes an already-ready state", async () => {
  vi.useFakeTimers(); const { controller, disposers } = fixture();
  const answer = controller.ask({ tool: "probe", class: "write", cwd: process.cwd(), input: {} }, {});
  await waitForTuiState(controller, pendingRun(), "ready", state => state.pending?.req.tool === "probe");
  expect(disposers[0]).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  controller.answerPermission("deny"); await answer; await controller.shutdown();
});

it.each(["resolved", "rejected"])("reports a prematurely %s run without waiting for timeout", async outcome => {
  vi.useFakeTimers(); const { controller, disposers } = fixture();
  const run = outcome === "resolved" ? Promise.resolve() : Promise.reject(Error("fixture failure"));
  const waiting = waitForTuiState(controller, run, "missing child prompt", state => state.pending !== null);
  await expect(waiting).rejects.toThrow(outcome === "resolved" ? "run settled before readiness" : "run rejected before readiness: Error: fixture failure");
  expect(disposers[0]).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0); await controller.shutdown();
});

it("bounds a genuinely absent prompt and unsubscribes with a state diagnostic", async () => {
  vi.useFakeTimers(); const { controller, disposers } = fixture();
  const waiting = waitForTuiState(controller, pendingRun(), "missing child prompt", state => state.pending !== null);
  const rejection = expect(waiting).rejects.toThrow("not ready within 4000ms; pending=none; status=idle");
  await vi.advanceTimersByTimeAsync(4000); await rejection;
  expect(disposers[0]).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0); await controller.shutdown();
});

it("propagates a broken predicate and still removes the synchronous subscription", async () => {
  vi.useFakeTimers(); const { controller, disposers } = fixture();
  await expect(waitForTuiState(controller, pendingRun(), "broken", () => { throw Error("predicate broke"); }))
    .rejects.toThrow("predicate broke");
  expect(disposers[0]).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0); await controller.shutdown();
});
