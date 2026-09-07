import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { render } from "ink";
import { afterEach, expect, it, vi } from "vitest";
import { Checkpointer, createAgent, HarnessEvent, meterProvider, RulePolicy, sessionSpendSource, SpendLedger, SessionStore, writeFileTool, type ModelProvider } from "@agentkitai/agentrig-core";
import { renderEvent } from "../src/render.js";
import { TuiController } from "../src/tui/controller.js";
import { App } from "../src/tui/app.js";
import { boundedManualLines, manualDiff, manualDoctor } from "../src/tui/manual.js";
import { parseCommand, RESERVED_COMMAND_NAMES } from "../src/tui/commands.js";
import { diagnosticConfigValues } from "../src/config.js";
import { waitForTuiState } from "./tui-readiness.js";
import { costLines } from "../src/usage.js";
import { statusLine } from "../src/tui/status.js";

const roots: string[] = []; const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0).reverse()) await fn(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const dir = await mkdtemp(join(tmpdir(), "agentrig-manual-cli-")); roots.push(dir); return dir; }

it("maintenance event rendering labels a transcript estimate, never a request manifest", () => {
  const base = { seq: 1, sessionId: "fixture", ts: 1 };
  const resume = HarnessEvent.parse({ ...base, type: "session.resume", task: "", cwd: "/fixture", provider: "fixture", model: "fixture", turns: 7, maintenance: "compact" });
  expect(renderEvent(resume)).toContain("maintenance=compact");
  const compact = HarnessEvent.parse({ ...base, type: "context.compact", before: 100, after: 20, messages: [], estimate: { scope: "transcript", beforeBytes: 400, afterBytes: 80 } });
  expect(renderEvent(compact)).toContain("transcript-only");
  expect(renderEvent(compact)).toContain("400"); expect(renderEvent(compact)).toContain("80");
});
class Input extends EventEmitter {
  isTTY = true; chunks: string[] = [];
  setEncoding() { return this; } setRawMode() { return this; } ref() { return this; } unref() { return this; }
  read() { return this.chunks.shift() ?? null; }
}
async function conversation(onSummary?: (signal: AbortSignal) => Promise<void>) {
  const cwd = await root(); const store = new SessionStore({ root: join(cwd, "logs") }); let calls = 0;
  const provider: ModelProvider = { id: "fixture", model: "fixture", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 },
    async *stream(request, signal) { calls++; if (request.system.startsWith("You compress")) await onSummary?.(signal);
      yield { type: "text_delta", text: request.system.startsWith("You compress") ? "Short history." : "Detailed context. ".repeat(100) };
      yield { type: "usage", usage: { input: 10, output: 10 } }; yield { type: "stop", reason: "end_turn" }; } };
  const agent = createAgent({ provider, store, tools: [], permissions: new RulePolicy([]), systemPrompt: "fixture", repoMap: false });
  const controller = new TuiController({ cwd, agent }); cleanup.push(() => controller.shutdown());
  for (let i = 0; i < 7; i++) await controller.submit(`task${i}: ${"context ".repeat(50)}`);
  return { cwd, store, agent, controller, calls: () => calls };
}

it.each(["\u0003", "\u001b[201~\u0003", "\u0007", "\u001b[201~\u0007"])("actual App interrupt %j aborts owned compaction without exiting", async key => {
  let entered!: () => void; let cancelled!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const aborted = new Promise<void>(resolve => { cancelled = resolve; });
  const f = await conversation(async signal => {
    entered(); await new Promise<void>(resolve => {
      const stop = () => { cancelled(); resolve(); };
      if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
    });
  });
  const parent = f.controller.snapshot().sessionId; const input = new Input();
  const stdout = Object.assign(new EventEmitter(), { columns: 80, rows: 24, isTTY: true, write: () => true });
  let mounted!: () => void; const mount = new Promise<void>(resolve => { mounted = resolve; });
  const ink = render(createElement(App, { controller: f.controller, onMounted: mounted, settings: { keybindings: { abort: "ctrl-g" } } }),
    { stdout: stdout as never, stdin: input as never, patchConsole: false, exitOnCtrlC: false });
  const exited = ink.waitUntilExit().then(() => "exit");
  const work = f.controller.submit("/compact");
  try {
    await mount; await ready;
    input.chunks.push(key); input.emit("readable");
    expect(await Promise.race([aborted.then(() => "abort"), exited])).toBe("abort");
    await work;
    expect(f.controller.snapshot().sessionId).toBe(parent);
    expect(f.controller.snapshot().lines.some(line => line.text.includes("cancelling maintenance"))).toBe(true);
    expect(f.controller.isIdle()).toBe(true);
  } finally { f.controller.abort(); await work; ink.unmount(); await exited; }
});

it("attachment preparation excludes maintenance and /clear; maintenance excludes attachment callbacks", async () => {
  const f = await conversation(); const parent = f.controller.snapshot().sessionId; const before = f.calls();
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const complete = vi.fn(async (text: string) => { await held; return { text, hint: "" }; });
  const clipboard = vi.fn(async () => { throw new Error("must not run"); });
  f.controller.setInputAttachments({ complete, clipboard });
  const input = f.controller.completeInput("@file");
  try {
    expect(f.controller.isIdle()).toBe(false);
    await f.controller.submit("/compact"); await f.controller.submit("/clear");
    expect(f.controller.snapshot().sessionId).toBe(parent); expect(f.calls()).toBe(before);
  } finally { release(); await input; }
  let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
  f.controller.setManualCommands({ doctor: async () => { await gate; return ["local only"]; } });
  const work = f.controller.submit("/doctor");
  try {
    expect(f.controller.isIdle()).toBe(false);
    expect(await f.controller.completeInput("@second")).toEqual({ text: "@second", hint: "" });
    await f.controller.pasteImage();
    expect(complete).toHaveBeenCalledTimes(1); expect(clipboard).not.toHaveBeenCalled();
  } finally { finish(); await work; }
  expect(f.controller.isIdle()).toBe(true);
});

it("provider selection and maintenance exclude reentrant callbacks in both directions", async () => {
  const f = await conversation(); const parent = f.controller.snapshot().sessionId; const before = f.calls();
  const selection = { entry: "fixture", provider: "fixture", model: "fixture" };
  const overlaps: Promise<unknown>[] = [];
  const complete = vi.fn(async (text: string) => ({ text, hint: "" }));
  f.controller.setInputAttachments({ complete, clipboard: async () => { throw new Error("unused"); } });
  const prepare = vi.fn(() => {
    overlaps.push(f.controller.submit("/compact"), f.controller.submit("/clear"), f.controller.completeInput("@file"));
    return () => selection;
  });
  f.controller.setProviderSelection({ current: () => selection, describe: () => [], prepare });
  await f.controller.submit("/model fixture"); await Promise.all(overlaps);
  expect(prepare).toHaveBeenCalledTimes(1); expect(complete).not.toHaveBeenCalled();
  expect(f.calls()).toBe(before); expect(f.controller.snapshot().sessionId).toBe(parent);
  f.controller.setManualCommands({ doctor: async () => { await f.controller.submit("/model fixture"); return ["local"]; } });
  await f.controller.submit("/doctor"); expect(prepare).toHaveBeenCalledTimes(1);
  expect(f.controller.isIdle()).toBe(true);
});

it.each([80, 120])("actual App /compact publishes a saved fork and renders its estimate at %i columns", async columns => {
  const f = await conversation(); const parent = f.controller.snapshot().sessionId!;
  const original = await readFile(f.store.pathFor(parent)); const writes: string[] = [];
  const stdout = Object.assign(new EventEmitter(), { columns, rows: 24, isTTY: true,
    write: (text: string) => { writes.push(text); stdout.emit("frame"); return true; } });
  const ink = render(createElement(App, { controller: f.controller }), { stdout: stdout as never, stdin: new Input() as never, patchConsole: false, exitOnCtrlC: false });
  cleanup.push(async () => ink.unmount());
  await f.controller.submit("/compact");
  const frames = { snapshot: () => f.controller.snapshot(), subscribe(listener: (state: ReturnType<TuiController["snapshot"]>) => void) {
    const changed = () => listener(f.controller.snapshot()); stdout.on("frame", changed); changed(); return () => { stdout.off("frame", changed); };
  } };
  await waitForTuiState(frames, new Promise(() => {}), "compaction estimate rendered", () => writes.join("").includes("Manifest delta"));
  expect(f.calls()).toBe(8); expect(f.controller.snapshot().sessionId).not.toBe(parent);
  expect(await readFile(f.store.pathFor(parent))).toEqual(original);
  expect(writes.join("")).toContain("system/tools excluded"); expect(writes.join("")).not.toContain("\u001b[2J");
  const child = f.controller.snapshot().sessionId!;
  expect(await f.store.readSnapshot(child)).not.toBeNull();
  await f.controller.submit("continue"); expect(f.calls()).toBe(9);
  expect(f.controller.snapshot().sessionId).toBe(child);
}, 10000);

it("failed snapshot publication retains controller identity and the next real request uses the parent", async () => {
  const f = await conversation(); const parent = f.controller.snapshot().sessionId;
  const write = f.store.writeSnapshot.bind(f.store);
  const spy = vi.spyOn(f.store, "writeSnapshot").mockImplementation(snapshot => snapshot.sessionId === parent ? write(snapshot) : Promise.reject(new Error("fixture save failure")));
  await f.controller.submit("/compact"); expect(f.controller.snapshot().sessionId).toBe(parent);
  expect(f.controller.snapshot().lines.at(-1)?.text).toContain("unadopted");
  spy.mockRestore(); await f.controller.submit("continue"); expect(f.controller.snapshot().sessionId).toBe(parent);
});

it.each([false, true])("actual maintenance status uses the owned metered child while selection stays parent (abort=%s)", async abort => {
  const cwd = await realpath(await root()); const store = new SessionStore({ root: join(cwd, "logs") });
  const ledger = new SpendLedger(cwd); let release!: () => void; let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const raw: ModelProvider = { id: "fixture", model: "fixture", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 },
    async *stream(request) {
      const summary = request.system.startsWith("You compress");
      if (summary) { entered(); await held; }
      yield { type: "text_delta", text: summary ? "Short summary." : "Detailed context. ".repeat(100) };
      yield { type: "usage", usage: { input: 10, output: 10 } }; yield { type: "stop", reason: "end_turn" };
    } };
  const provider = meterProvider(raw, ledger, { segment: "construction-fallback", pricing: {
    inputUsdPerMTok: 1, outputUsdPerMTok: 1, cacheReadUsdPerMTok: 0, cacheWriteUsdPerMTok: 0 } });
  const agent = createAgent({ provider, store, tools: [], permissions: new RulePolicy([]), systemPrompt: "fixture", repoMap: false, spend: { ledger } });
  const c = new TuiController({ cwd, agent, supervised: true }); cleanup.push(() => c.shutdown());
  for (let i = 0; i < 7; i++) await c.submit(`task ${i} ${"history ".repeat(50)}`);
  const parent = c.snapshot().sessionId!; const previous = c.statusSession()!;
  const original = await readFile(store.pathFor(parent));
  c.configureStatus(() => ({ posture: "ask", sandbox: "none" }));
  const work = c.submit("/compact"); await ready;
  const stop = c.mountStatus();
  try {
    const child = c.activeMaintenanceSession()!;
    expect(child).toBeDefined(); expect(child.id).not.toBe(parent);
    expect(c.snapshot().sessionId).toBe(parent);
    expect(c.statusSession() === child).toBe(true);
    const source = sessionSpendSource(c.statusSession()!)!;
    expect(source.segment).not.toBe("construction-fallback");
    expect(source.segment).not.toBe(sessionSpendSource(previous)!.segment);
    await vi.waitFor(() => expect(c.snapshot().statusDetails?.accounting.state).toBe("reported"));
    const accounting = c.snapshot().statusDetails!.accounting;
    if (accounting.state !== "reported") throw new Error("missing actual report");
    expect(accounting.snapshot.segment).toBe(source.segment);
    expect(accounting.snapshot.report.calls).toBe(1);
    expect(accounting.snapshot.report.completeCalls).toBe(0);
    expect(statusLine(c.snapshot())).toContain("sup:unavailable");
    expect((await costLines(ledger, parent, source)).join("\n")).toContain(`Current run segment ${source.segment}`);
    if (abort) c.abort();
    release(); await work;
    expect(c.activeMaintenanceSession()).toBeUndefined();
    expect(c.statusSession()).not.toBe(child);
    expect(c.snapshot().sessionId === parent).toBe(abort);
    expect(await readFile(store.pathFor(parent))).toEqual(original);
    expect(c.snapshot().statusDetails?.accounting.state).toBe("unknown");
  } finally { release(); await work; stop(); await c.shutdown(); }
});

it("replacing the agent during compaction cannot adopt the old agent's fork", async () => {
  const f = await conversation(); const parent = f.controller.snapshot().sessionId;
  let ready!: () => void; let release!: () => void;
  const entered = new Promise<void>(resolve => { ready = resolve; });
  f.controller.attach({ ...f.agent, compact: async options => {
    const work = await f.agent.compact!(options); await work.result; ready();
    await new Promise<void>(resolve => { release = resolve; }); return work;
  } });
  const work = f.controller.submit("/compact"); await entered;
  f.controller.attach({ run: () => { throw Error("replacement must not run"); } });
  release(); await work; expect(f.controller.snapshot().sessionId).toBe(parent);
});

it("synchronous shutdown during Agent.run aborts and joins the returned session without publishing it", async () => {
  const f = await conversation(); const parent = f.controller.snapshot().sessionId;
  let shutdown!: Promise<void>; let returned!: ReturnType<typeof f.agent.run>;
  f.controller.attach({ run: (task, options) => {
    shutdown = f.controller.shutdown(); returned = f.agent.run(task, options); return returned;
  } });
  await f.controller.submit("must abort"); await shutdown;
  expect((await returned.done).reason).toBe("aborted");
  expect(f.controller.snapshot().status).toBe("idle"); expect(f.controller.snapshot().sessionId).toBe(parent);
});

it("clear/new parity and reserved manual names cannot become skill/model calls", async () => {
  for (const name of ["compact", "doctor", "diff", "clear"]) expect(RESERVED_COMMAND_NAMES.has(name)).toBe(true);
  expect(parseCommand("/clear")).toEqual(parseCommand("/new"));
  const f = await conversation(); const calls = f.calls();
  const ask = f.controller.ask({ tool: "effect", class: "exec", cwd: f.cwd, input: {} });
  const before = f.controller.snapshot().sessionId;
  await f.controller.submit("/clear"); await f.controller.submit("/compact");
  expect(f.controller.snapshot().sessionId).toBe(before); expect(f.calls()).toBe(calls);
  f.controller.answerPermission("deny"); await ask;
  await f.controller.submit("/clear"); expect(f.controller.snapshot().sessionId).toBeNull();
  expect(f.calls()).toBe(calls); expect(f.controller.isIdle()).toBe(true);
});

it("owned doctor blocks other work and shutdown waits for its cooperative completion", async () => {
  const f = await conversation(); let ready!: () => void; let finish!: () => void;
  const entered = new Promise<void>(resolve => { ready = resolve; });
  f.controller.setManualCommands({ doctor: async () => { ready(); await new Promise<void>(resolve => { finish = resolve; }); return ["late diagnostic"]; }, diff: async () => [] });
  const doctor = f.controller.submit("/doctor"); await entered;
  await f.controller.submit("/compact"); await f.controller.submit("/clear");
  expect(f.controller.snapshot().sessionId).not.toBeNull(); expect(f.calls()).toBe(7);
  let closed = false; const shutdown = f.controller.shutdown().then(() => { closed = true; });
  await Promise.resolve(); expect(closed).toBe(false); finish(); await shutdown; await doctor;
  expect(f.controller.snapshot().lines.some(line => line.text === "late diagnostic")).toBe(false);
});

it("asynchronous resume preparation reserves ownership and abort prevents a late agent run", async () => {
  const cwd = await root(); const run = vi.fn(() => { throw new Error("must not run"); });
  const c = new TuiController({ cwd, agent: { run } }); cleanup.push(() => c.shutdown());
  let release!: () => void;
  c.setSessions({ fork: async () => ({ id: "unused", atSeq: 0 }), tree: async () => [], spawned: async () => {
    await new Promise<void>(resolve => { release = resolve; }); return [];
  } });
  const resume = c.submit("/resume fixture");
  expect(c.isIdle()).toBe(false); await c.submit("/clear"); await c.submit("/compact");
  c.abort(); release(); await resume; expect(run).not.toHaveBeenCalled(); expect(c.isIdle()).toBe(true);
});

it("fork preparation blocks compaction and clear, and abort prevents late fork adoption", async () => {
  const f = await conversation(); const parent = f.controller.snapshot().sessionId;
  let ready!: () => void; let release!: () => void;
  const entered = new Promise<void>(resolve => { ready = resolve; });
  f.controller.setSessions({ tree: async () => [], fork: async () => {
    ready(); await new Promise<void>(resolve => { release = resolve; }); return { id: "unadopted", atSeq: 1 };
  } });
  const fork = f.controller.submit("/fork"); await entered;
  try {
    await f.controller.submit("/compact"); await f.controller.submit("/clear");
    expect(f.calls()).toBe(7); expect(f.controller.snapshot().sessionId).toBe(parent);
    f.controller.abort();
  } finally { release(); await fork; }
  expect(f.controller.snapshot().sessionId).toBe(parent);
});

it("plain doctor never constructs a provider, even if probe was requested upstream", async () => {
  const cwd = await root(); const home = await root(); const factory = vi.fn(() => { throw new Error("must not construct"); });
  const output = await manualDoctor({ cwd, home, env: {}, cli: { probe: true, provider: "openai", model: "fixture", repoMap: false }, probeFactory: factory }, new AbortController().signal);
  expect(factory).not.toHaveBeenCalled(); expect(output.join("\n")).toContain("no provider probe");
  expect(diagnosticConfigValues({ provider: "openai", root: cwd, maxTokensPerTurn: "100", runtimeOnly: "ignored" })).toEqual({ provider: "openai", root: cwd, maxTokensPerTurn: "100" });
  await expect(manualDoctor({ cwd, home, cli: { sandbox: "read-only" }, probeFactory: factory }, new AbortController().signal)).rejects.toThrow("sandbox none");
});

it("bounded manual output sanitizes terminal controls and marks truncation", () => {
  const lines = boundedManualLines(Array.from({ length: 5000 }, () => "\u001b[2J\u202e" + "x".repeat(2000)));
  expect(lines.length).toBeLessThanOrEqual(121); expect(Buffer.byteLength(lines.join("\n"))).toBeLessThan(33_000);
  expect(lines.join("\n")).not.toMatch(/[\u001b\u202e]/); expect(lines.at(-1)).toContain("omitted");
});

it("actual protected Git diff is read-only, excludes untracked data, and refuses filters/denial/sandbox", async () => {
  const cwd = await root(); const exec = promisify(execFile);
  const git = (args: string[]) => exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "core.autocrlf=false", ...args], { cwd });
  await git(["init", "-q"]); await writeFile(join(cwd, "a.txt"), "before\n"); await git(["add", "a.txt"]); await git(["commit", "-qm", "fixture"]);
  await writeFile(join(cwd, "a.txt"), "after\n"); await writeFile(join(cwd, "untracked.txt"), "secret-untracked-canary");
  const status = (await git(["status", "--porcelain"])).stdout;
  const options = { policy: new RulePolicy([{ class: "read" as const, decision: "allow" as const }]), store: new SessionStore({ root: join(cwd, "logs") }) };
  const output = (await manualDiff(cwd, "", new AbortController().signal, options)).join("\n");
  expect(output).toContain("-before"); expect(output).toContain("+after"); expect(output).not.toContain("secret-untracked-canary");
  expect((await git(["status", "--porcelain"])).stdout).toBe(status);
  await expect(manualDiff(cwd, "", new AbortController().signal, { ...options, sandbox: "read-only" })).rejects.toThrow("sandbox none");
  await expect(manualDiff(cwd, "", new AbortController().signal, { ...options, policy: new RulePolicy([{ class: "read", decision: "deny" }]) })).rejects.toThrow("permission denied");
  await git(["config", "filter.evil.clean", "must-not-run"]);
  await expect(manualDiff(cwd, "", new AbortController().signal, options)).rejects.toThrow("filter");
}, 10000);

it.each([false, true])("checkpoint diff validates its recorded run and refuses a moved ref (unsealed=%s)", async unsealed => {
  const cwd = await root(); const exec = promisify(execFile);
  const git = (args: string[]) => exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "core.autocrlf=false", ...args], { cwd });
  await git(["init", "-q"]); await git(["config", "user.name", "Fixture"]); await git(["config", "user.email", "fixture@example.test"]);
  await writeFile(join(cwd, "a.txt"), "checkpoint-before\n"); await git(["add", "a.txt"]); await git(["commit", "-qm", "fixture"]);
  const store = new SessionStore({ root: join(cwd, ".agentrig", "sessions") }); let calls = 0;
  const provider: ModelProvider = { id: "fixture", model: "fixture", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 },
    async *stream() {
      if (calls++ % 2 === 0) { yield { type: "tool_use", id: "write", name: "write_file", input: { path: "a.txt", content: "checkpoint-after\n" } }; yield { type: "stop", reason: "tool_use" }; }
      else yield { type: "stop", reason: "end_turn" };
    } };
  const policy = new RulePolicy([{ class: "read", decision: "allow" }, { class: "write", decision: "allow" }]);
  const checkpointer = new Checkpointer();
  if (unsealed) vi.spyOn(checkpointer, "seal").mockRejectedValueOnce(new Error("fixture ownership uncertainty"));
  const agent = createAgent({ provider, store, permissions: policy, tools: [writeFileTool()], hooks: [checkpointer], systemPrompt: "fixture", repoMap: false });
  const session = agent.run("write", { cwd });
  expect((await session.done).reason).toBe("done");
  const events = await store.readAll(session.id);
  const checkpoint = events.find(event => event.type === "checkpoint.created");
  expect(checkpoint?.type).toBe("checkpoint.created");
  const options = { policy, store, session: session.id };
  if (unsealed) {
    expect(events.some(event => event.type === "checkpoint.sealed")).toBe(false);
    await agent.run("write again", { cwd, resume: session.id }).done;
    expect((await store.readAll(session.id)).filter(event => event.type === "checkpoint.sealed")).toHaveLength(1);
    await expect(manualDiff(cwd, "checkpoint 1", new AbortController().signal, options)).rejects.toThrow("unverified");
    return;
  }
  const output = (await manualDiff(cwd, "checkpoint", new AbortController().signal, options)).join("\n");
  expect(output).toContain("-checkpoint-before"); expect(output).toContain("+checkpoint-after"); expect(calls).toBe(2);
  if (checkpoint?.type !== "checkpoint.created") throw Error("missing checkpoint");
  await git(["update-ref", "-d", checkpoint.ref]);
  await expect(manualDiff(cwd, "checkpoint", new AbortController().signal, options)).rejects.toThrow("checkpoint turn 1 is unavailable (pruned or missing); only the last two mutating-turn refs are retained");
  await git(["update-ref", checkpoint.ref, "HEAD"]);
  await expect(manualDiff(cwd, "checkpoint", new AbortController().signal, options)).rejects.toThrow("changed");
}, 30_000);

it.each(["policy", "ask"] as const)("abort abandons a pending %s decision and never dispatches late Git", async phase => {
  const cwd = await root(); const controller = new AbortController(); let release!: (decision: "allow") => void; let ready!: () => void;
  const entered = new Promise<void>(resolve => { ready = resolve; });
  const pending = () => { ready(); return new Promise<"allow">(resolve => { release = resolve; }); };
  const process = vi.fn(async () => "must not run");
  const work = manualDiff(cwd, "", controller.signal, { store: new SessionStore({ root: join(cwd, "logs") }), process,
    policy: { decide: phase === "policy" ? pending : () => "ask" }, ask: pending });
  await entered; controller.abort(); await expect(work).rejects.toThrow(); release("allow");
  await new Promise(resolve => setTimeout(resolve, 0)); expect(process).not.toHaveBeenCalled();
});
