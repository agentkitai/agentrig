import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgent, RulePolicy, SessionStore, type AuxiliaryReport, type HarnessEvent, type ModelEvent, type ModelProvider, type Session } from "@agentkitai/agentrig-core";
import { attach, RubricGrader, TrajectoryReviewer, type AuxiliaryOptions, type Reviewer } from "@agentkitai/agentrig-supervisor";

let root: string;
const cleanup: Array<() => Promise<void>> = [];
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "agentrig-auxiliary-")); });
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
const answer = JSON.stringify({ diagnosis: "check inputs", directions: ["inspect configuration"], guidance: "check the configuration" });
const provider = (stream: ModelProvider["stream"]): ModelProvider => ({ id: "fake", model: "fixture",
  capabilities: { tools: false, parallelTools: false, caching: false, contextWindow: 100_000 }, stream });
const scripted = (events: ModelEvent[]) => provider(async function* () { yield* events; });
const review = (p: ModelProvider, options: AuxiliaryOptions = {}) => new TrajectoryReviewer({ provider: p }).review({ task: "fix it", trajectory: [] }, options);

describe("bounded reviewer/grader SDK", () => {
  it("reports cumulative snapshots once, disjoint caches and unknown cost; isolates rejecting callbacks", async () => {
    const reports: AuxiliaryReport[] = [];
    const progress: AuxiliaryReport[] = [];
    const result = await review(scripted([
      { type: "usage", usage: { input: 10, output: 1 } },
      { type: "text_delta", text: answer },
      { type: "usage", usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 3 } },
      { type: "stop", reason: "end_turn" },
    ]), { onProgress: report => { progress.push(report); }, onUsage: async report => { reports.push(report); throw new Error("UI failed"); } });
    expect(result.guidance).toContain("configuration");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ operation: "reviewer", outcome: "completed", unknownUsageCalls: 0, costUsd: null,
      reportedUsage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 3 } });
    expect(progress[0]).toMatchObject({ unknownUsageCalls: 1 });
    expect(progress.at(-1)!.reportedUsage.output).toBe(5);
    await new Promise<void>(resolve => setImmediate(resolve));
  });

  it.each(["reviewer", "grader"] as const)("%s aborts an ignoring iterator, ignores late usage and never waits on return", async operation => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const late = Promise.withResolvers<IteratorResult<ModelEvent>>();
    const reports: AuxiliaryReport[] = [];
    const returned = vi.fn(() => new Promise<IteratorResult<ModelEvent>>(() => {}));
    let received: AbortSignal | undefined;
    let n = 0;
    const p = provider((_req, signal) => {
      received = signal;
      return { [Symbol.asyncIterator]: () => ({
        next: async () => {
          if (n++ === 0) return { done: false, value: { type: "usage", usage: { input: 7, output: 1 } } };
          entered.resolve(); return late.promise;
        }, return: returned,
      }) };
    });
    const opts = { signal: controller.signal, onUsage: (report: AuxiliaryReport) => { reports.push(report); } };
    const work = operation === "reviewer" ? review(p, opts)
      : new RubricGrader({ provider: p }).grade({ rubric: "works", artifacts: [], trajectory: [] }, opts);
    const rejected = expect(work).rejects.toMatchObject({ name: "AbortError" });
    await entered.promise; controller.abort(); await rejected;
    expect(received!.aborted).toBe(true);
    expect(returned).toHaveBeenCalledTimes(1);
    expect(reports[0]).toMatchObject({ operation, outcome: "aborted", unknownUsageCalls: 1, reportedUsage: { input: 7, output: 1 } });
    const snapshot = structuredClone(reports);
    late.resolve({ done: false, value: { type: "usage", usage: { input: 999, output: 999 } } });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(reports).toEqual(snapshot);
  });

  it.each([
    { limits: { maxOutputChars: 10 }, events: [{ type: "text_delta", text: answer }] },
    { limits: { maxModelEvents: 2 }, events: Array.from({ length: 3 }, () => ({ type: "text_delta", text: "" })) },
  ])("bounds output and model-event work", async ({ limits, events }) => {
    const reports: AuxiliaryReport[] = [];
    await expect(review(scripted(events as ModelEvent[]), { limits, onUsage: report => { reports.push(report); } })).rejects.toMatchObject({ name: "AuxiliaryLimitError" });
    expect(reports[0]).toMatchObject({ outcome: "limit", unknownUsageCalls: 1 });
  });

  it("rejects an oversized whole prompt before any provider call and reports zero calls", async () => {
    const stream = vi.fn(scripted([]).stream);
    const reports: AuxiliaryReport[] = [];
    await expect(review(provider(stream), { limits: { maxInputChars: 1 }, onUsage: report => { reports.push(report); } })).rejects.toMatchObject({ name: "AuxiliaryLimitError" });
    expect(stream).not.toHaveBeenCalled();
    expect(reports[0]).toMatchObject({ calls: [], unknownUsageCalls: 0, costUsd: 0 });
  });

  it.each([undefined, "max_tokens", "error"])("refuses valid-looking JSON without a successful end_turn (%s)", async reason => {
    const events: ModelEvent[] = [{ type: "text_delta", text: answer }];
    if (reason !== undefined) events.push({ type: "stop", reason } as ModelEvent);
    await expect(review(scripted(events))).rejects.toThrow(/end_turn|stopped/);
  });

  it("checks a monotonic deadline even when synchronous adapter work starves timers", async () => {
    await expect(review(provider(async function* () {
      const until = performance.now() + 20;
      while (performance.now() < until) { /* deliberate bounded timer starvation */ }
      yield { type: "text_delta", text: answer };
      yield { type: "stop", reason: "end_turn" };
    }), { limits: { callTimeoutMs: 5 } })).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it.each([false, true])("keeps absent/synthetic usage unknown (synthetic=%s)", async synthetic => {
    const events: ModelEvent[] = [{ type: "text_delta", text: answer }];
    if (synthetic) events.push({ type: "usage", usage: { input: 0, output: 0 }, reported: false });
    events.push({ type: "stop", reason: "end_turn" });
    const reports: AuxiliaryReport[] = [];
    await review(scripted(events), { onUsage: report => { reports.push(report); } });
    expect(reports[0]).toMatchObject({ unknownUsageCalls: 1, costUsd: null });
  });
});

async function mainSession(): Promise<{ session: Session; finish: () => void; events: () => Promise<HarnessEvent[]> }> {
  const finish = Promise.withResolvers<void>();
  const store = new SessionStore({ root });
  const session = createAgent({ provider: provider(async function* () {
    await finish.promise;
    yield { type: "usage", usage: { input: 2, output: 3 } };
    yield { type: "stop", reason: "end_turn" };
  }), tools: [], permissions: new RulePolicy([]), systemPrompt: "test", store, repoMap: false }).run("test", { cwd: root });
  cleanup.push(async () => { finish.resolve(); session.control.abort(); await session.done; });
  return { session, finish: () => finish.resolve(), events: async () => {
    const events: HarnessEvent[] = []; for await (const event of store.read(session.id)) events.push(event); return events;
  } };
}
const detectStart = { id: "once", observe: (event: HarnessEvent) => event.type === "session.start"
  ? { type: "loop" as const, confidence: 1, evidence: ["fixture"], window: [0, 0] as [number, number] } : null };
const policy = { decide: () => [{ type: "run_reviewer" as const, reason: "fixture" }] };

describe("real-session auxiliary lifetime and durable records", () => {
  it("records final auxiliary usage before session.end without inflating main usage", async () => {
    const main = await mainSession();
    const finished = Promise.withResolvers<void>();
    const sup = attach(main.session, { detectors: [detectStart], policy,
      reviewer: new TrajectoryReviewer({ provider: scripted([
        { type: "text_delta", text: answer }, { type: "usage", usage: { input: 100, output: 20 } }, { type: "stop", reason: "end_turn" },
      ]) }), onUsage: () => finished.resolve() });
    await finished.promise; main.finish();
    const summary = await main.session.done; await sup.done;
    expect(summary.usage).toEqual({ input: 2, output: 3 });
    const events = await main.events();
    const records = events.filter(e => e.type === "auxiliary.usage");
    expect(records.some(e => e.final && e.report.reportedUsage.input === 100 && e.report.unknownUsageCalls === 0)).toBe(true);
    expect(new Set(records.map(e => e.id)).size).toBe(1);
    expect(events.at(-1)!.type).toBe("session.end");
  });

  it("preserves the built-in provider's partial usage when main work finishes first", async () => {
    const main = await mainSession();
    const entered = Promise.withResolvers<void>();
    const late = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    const p = provider(async function* (_req, received) {
      signal = received;
      yield { type: "usage", usage: { input: 5, output: 2 } };
      entered.resolve(); await late.promise;
      yield { type: "text_delta", text: answer };
      yield { type: "usage", usage: { input: 999, output: 999 } };
      yield { type: "stop", reason: "end_turn" };
    });
    const steer = vi.spyOn(main.session.control, "steer");
    const sup = attach(main.session, { detectors: [detectStart], policy, reviewer: new TrajectoryReviewer({ provider: p }) });
    await entered.promise; main.finish(); await main.session.done; await sup.done;
    expect(signal!.aborted).toBe(true);
    const records = await main.events();
    expect(records.some(e => e.type === "auxiliary.usage" && e.report.reportedUsage.input === 5 && e.report.unknownUsageCalls === 1)).toBe(true);
    late.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
    expect(steer).not.toHaveBeenCalled();
    expect(await main.events()).toEqual(records);
  });

  it.each(["detach", "end", "abort"] as const)("%s cancels work and prevents late guidance", async action => {
    const main = await mainSession();
    const entered = Promise.withResolvers<void>();
    const late = Promise.withResolvers<void>();
    let received: AbortSignal | undefined;
    const reviewer: Reviewer = { review: async (_input, opts) => {
      received = opts!.signal; entered.resolve(); await late.promise;
      return { diagnosis: "late", directions: [], guidance: "must not steer" };
    } };
    const steer = vi.spyOn(main.session.control, "steer");
    const reports: AuxiliaryReport[] = [];
    const sup = attach(main.session, { detectors: [detectStart], policy, reviewer, onUsage: report => { reports.push(report); } });
    await entered.promise;
    if (action === "detach") sup.detach();
    else if (action === "abort") main.session.control.abort();
    main.finish(); await sup.done; await main.session.done;
    expect(received!.aborted).toBe(true);
    expect(reports[0]).toMatchObject({ outcome: "aborted", unknownUsageCalls: 1, costUsd: null });
    const prior = await main.events();
    expect(prior.some(e => e.type === "auxiliary.usage" && e.report.unknownUsageCalls === 1)).toBe(true);
    late.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
    expect(steer).not.toHaveBeenCalled();
    expect(await main.events()).toEqual(prior);
    expect(prior.at(-1)!.type).toBe("session.end");
  });

  it("cancels an ignoring loader before starting the reviewer", async () => {
    const main = await mainSession();
    const entered = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    const reviewer = { review: vi.fn() } as unknown as Reviewer;
    const reports: AuxiliaryReport[] = [];
    const sup = attach(main.session, { detectors: [detectStart], policy, reviewer,
      attempts: async (_id, s) => { signal = s; entered.resolve(); return new Promise(() => {}); },
      onUsage: report => { reports.push(report); } });
    await entered.promise; sup.detach(); await sup.done;
    expect(signal!.aborted).toBe(true);
    expect(reviewer.review).not.toHaveBeenCalled();
    expect(reports[0]).toMatchObject({ calls: [], costUsd: 0, outcome: "aborted" });
    main.finish(); await main.session.done;
  });

  it("detach resolves an idle observer without waiting for another event", async () => {
    const main = await mainSession();
    const sup = attach(main.session, { detectors: [], policy: { decide: () => [] } });
    await new Promise<void>(resolve => setImmediate(resolve));
    sup.detach(); await sup.done;
    main.finish(); await main.session.done;
  });
});
