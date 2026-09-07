import { mkdtemp, realpath, rm, readFile, writeFile, unlink, mkdir, symlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SpendLedger, dailyCapMicros, meterProvider, createAgent, subagentTool, SessionStore, RulePolicy, EventPayload, type ModelEvent, type ModelProvider, type ModelRequest } from "@agentkitai/agentrig-core";

const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
async function root() { const path = await realpath(await mkdtemp(join(tmpdir(), "agentrig-spend-"))); roots.push(path); return path; }
const request: ModelRequest = { system: "PRIVATE", messages: [], tools: [], maxTokens: 10 };
const pricing = { inputUsdPerMTok: 1, outputUsdPerMTok: 1 };
function fixture(events: ModelEvent[], calls: string[] = []): ModelProvider {
  return { id: "fixture", model: "fixture", capabilities: { tools: true, caching: false, parallelTools: true, contextWindow: 10 },
    async *stream() { calls.push("dispatch"); yield* events; } };
}
async function consume(provider: ModelProvider) { for await (const _ of provider.stream(request, new AbortController().signal)) { /* consume */ } }
const complete: ModelEvent[] = [{ type: "usage", usage: { input: 10, output: 10 } }, { type: "stop", reason: "end_turn" }];

it("rounds cap down, refuses unsafe values and charges one final cumulative snapshot", async () => {
  expect(dailyCapMicros(0.0000019)).toBe(1);
  for (const n of [0, -1, Infinity, NaN, 0.0000001, 1_000_001]) expect(() => dailyCapMicros(n)).toThrow();
  const cwd = await root(); const ledger = new SpendLedger(cwd);
  const provider = meterProvider(fixture([{ type: "usage", usage: { input: 1, output: 1 } }, ...complete]), ledger,
    { segment: "first", pricing, boundedProvider: true, capMicros: 20 });
  await consume(provider);
  expect(await ledger.report("2000-01-01")).toMatchObject({ calls: 1, completeCalls: 1, estimatedMicros: 20, unresolvedCalls: 0 });
  await expect(ledger.check(20)).rejects.toThrow("exhausted");
  await expect(consume(provider)).rejects.toThrow("exhausted");
  expect(await readFile(join(cwd, ".agentrig/usage.jsonl"), "utf8")).not.toContain("PRIVATE");
});

it("does not reprice historical segments and separates disjoint cache counts", async () => {
  const ledger = new SpendLedger(await root());
  const events: ModelEvent[] = [{ type: "usage", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } }, { type: "stop", reason: "end_turn" }];
  await consume(meterProvider(fixture(events), ledger, { segment: "old", pricing: { ...pricing, cacheReadUsdPerMTok: 2, cacheWriteUsdPerMTok: 3 } }));
  await consume(meterProvider(fixture(events), ledger, { segment: "resume", pricing: { inputUsdPerMTok: 10, outputUsdPerMTok: 10 } }));
  expect(await ledger.report("2000-01-01")).toMatchObject({ calls: 2, usageSnapshots: 2, estimatedMicros: 121,
    reportedUsage: { input: 2, output: 4, cacheRead: 6, cacheWrite: 8 } });
  expect(await ledger.report("2000-01-01", "old")).toMatchObject({ calls: 1, usageSnapshots: 1, estimatedMicros: 21 });
  expect(await ledger.report("9999-01-01")).toMatchObject({ calls: 0, usageSnapshots: 0 });
});

it("missing usage blocks a new segment even after UTC midnight", async () => {
  let now = Date.parse("2026-09-07T23:59:59Z"); const ledger = new SpendLedger(await root(), () => now);
  await consume(meterProvider(fixture([{ type: "stop", reason: "end_turn" }]), ledger, { segment: "unknown", pricing, boundedProvider: true, capMicros: 100 }));
  now += 2000;
  await expect(ledger.check(100)).rejects.toThrow("uncertain");
  expect(await ledger.report("2026-09-08")).toMatchObject({ calls: 0, unresolvedCalls: 1 });
});

it("durable admission survives a crashed owner's memory and cannot be admitted twice", async () => {
  const cwd = await root(); const ledger = new SpendLedger(cwd);
  const input = { segment: "crash", model: "fixture", provider: "fixture", reserve: 20,
    rates: { ...pricing, cacheReadUsdPerMTok: 1, cacheWriteUsdPerMTok: 1 } };
  await ledger.admit(input, 20);
  await expect(new SpendLedger(cwd).admit({ ...input, segment: "other" }, 20)).rejects.toThrow("uncertain");
  expect((await ledger.records()).filter(r => r.type === "admit")).toHaveLength(1);
});

it("unsupported priced contract refuses without dispatch and actual overrun remains visible", async () => {
  const calls: string[] = []; const ledger = new SpendLedger(await root());
  expect(() => meterProvider(fixture(complete, calls), ledger, { segment: "refused", pricing, capMicros: 100 })).toThrow("unsupported");
  expect(calls).toEqual([]);
  await consume(meterProvider(fixture([{ type: "usage", usage: { input: 30, output: 30 } }, { type: "stop", reason: "end_turn" }], calls),
    ledger, { segment: "overrun", pricing, boundedProvider: true, capMicros: 100 }));
  expect(await ledger.report("2000-01-01")).toMatchObject({ estimatedMicros: 60, overrun: true });
  await expect(ledger.check(100)).rejects.toThrow("uncertain");
});

it("actual SDK sessions have distinct durable segments and refuse the second start with budget.cap", async () => {
  const cwd = await root(); const ledger = new SpendLedger(cwd); const calls: string[] = [];
  const provider = meterProvider(fixture(complete, calls), ledger, { segment: "auxiliary", pricing, boundedProvider: true, capMicros: 20 });
  const store = new SessionStore({ root: join(cwd, "logs") });
  const agent = createAgent({ provider, store, tools: [], permissions: new RulePolicy([]), systemPrompt: "PRIVATE",
    maxTokensPerTurn: 10, spend: { ledger, capMicros: 20 } });
  const first = agent.run("first", { cwd }); expect((await first.done).reason).toBe("done");
  const second = agent.run("second", { cwd }); expect((await second.done).reason).toBe("budget");
  expect(calls).toEqual(["dispatch"]);
  const records = await ledger.records();
  const firstEnd = records.find(r => r.type === "end" && r.session === first.id)!;
  const secondEnd = records.find(r => r.type === "end" && r.session === second.id)!;
  expect(firstEnd.segment).not.toBe(secondEnd.segment);
  expect(records.find(r => r.type === "admit")).toMatchObject({ segment: firstEnd.segment, session: first.id });
  const events = await store.readAll(second.id);
  const cap = events.find(e => e.type === "budget.cap")!;
  expect(cap).toMatchObject({ reason: "exhausted", segment: secondEnd.segment });
  expect(EventPayload.safeParse({ type: "budget.cap", reason: "made-up", segment: "x" }).success).toBe(false);
  expect(events.at(-1)?.type).toBe("session.end");
});

it("same SDK agent resume adds only new calls", async () => {
  const cwd = await root(); const ledger = new SpendLedger(cwd);
  const provider = meterProvider(fixture(complete), ledger, { segment: "auxiliary", pricing });
  const store = new SessionStore({ root: join(cwd, "logs") });
  const agent = createAgent({ provider, store, tools: [], permissions: new RulePolicy([]), systemPrompt: "",
    maxTokensPerTurn: 10, spend: { ledger } });
  const first = agent.run("first", { cwd }); await first.done;
  const resumed = agent.run("again", { cwd, resume: first.id }); await resumed.done;
  expect(await ledger.report("2000-01-01")).toMatchObject({ calls: 2, estimatedMicros: 40 });
  const records = await ledger.records();
  expect(new Set(records.filter(r => r.type === "admit").map(r => r.segment)).size).toBe(2);
});

it("uncapped injected SDK providers run with durable unknown coverage; capped injection refuses", async () => {
  const cwd = await root(); const ledger = new SpendLedger(cwd); const calls: string[] = [];
  const config = { provider: fixture(complete, calls), store: new SessionStore({ root: join(cwd, "logs") }), tools: [],
    permissions: new RulePolicy([]), systemPrompt: "", spend: { ledger } };
  expect((await createAgent(config).run("uncapped", { cwd }).done).reason).toBe("done");
  expect(calls).toHaveLength(1);
  expect(await ledger.report("2000-01-01")).toMatchObject({ unknownSegments: 1, calls: 0, completeCalls: 0 });
  expect(() => createAgent({ ...config, spend: { ledger, capMicros: 100 } })).toThrow("unsupported");
  expect(calls).toHaveLength(1);
  await expect(ledger.check(100)).rejects.toThrow("uncertain");
});

it("rejects double metering and does not hide unknown usage on a retry", async () => {
  const ledger = new SpendLedger(await root());
  const provider = meterProvider(fixture([{ type: "retry", attempt: 1, maxAttempts: 2, delayMs: 0, reason: "fixture" }, ...complete]), ledger,
    { segment: "retry", pricing });
  expect(() => meterProvider(provider, ledger, { segment: "double", pricing })).toThrow("already metered");
  await consume(provider);
  expect(await ledger.report("2000-01-01")).toMatchObject({ unknownCalls: 1, completeCalls: 0, estimatedMicros: 0 });
});

it.each([60, 100])("actual child, compaction and session-end maintenance share admission (cap=%i)", async capMicros => {
  const cwd = await root(); const ledger = new SpendLedger(cwd); const store = new SessionStore({ root: join(cwd, "logs") });
  const options = { segment: "auxiliary", pricing, boundedProvider: true, capMicros };
  let first = true;
  const main: ModelProvider = { ...fixture(complete), async *stream() {
    if (first) { first = false; yield { type: "tool_use", id: "child", name: "subagent", input: { task: "inspect" } } as ModelEvent;
      yield { type: "usage", usage: { input: 10, output: 10 } } as ModelEvent;
      yield { type: "stop", reason: "tool_use" } as ModelEvent;
    } else yield* complete;
  } };
  const provider = meterProvider(main, ledger, options); const child = meterProvider(fixture(complete), ledger, options);
  const spend = { ledger, capMicros }; const permissions = new RulePolicy([{ class: "exec", decision: "allow" }]);
  const tool = subagentTool({ createAgent, maxTurns: 1, childConfig: () => ({ provider: child, store, tools: [], permissions,
    systemPrompt: "child", spend, maxTokensPerTurn: 10 }) });
  const agent = createAgent({ provider, store, tools: [tool], permissions, systemPrompt: "parent", spend, maxTokensPerTurn: 10,
    budget: { maxTurns: 2 }, compaction: { shouldCompact: () => true, async compact(messages, selected) { await consume(selected); return messages; } },
    hooks: [{ point: "session_end", async handler() { await consume(provider); return { action: "continue" }; } }] });
  const session = agent.run("delegate then finish", { cwd }); const result = await session.done;
  expect(result.reason).toBe(capMicros === 60 ? "budget" : "done");
  const report = await ledger.report("2000-01-01"); expect(report).toMatchObject({ calls: capMicros === 60 ? 3 : 5, estimatedMicros: capMicros, unknownCalls: 0 });
  const records = await ledger.records(); expect(new Set(records.filter(r => r.type === "admit").map(r => r.segment)).size).toBe(2);
  expect(records.filter(r => r.type === "end")).toHaveLength(2);
  const events = await store.readAll(session.id);
  expect(events.some(e => e.type === "budget.cap")).toBe(capMicros === 60);
  expect(events.at(-1)?.type).toBe("session.end");
});

it("two actual processes cannot both reserve the last allowance", async () => {
  const cwd = await root();
  const script = `import { SpendLedger } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
    try { await new SpendLedger(process.argv[1]).admit({segment:process.argv[2],provider:'fixture',model:'fixture',reserve:20,
      rates:{inputUsdPerMTok:1,outputUsdPerMTok:1,cacheReadUsdPerMTok:1,cacheWriteUsdPerMTok:1}},20);console.log('admitted'); }
    catch (error) { console.log('refused:'+error.reason); }`;
  const results = await Promise.all(["a", "b"].map(id => promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, cwd, id],
    { timeout: 10_000, maxBuffer: 4096 })));
  expect(results.map(r => r.stdout.trim()).sort()).toEqual(["admitted", "refused:uncertain"]);
  expect((await new SpendLedger(cwd).records()).filter(r => r.type === "admit")).toHaveLength(1);
}, 15_000);

it("one live ledger serializes bookkeeping while permitting two reserved calls", async () => {
  const ledger = new SpendLedger(await root());
  const provider = meterProvider(fixture(complete), ledger, { segment: "parallel", pricing, boundedProvider: true, capMicros: 40 });
  await Promise.all([consume(provider), consume(provider)]);
  expect(await ledger.report("2000-01-01")).toMatchObject({ calls: 2, estimatedMicros: 40, unresolvedCalls: 0 });
});

it("deleting or rewriting a live ledger cannot silently reset its spent allowance", async () => {
  const cwd = await root(); const ledger = new SpendLedger(cwd);
  await consume(meterProvider(fixture(complete), ledger, { segment: "original", pricing }));
  await writeFile(join(cwd, ".agentrig/usage.jsonl"), "");
  await expect(ledger.check(100)).rejects.toThrow("unavailable");
  await unlink(join(cwd, ".agentrig/usage.jsonl"));
  await expect(ledger.check(100)).rejects.toThrow("unavailable");
});

it("failed post-dispatch settlement leaves uncertainty and does not replay the model", async () => {
  const cwd = await root(); const ledger = new SpendLedger(cwd); let calls = 0;
  const provider = meterProvider({ ...fixture(complete), async *stream() {
    calls++; await writeFile(join(cwd, ".agentrig/usage.lock"), "external-owner", { flag: "wx" }); yield* complete;
  } }, ledger, { segment: "failed-write", pricing, boundedProvider: true, capMicros: 100 });
  await expect(consume(provider)).rejects.toThrow("unavailable");
  expect(calls).toBe(1);
  expect((await ledger.records()).map(r => r.type)).toEqual(["admit"]);
  await unlink(join(cwd, ".agentrig/usage.lock")); // fixture owner only; no production recovery claim
  await expect(consume(provider)).rejects.toThrow("uncertain"); expect(calls).toBe(1);
});

it("abort leaves incomplete usage instead of a zero estimate", async () => {
  const cwd = await root(); const ledger = new SpendLedger(cwd); const abort = new AbortController();
  const provider = meterProvider({ ...fixture(complete), async *stream(_request, signal) {
    yield { type: "usage", usage: { input: 2, output: 1 } } as ModelEvent;
    abort.abort(new Error("fixture abort")); signal.throwIfAborted();
  } }, ledger, { segment: "abort", pricing, boundedProvider: true, capMicros: 100 });
  await expect((async () => { for await (const _ of provider.stream(request, abort.signal)) { /* consume */ } })()).rejects.toThrow("fixture abort");
  expect(await ledger.report("2000-01-01")).toMatchObject({ unknownCalls: 1, unresolvedCalls: 1, estimatedMicros: 0, reservedMicros: 20 });
  await expect(ledger.check(100)).rejects.toThrow("uncertain");
});

it("unsafe linked directory and torn ledger refuse before dispatch without echoing contents", async () => {
  const cwd = await root(); const external = await root();
  await symlink(external, join(cwd, ".agentrig"), process.platform === "win32" ? "junction" : "dir");
  const calls: string[] = [];
  const options = { segment: "unsafe", pricing, boundedProvider: true, capMicros: 100 };
  await expect(consume(meterProvider(fixture(complete, calls), new SpendLedger(cwd), options))).rejects.toThrow("unavailable");
  const other = await root(); await mkdir(join(other, ".agentrig")); await writeFile(join(other, ".agentrig/usage.jsonl"), "PRIVATE TORN DATA");
  await expect(consume(meterProvider(fixture(complete, calls), new SpendLedger(other), options))).rejects.toThrow("configured-estimate daily cap: unavailable");
  expect(calls).toEqual([]);
});

it.each([false, true])("malformed ledger preserves ordinary uncapped execution, but refuses capped dispatch (capped=%s)", async capped => {
  const cwd = await root(); await mkdir(join(cwd, ".agentrig")); const path = join(cwd, ".agentrig/usage.jsonl");
  await writeFile(path, "PRIVATE TORN DATA");
  const ledger = new SpendLedger(cwd); const calls: string[] = [];
  const spend = { ledger, ...(capped ? { capMicros: 100 } : {}) };
  const provider = meterProvider(fixture(complete, calls), ledger, { segment: "fixture", pricing, boundedProvider: true,
    ...(capped ? { capMicros: 100 } : {}) });
  const store = new SessionStore({ root: join(cwd, "logs") });
  const session = createAgent({ provider, store, tools: [], permissions: new RulePolicy([]), systemPrompt: "", spend, maxTokensPerTurn: 10 }).run("fixture", { cwd });
  const result = await session.done; const events = await store.readAll(session.id);
  expect(calls).toHaveLength(capped ? 0 : 1); expect(result.reason).toBe(capped ? "error" : "done");
  expect(events.some(e => e.type === "error" && e.message.includes("accounting") && !e.message.includes("PRIVATE"))).toBe(true);
  expect(JSON.stringify(events)).not.toContain("PRIVATE TORN DATA");
  expect(await readFile(path, "utf8")).toBe("PRIVATE TORN DATA");
});

it("a benign lock released within the deadline does not permanently strand a settled call", async () => {
  const cwd = await root(); const ledger = new SpendLedger(cwd);
  let release: Promise<void> = Promise.resolve();
  const provider = meterProvider({ ...fixture(complete), async *stream() {
    await writeFile(join(cwd, ".agentrig/usage.lock"), "cooperating-writer", { flag: "wx" });
    release = new Promise<void>(resolve => setTimeout(() => { void unlink(join(cwd, ".agentrig/usage.lock")).then(resolve); }, 100));
    yield* complete;
  } }, ledger, { segment: "benign-collision", pricing, boundedProvider: true, capMicros: 100 });
  try { await consume(provider); } finally { await release; }
  expect(await ledger.report("2000-01-01")).toMatchObject({ completeCalls: 1, unresolvedCalls: 0 });
  await expect(ledger.check(100)).resolves.toBeUndefined();
});

it("admission cancellation during cooperative lock waiting never dispatches or removes another owner's lock", async () => {
  const cwd = await root(); await mkdir(join(cwd, ".agentrig")); const lock = join(cwd, ".agentrig/usage.lock");
  await writeFile(lock, "cooperating-owner"); const ledger = new SpendLedger(cwd); const calls: string[] = [];
  const provider = meterProvider(fixture(complete, calls), ledger, { segment: "cancel-wait", pricing, boundedProvider: true, capMicros: 100 });
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(new Error("cancel while waiting")), 50);
  try {
    await expect((async () => { for await (const _ of provider.stream(request, abort.signal)) { /* consume */ } })()).rejects.toThrow("cancel while waiting");
  } finally { clearTimeout(timer); }
  expect(calls).toEqual([]); expect(await readFile(lock, "utf8")).toBe("cooperating-owner"); expect(await ledger.records()).toEqual([]);
});

it("actual runtime cancellation while waiting for startup accounting remains aborted, not a cap refusal", async () => {
  const cwd = await root(); await mkdir(join(cwd, ".agentrig")); const lock = join(cwd, ".agentrig/usage.lock");
  await writeFile(lock, "cooperating-owner"); const ledger = new SpendLedger(cwd); const calls: string[] = [];
  const provider = meterProvider(fixture(complete, calls), ledger, { segment: "runtime-cancel", pricing, boundedProvider: true, capMicros: 100 });
  const store = new SessionStore({ root: join(cwd, "logs") });
  const session = createAgent({ provider, store, tools: [], permissions: new RulePolicy([]), systemPrompt: "", spend: { ledger, capMicros: 100 } }).run("cancel", { cwd });
  const timer = setTimeout(() => session.control.abort(), 50);
  const released = new Promise<void>(resolve => setTimeout(() => { void unlink(lock).then(resolve); }, 100));
  let result;
  try { result = await session.done; } finally { clearTimeout(timer); await released; }
  expect(result.reason).toBe("aborted"); expect(calls).toEqual([]);
  expect((await store.readAll(session.id)).some(e => e.type === "budget.cap")).toBe(false);
});

it("a still-live prior-day reservation cannot create a midnight bypass", async () => {
  let now = Date.parse("2026-09-07T23:59:59Z"); const ledger = new SpendLedger(await root(), () => now);
  const call = await ledger.admit({ segment: "held", provider: "fixture", model: "fixture", reserve: 20,
    rates: { ...pricing, cacheReadUsdPerMTok: 1, cacheWriteUsdPerMTok: 1 } }, 100);
  now += 2000;
  await expect(ledger.check(100)).rejects.toThrow("uncertain");
  await ledger.settle(call, { input: 10, output: 10 }, true);
  await expect(ledger.check(100)).resolves.toBeUndefined();
});

it("an unmetered nested SDK agent cannot relabel its metered parent's next call", async () => {
  const cwd = await root(); const ledger = new SpendLedger(cwd); const store = new SessionStore({ root: join(cwd, "logs") });
  const child = createAgent({ provider: fixture(complete), store, tools: [], permissions: new RulePolicy([]), systemPrompt: "" });
  let nestedId = "", first = true;
  const raw: ModelProvider = { ...fixture(complete), async *stream() {
    if (first) {
      first = false; const session = child.run("nested", { cwd }); nestedId = session.id; await session.done;
      yield { type: "tool_use", id: "noop", name: "noop", input: {} } as ModelEvent;
      yield { type: "usage", usage: { input: 10, output: 10 } } as ModelEvent;
      yield { type: "stop", reason: "tool_use" } as ModelEvent; return;
    }
    yield* complete;
  } };
  const provider = meterProvider(raw, ledger, { segment: "auxiliary", pricing });
  const parent = createAgent({ provider, store, tools: [{ name: "noop", description: "fixture", permission: "read", effects: "read-only", inputSchema: z.object({}),
    async execute() { return { output: "ok", display: "ok" }; } }], permissions: new RulePolicy([{ class: "read", decision: "allow" }]),
    systemPrompt: "", spend: { ledger }, maxTokensPerTurn: 10, budget: { maxTurns: 2 }, compaction: { shouldCompact: () => false, async compact(messages) { return messages; } } });
  const session = parent.run("parent", { cwd }); await session.done;
  const records = await ledger.records();
  expect(records.find(r => r.type === "end" && r.session === session.id)?.segment).toBe(records.find(r => r.type === "admit")?.segment);
  const calls = records.filter(r => r.type === "admit"); expect(calls).toHaveLength(2);
  expect(calls.every(r => r.session === session.id && r.session !== nestedId)).toBe(true);
});
