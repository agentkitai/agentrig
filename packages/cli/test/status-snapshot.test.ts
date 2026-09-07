import { EventEmitter } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { render } from "ink";
import { afterEach, expect, it, vi } from "vitest";
import { createAgent, meterProvider, SpendLedger, SessionStore, RulePolicy, sessionSpendSource, type ModelProvider } from "@agentkitai/agentrig-core";
import { LadderPolicy, initialState, signal, attach } from "@agentkitai/agentrig-supervisor";
import { TuiController } from "../src/tui/controller.js";
import { App } from "../src/tui/app.js";
import { statusLine } from "../src/tui/status.js";
import { costLines, readRunSpend } from "../src/usage.js";

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true }); });
async function fixture(priced = true) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "agentrig-footer-"))); roots.push(cwd);
  const ledger = new SpendLedger(cwd), store = new SessionStore({ root: join(cwd, "logs") });
  const raw: ModelProvider = { id: "fixture", model: "fixture", capabilities: { tools: true, caching: true, parallelTools: false, contextWindow: 100000 },
    async *stream() { yield { type: "text_delta", text: "done" }; yield { type: "usage", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } }; yield { type: "stop", reason: "end_turn" }; } };
  const provider = meterProvider(raw, ledger, { segment: "construction-fallback", ...(priced ? { pricing: {
    inputUsdPerMTok: 1, outputUsdPerMTok: 1, cacheReadUsdPerMTok: 2, cacheWriteUsdPerMTok: 3 } } : {}) });
  const agent = createAgent({ provider, store, tools: [], permissions: new RulePolicy([]), systemPrompt: "fixture", repoMap: false, spend: { ledger } });
  const controller = new TuiController({ cwd, agent });
  controller.configureStatus(() => ({ posture: "ask", sandbox: "none" }));
  return { cwd, ledger, store, agent, controller, raw };
}

it.each([false, true])("held actual App distinguishes no usage from explicit reported zero (priced=%s)", async priced => {
  const f = await fixture(priced);
  let release!: () => void, entered = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  f.raw.stream = async function* () {
    entered = true; await held;
    yield { type: "usage", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reported: true };
    yield { type: "stop", reason: "end_turn" };
  };
  const running = f.controller.submit("inert pending observation");
  let app: ReturnType<typeof render> | undefined;
  const writes: string[] = [];
  try {
    await vi.waitFor(() => expect(entered).toBe(true), { timeout: 4000 });
    const stdout = Object.assign(new EventEmitter(), { columns: 180, rows: 30, isTTY: true, write: (s: string) => { writes.push(s); return true; } });
    const stdin = Object.assign(new EventEmitter(), { isTTY: true, setEncoding() {}, setRawMode() {}, ref() {}, unref() {}, read: () => null });
    const before = await f.ledger.records();
    app = render(createElement(App, { controller: f.controller }), { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false });
    await vi.waitFor(() => expect(f.controller.snapshot().statusDetails?.accounting.state).toBe("reported"), { timeout: 4000 });
    expect(statusLine(f.controller.snapshot())).toContain("run tokens:unreported cost:?");
    expect(statusLine(f.controller.snapshot())).not.toContain("tokens:0/0/0/0");
    await vi.waitFor(() => expect(writes.join("")).toContain("tokens:unreported"), { timeout: 4000 });
    expect(await f.ledger.records()).toEqual(before); // observation did not settle, admit or mutate authority
    release(); await running;
    const source = sessionSpendSource(f.controller.statusSession()!)!;
    const final = await readRunSpend(source);
    expect(final.report).toMatchObject({ calls: 1, usageSnapshots: 1, reportedUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 6000);
    writes.length = 0; f.controller.print("refresh settled observation");
    const expected = priced ? "run~$0.000000" : "run tokens:0/0/0/0 cost:?";
    await vi.waitFor(() => expect(statusLine(f.controller.snapshot())).toContain(expected), { timeout: 4000 });
    await vi.waitFor(() => expect(writes.join("")).toContain(expected), { timeout: 4000 });
    expect((await readRunSpend(source)).report).toEqual(final.report);
  } finally { release(); await running; app?.unmount(); await f.controller.shutdown(); }
});

it("settled missing usage stays unreported rather than zero, and mixed priced/pending remains uncertain", async () => {
  const f = await fixture();
  f.raw.stream = async function* () { yield { type: "stop", reason: "end_turn" }; };
  await f.controller.submit("missing usage");
  const stop = f.controller.mountStatus();
  try {
    await vi.waitFor(() => expect(f.controller.snapshot().statusDetails?.accounting.state).toBe("reported"));
    expect(statusLine(f.controller.snapshot())).toContain("run tokens:unreported cost:?");
    const source = sessionSpendSource(f.controller.statusSession()!)!;
    const rates = { inputUsdPerMTok: 1, outputUsdPerMTok: 1, cacheReadUsdPerMTok: 1, cacheWriteUsdPerMTok: 1 };
    const complete = await f.ledger.admit({ segment: source.segment, provider: "fixture", model: "fixture", reserve: 20, rates });
    await f.ledger.settle(complete, { input: 2, output: 3 }, true);
    const pending = await f.ledger.admit({ segment: source.segment, provider: "fixture", model: "fixture", reserve: 10, rates });
    const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 6000);
    f.controller.print("refresh mixed report");
    await vi.waitFor(() => expect(statusLine(f.controller.snapshot())).toContain("run~$0.000005+?"));
    expect(statusLine(f.controller.snapshot())).toContain("reserved~$");
    const report = (await readRunSpend(source)).report;
    expect(report).toMatchObject({ calls: 3, usageSnapshots: 1, completeCalls: 1, unresolvedCalls: 2 });
    await f.ledger.settle(pending, null, false);
  } finally { stop(); await f.controller.shutdown(); }
});

it.each([32, 80, 120])("actual App at %s columns displays live grant create/revoke and bounded prioritized footer", async columns => {
  const f = await fixture(); const writes: string[] = [];
  const stdout = Object.assign(new EventEmitter(), { columns, rows: 30, isTTY: true, write: (s: string) => { writes.push(s); return true; } });
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, setEncoding() {}, setRawMode() {}, ref() {}, unref() {}, read: () => null });
  const app = render(createElement(App, { controller: f.controller }), { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false });
  try {
    const grants = f.controller.permissionGrants; grants.beginRun("session");
    const ask = f.controller.ask({ tool: "read_file", class: "read", cwd: f.cwd, paths: [join(f.cwd, "a")], input: { path: "a" } });
    await vi.waitFor(() => expect(writes.join("")).toContain("asks:1"));
    f.controller.answerPermission("allow", true); expect(await ask).toBe("allow");
    await vi.waitFor(() => expect(f.controller.snapshot().statusDetails?.grants).toBe(1));
    expect(writes.join("")).toContain("ask(policy) grants:1");
    const id = grants.inspect()[0]!.grant.id;
    await f.controller.submit(`/permissions revoke ${id}`);
    await vi.waitFor(() => expect(f.controller.snapshot().statusDetails?.grants).toBe(0));
    expect(statusLine(f.controller.snapshot())).toContain("sb:none");
    expect(statusLine(f.controller.snapshot())).toContain("cost:unknown");
    expect(statusLine(f.controller.snapshot())).not.toContain("\n");
  } finally { app.unmount(); await f.controller.shutdown(); }
});

it("actual per-run binding differs across same-ID resumes and /cost uses the identical typed report", async () => {
  const f = await fixture(); const first = f.agent.run("one", { cwd: f.cwd }); await first.done;
  const source = sessionSpendSource(first)!;
  expect(source.segment).not.toBe("construction-fallback");
  expect(sessionSpendSource({ id: first.id })).toBeUndefined();
  const read = await readRunSpend(source);
  expect(read.report).toMatchObject({ calls: 1, estimatedMicros: 21, reportedUsage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } });
  expect((await costLines(f.ledger, first.id, source)).join("\n")).toContain(`Current run segment ${source.segment}`);
  const second = f.agent.run("two", { cwd: f.cwd, resume: first.id }); await second.done;
  expect(sessionSpendSource(second)!.segment).not.toBe(source.segment);
  expect((await readRunSpend(sessionSpendSource(second)!)).report.calls).toBe(1);
  expect((await readRunSpend(source)).report.calls).toBe(1);
});

it("mount-only accounting refresh reads actual run, unpriced tokens remain explicitly unknown", async () => {
  const f = await fixture(false); await f.controller.submit("one");
  const spy = vi.spyOn(f.ledger, "report");
  expect(f.controller.snapshot().statusDetails).toBeUndefined();
  expect(spy).not.toHaveBeenCalled();
  const stop = f.controller.mountStatus();
  try {
    await vi.waitFor(() => expect(f.controller.snapshot().statusDetails?.accounting.state).toBe("reported"));
    expect(statusLine(f.controller.snapshot())).toContain("run tokens:1/2/3/4 cost:?");
    expect(statusLine(f.controller.snapshot())).not.toContain("run~$0");
    expect(spy).toHaveBeenCalledTimes(1);
    f.controller.print("refresh without another read");
    expect(spy).toHaveBeenCalledTimes(1);
  } finally { stop(); await f.controller.shutdown(); }
});

it("discarded slow read cannot publish into another same-id run, then refresh is throttled", async () => {
  const f = await fixture(); await f.controller.submit("one");
  const first = f.controller.statusSession()!; const firstReport = await sessionSpendSource(first)!.read();
  let resolve!: (value: typeof firstReport.report) => void;
  const original = f.ledger.report.bind(f.ledger);
  const spy = vi.spyOn(f.ledger, "report").mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const stop = f.controller.mountStatus();
  try {
    await f.controller.submit("two");
    expect(f.controller.statusSession()).not.toBe(first);
    resolve(firstReport.report);
    await new Promise(done => setImmediate(done));
    expect(f.controller.snapshot().statusDetails?.accounting.state).not.toBe("reported");
    expect(spy).toHaveBeenCalledTimes(1);
    vi.useFakeTimers(); spy.mockImplementation(original);
    await vi.advanceTimersByTimeAsync(5100);
    // Existing interval was created before fake timers; a real state notification triggers it.
    f.controller.print("now refresh");
    await vi.waitFor(() => expect(f.controller.snapshot().statusDetails?.accounting.state).toBe("reported"));
    const value = f.controller.snapshot().statusDetails!.accounting;
    expect(value.state === "reported" && value.snapshot.segment).toBe(sessionSpendSource(f.controller.statusSession()!)!.segment);
  } finally { stop(); await f.controller.shutdown(); }
});

it("unmount joins a pending read without publishing and closed/unmounted controllers never poll", async () => {
  const f = await fixture(); await f.controller.submit("one");
  const value = (await sessionSpendSource(f.controller.statusSession()!)!.read()).report;
  let resolve!: (report: typeof value) => void;
  const spy = vi.spyOn(f.ledger, "report").mockImplementation(() => new Promise(done => { resolve = done; }));
  const stop = f.controller.mountStatus(); stop();
  const before = f.controller.snapshot().statusDetails;
  const closing = f.controller.shutdown(); resolve(value); await closing;
  expect(f.controller.snapshot().statusDetails).toBe(before);
  expect(spy).toHaveBeenCalledTimes(1);
});

it("ledger read refusal is unavailable, not zero cost; changing trusted configuration is read live", async () => {
  const f = await fixture(); await f.controller.submit("one");
  vi.spyOn(f.ledger, "report").mockRejectedValue(new Error("PRIVATE_ERROR"));
  let yolo = false;
  f.controller.configureStatus(() => ({ posture: yolo ? "yolo" : "ask", sandbox: "none\u001b[2J\n\u202e" }));
  const stop = f.controller.mountStatus();
  try {
    await vi.waitFor(() => expect(f.controller.snapshot().statusDetails?.accounting.state).toBe("unavailable"));
    yolo = true; f.controller.print("configuration committed");
    const line = statusLine(f.controller.snapshot());
    expect(line).toContain("yolo grants:0"); expect(line).toContain("cost:unavailable");
    expect(line).not.toMatch(/[\u001b\n\u202e]/); expect(line).not.toContain("PRIVATE_ERROR");
  } finally { stop(); await f.controller.shutdown(); }
});

it("actual ladder snapshot is per signal, capability-filtered, inert, and unknown for custom policies", async () => {
  const policy = new LadderPolicy({ cooldownTurns: 0, capabilities: { abort: true } });
  const state = initialState(); state.turns = 1;
  policy.decide([signal("loop", 1, ["x"], [0, 1])], state);
  expect(policy.snapshot()).toEqual({ exhausted: false, next: [{ signal: "loop", level: 1, rung: "abort" }] });
  (policy.snapshot().next[0]! as { rung: string }).rung = "force_replan";
  expect(policy.snapshot().next[0]!.rung).toBe("abort");
  policy.decide([signal("injection", 1, ["x"], [0, 1])], state);
  expect(policy.snapshot().next.find(s => s.signal === "injection")!.rung).toBe("inject_guidance");
  const f = await fixture(); const session = f.agent.run("fixture", { cwd: f.cwd });
  const observer = attach(session, { detectors: [], policy: { decide: () => [] } });
  expect(observer.policySnapshot!()).toBeNull(); await session.done; await observer.done;
});

it("queued permission/clarification prompts count actual pending entries and cancellation clears them", async () => {
  const f = await fixture(); const stop = f.controller.mountStatus();
  const cancels = [new AbortController(), new AbortController(), new AbortController()];
  const one = f.controller.ask({ tool: "read_file", class: "read", cwd: f.cwd, input: {} }, undefined, cancels[0]!.signal);
  const two = f.controller.ask({ tool: "write_file", class: "write", cwd: f.cwd, input: {} }, undefined, cancels[1]!.signal);
  const question = f.controller.askQuestion({ id: "00000000-0000-4000-8000-000000000001", sessionId: "s", toolUseId: "q",
    prompt: "Choose", options: ["one", "two"] }, cancels[2]!.signal);
  try {
    expect(f.controller.snapshot().statusDetails?.prompts).toBe(3);
    cancels.forEach(c => c.abort());
    await Promise.all([one, two, question]);
    expect(f.controller.snapshot().statusDetails?.prompts).toBe(0);
  } finally { stop(); await f.controller.shutdown(); }
});

it("an actual child run can be the accounting source while selected parent remains unchanged", async () => {
  const f = await fixture(); await f.controller.submit("parent");
  const parent = f.controller.snapshot().sessionId!;
  const events = await f.store.readAll(parent); const child = await f.store.fork(parent, events.at(-1)!.seq);
  const childRun = f.agent.run("", { cwd: f.cwd, resume: child }); await childRun.done;
  f.controller.observeStatusSession(childRun);
  const source = sessionSpendSource(childRun)!;
  await f.ledger.admit({ segment: source.segment, session: child, model: "fixture", provider: "fixture", reserve: 50,
    rates: { inputUsdPerMTok: 1, outputUsdPerMTok: 1, cacheReadUsdPerMTok: 1, cacheWriteUsdPerMTok: 1 } });
  const stop = f.controller.mountStatus();
  try {
    await vi.waitFor(() => expect(f.controller.snapshot().statusDetails?.accounting.state).toBe("reported"));
    expect(f.controller.snapshot().sessionId).toBe(parent);
    const value = f.controller.snapshot().statusDetails!.accounting;
    expect(value.state === "reported" && value.snapshot.segment).toBe(source.segment);
    expect(statusLine(f.controller.snapshot())).toContain("reserved~$0.000050");
    expect(statusLine(f.controller.snapshot())).toContain("+?");
  } finally { stop(); await f.controller.shutdown(); }
});
