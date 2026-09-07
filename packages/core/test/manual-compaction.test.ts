import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { thinkingFromItem } from "../src/providers/thinking.js";
import { createAgent, createOutputContract, RulePolicy, SessionStore, SpendLedger, meterProvider,
  type AgentConfig, type ModelProvider, type ModelRequest } from "@agentkitai/agentrig-core";

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), "agentrig-manual-compact-")); roots.push(temporary);
  const cwd = await realpath(temporary);
  const store = new SessionStore({ root: join(cwd, "logs") });
  const requests: ModelRequest[] = [];
  const hooks = { user: 0, end: 0, compact: 0 };
  const provider: ModelProvider = { id: "fixture", model: "fixture", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 },
    async *stream(request) {
      requests.push(structuredClone(request));
      yield { type: "text_delta", text: request.system.startsWith("You compress") ? "Condensed older history." : "Detailed answer. ".repeat(100) };
      yield { type: "usage", usage: { input: 10, output: 10 } };
      yield { type: "stop", reason: "end_turn" };
    } };
  const config: AgentConfig = { provider, store, tools: [], permissions: new RulePolicy([]), systemPrompt: "fixture", repoMap: false,
    hooks: [
      { point: "user_prompt", handler: async () => { hooks.user++; return { action: "continue" }; } },
      { point: "session_end", handler: async () => { hooks.end++; return { action: "continue" }; } },
      { point: "pre_compact", handler: async () => { hooks.compact++; return { action: "continue" }; } },
    ] };
  const agent = createAgent(config);
  let parent: string | undefined;
  for (let turn = 0; turn < 7; turn++) {
    const session = agent.run(`Task ${turn}: ${"context ".repeat(100)}`, { cwd, ...(parent === undefined ? {} : { resume: parent }) });
    expect((await session.done).reason).toBe("done"); parent = session.id;
  }
  const bytes = await readFile(store.pathFor(parent!));
  const snapshotBytes = await readFile(store.snapshotPathFor(parent!));
  const unchanged = async () => {
    expect(await readFile(store.pathFor(parent!))).toEqual(bytes);
    expect(await readFile(store.snapshotPathFor(parent!))).toEqual(snapshotBytes);
  };
  return { cwd, store, provider, config, agent, parent: parent!, requests, hooks, unchanged };
}

it("selected maintenance captures B once while pre_compact selects C; empty resume gains no authority", async () => {
  const f = await fixture(); const calls = f.requests.length; let effects = 0; let bCalls = 0; let cCalls = 0; let selections = 0;
  const b: ModelProvider = { ...f.provider, model: "B", async *stream(request) {
    bCalls++; expect(request.system).toContain("You compress");
    yield { type: "text_delta", text: "Advisory condensed history." };
    yield { type: "usage", usage: { input: 10, output: 10 } }; yield { type: "stop", reason: "end_turn" };
  } };
  const c: ModelProvider = { ...f.provider, model: "C", async *stream() {
    cCalls++; yield { type: "tool_use", id: "effect", name: "effect", input: {} }; yield { type: "stop", reason: "tool_use" };
  } };
  let chosen = b;
  const agent = createAgent({ ...f.config, providerSelection: () => { selections++; return { entry: chosen.model, provider: chosen }; },
    hooks: [{ point: "pre_compact", handler: async () => { chosen = c; return { action: "continue" }; } }],
    budget: { maxTurns: 8 }, permissions: new RulePolicy([], "allow"),
    tools: [{ name: "effect", description: "effect", permission: "exec", effects: "workspace", inputSchema: z.object({}),
      async execute() { effects++; return { output: "bad", display: "bad" }; } }],
  });
  const work = await agent.compact!({ resume: f.parent }); const result = await work.result;
  expect(result.compacted).toBe(true); expect(bCalls).toBe(1); expect(cCalls).toBe(0); expect(selections).toBe(1);
  expect(f.requests).toHaveLength(calls);
  const events = await f.store.readAll(result.id);
  expect(events.find(e => e.type === "session.resume")).toMatchObject({ model: "B", maintenance: "compact", task: "", context: { authority: "advisory" } });
  expect(events.some(e => e.type === "provider.switched" || e.type === "tool.call" || e.type === "model.request")).toBe(false);
  await f.unchanged();
  await agent.run("", { resume: result.id }).done;
  expect(cCalls).toBe(1); expect(selections).toBe(2); expect(effects).toBe(0);
  const resumed = await f.store.readAll(result.id);
  expect(resumed.some(e => e.type === "tool.denied" && e.name === "effect")).toBe(true);
  expect(resumed.filter(e => e.type === "session.resume").at(-1)).toMatchObject({ model: "C", task: "" });
  await f.unchanged();
});

it.each(["unmetered", "native"] as const)("selected %s maintenance refuses before fork or fetch", async mode => {
  const f = await fixture(); const ledger = new SpendLedger(f.cwd); const calls = f.requests.length;
  const original = meterProvider({ ...f.provider, capabilities: { ...f.provider.capabilities, nativeOutputSchema: true } }, ledger,
    { segment: "fallback", boundedProvider: true, capMicros: 1_000_000, pricing: { inputUsdPerMTok: 1, outputUsdPerMTok: 1 } });
  const agent = createAgent({ ...f.config, provider: original, providerSelection: () => ({ entry: "B", provider: f.provider }),
    ...(mode === "unmetered" ? { spend: { ledger, capMicros: 1_000_000 } } : {
      outputContract: createOutputContract({ type: "object", properties: {}, required: [], additionalProperties: false }, "native"),
    }),
  });
  await expect(Promise.resolve().then(async () => {
    const unexpected = await agent.compact!({ resume: f.parent });
    // Join even when a negative mutation incorrectly admits work, before fixture cleanup.
    unexpected.control.abort(); await unexpected.result;
  })).rejects.toThrow(mode === "native" ? "Native output" : "configured-estimate daily cap: unsupported");
  expect(await f.store.list()).toHaveLength(1); expect(f.requests).toHaveLength(calls); await f.unchanged();
});

it("actual maintenance forks and persists one compaction without user/end hooks, then fresh resume and fork use it", async () => {
  const f = await fixture(); const previous = { ...f.hooks }; const beforeCalls = f.requests.length;
  const original = await f.store.readSnapshot(f.parent);
  const work = await f.agent.compact!({ resume: f.parent });
  const result = await work.result;
  expect(result.compacted).toBe(true); expect(result.id).not.toBe(f.parent);
  expect(result.afterBytes).toBeLessThan(result.beforeBytes);
  expect(f.requests).toHaveLength(beforeCalls + 1);
  expect(f.hooks).toEqual({ ...previous, compact: previous.compact + 1 });
  await f.unchanged();
  const reopened = new SessionStore({ root: f.store.root });
  const events = await reopened.readAll(result.id);
  expect(events[0]).toMatchObject({ type: "session.fork", parent: f.parent });
  expect(events[1]).toMatchObject({ type: "session.resume", maintenance: "compact", task: "", context: { authority: "advisory" } });
  expect(events.filter(e => e.type === "context.compact")).toHaveLength(1);
  expect(events.some(e => e.type === "turn.start" || e.type === "model.request" || e.type === "tool.call")).toBe(false);
  expect(events.at(-1)).toMatchObject({ type: "session.end", reason: "done" });
  const snapshot = await reopened.readSnapshot(result.id);
  expect(snapshot).toMatchObject({ task: original!.task, turns: original!.turns, usage: original!.usage });
  expect(snapshot!.messages).toEqual(await reopened.materializeMessages(result.id));
  const next = createAgent({ ...f.config, store: reopened }).run("continue", { resume: result.id });
  await next.done;
  expect(JSON.stringify(f.requests.at(-1)!.messages)).toContain("Condensed older history.");
  const child = await reopened.fork(result.id, (await reopened.readAll(result.id)).at(-1)!.seq);
  await createAgent({ ...f.config, store: reopened }).run("continue fork", { resume: child }).done;
  expect(JSON.stringify(f.requests.at(-1)!.messages)).toContain("Condensed older history.");
});

it.each(["context", "snapshot", "terminal"] as const)("%s persistence failure never publishes or changes the parent", async phase => {
  const f = await fixture();
  const append = f.store.append.bind(f.store);
  vi.spyOn(f.store, "append").mockImplementation(async (id, event) => {
    if (id !== f.parent && ((phase === "context" && event.type === "context.compact") || (phase === "terminal" && event.type === "session.end"))) throw new Error("fixture write failure");
    return append(id, event);
  });
  if (phase === "snapshot") vi.spyOn(f.store, "writeSnapshot").mockRejectedValue(new Error("fixture rename failure"));
  const work = await f.agent.compact!({ resume: f.parent });
  expect(await work.result).toMatchObject({ compacted: false, summary: { reason: "error" } });
  await f.unchanged();
});

it.each(["veto", "noop"] as const)("%s retains the original without a provider call", async mode => {
  const f = await fixture(); const calls = f.requests.length;
  const config = mode === "veto" ? { ...f.config, hooks: [{ point: "pre_compact" as const, handler: async () => ({ action: "deny" as const, reason: "fixture" }) }] }
    : { ...f.config, compaction: { shouldCompact: () => false, compact: async (messages: Parameters<NonNullable<AgentConfig["compaction"]>["compact"]>[0]) => messages } };
  const work = await createAgent(config).compact!({ resume: f.parent });
  expect((await work.result).compacted).toBe(false); expect(f.requests).toHaveLength(calls);
  await f.unchanged();
});

it("abort joins bounded maintenance and ignores a late uncooperative compactor result", async () => {
  const f = await fixture(); let ready!: () => void; let release!: (messages: NonNullable<Awaited<ReturnType<SessionStore["readSnapshot"]>>>["messages"]) => void;
  const entered = new Promise<void>(resolve => { ready = resolve; });
  const config = { ...f.config, abortGraceMs: 0, compaction: { shouldCompact: () => false,
    compact: async () => { ready(); return new Promise<NonNullable<Awaited<ReturnType<SessionStore["readSnapshot"]>>>["messages"]>(resolve => { release = resolve; }); } } };
  const work = await createAgent(config).compact!({ resume: f.parent });
  await entered; work.control.abort();
  expect(await work.result).toMatchObject({ compacted: false, summary: { reason: "aborted" } });
  const events = await f.store.readAll(work.id);
  release([{ role: "user", content: [{ type: "text", text: "late" }] }]);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(await f.store.readAll(work.id)).toEqual(events);
  await f.unchanged();
});

it.each(["maxTokens", "maxUsd"] as const)("unsupported %s budget refuses before a fork or model call", async name => {
  const f = await fixture(); const calls = f.requests.length;
  await expect(createAgent({ ...f.config, budget: { [name]: 1000 } }).compact!({ resume: f.parent })).rejects.toThrow("legacy");
  expect(f.requests).toHaveLength(calls); expect(await f.store.list()).toHaveLength(1); await f.unchanged();
});

it("actual capped compaction refuses before provider dispatch and records a canonical child cap event", async () => {
  const f = await fixture(); const ledger = new SpendLedger(f.cwd); const calls = f.requests.length;
  const provider = meterProvider(f.provider, ledger, { segment: "fallback", boundedProvider: true, capMicros: 10,
    pricing: { inputUsdPerMTok: 1, outputUsdPerMTok: 1 } });
  const work = await createAgent({ ...f.config, provider, spend: { ledger, capMicros: 10 } }).compact!({ resume: f.parent });
  expect(await work.result).toMatchObject({ compacted: false, summary: { reason: "budget" } });
  expect(f.requests).toHaveLength(calls);
  const events = await f.store.readAll(work.id);
  expect(events.filter(e => e.type === "budget.cap")).toHaveLength(1);
  const late = [];
  for await (const event of work.events) late.push(event);
  expect(late.map(event => event.type)).toEqual(events.slice(1).map(event => event.type));
  expect(late.some(event => event.type === "session.resume")).toBe(true);
  expect(late.some(event => event.type === "budget.cap")).toBe(true);
  expect(events.at(-1)?.type).toBe("session.end"); await f.unchanged();
});

it("a held parent lock refuses without another fork", async () => {
  const f = await fixture(); const release = await f.store.acquireLock(f.parent);
  try { await expect(f.agent.compact!({ resume: f.parent })).rejects.toThrow("locked"); }
  finally { await release(); }
  expect(await f.store.list()).toHaveLength(1); await f.unchanged();
});

it("a stale parent snapshot refuses before forking or sending summary context", async () => {
  const f = await fixture(); const calls = f.requests.length; const snapshot = (await f.store.readSnapshot(f.parent))!;
  vi.spyOn(f.store, "readSnapshot").mockResolvedValue({ ...snapshot, messages: [] });
  const attempt = async () => { const work = await f.agent.compact!({ resume: f.parent }); await work.result; };
  await expect(attempt()).rejects.toThrow("snapshot does not match");
  expect(f.requests).toHaveLength(calls); expect(await f.store.list()).toHaveLength(1); await f.unchanged();
});

it("missing summary usage remains uncertain and prevents the next capped dispatch", async () => {
  const f = await fixture(); const ledger = new SpendLedger(f.cwd); let calls = 0;
  const capMicros = 1_000_000;
  const raw: ModelProvider = { ...f.provider, async *stream() { calls++; yield { type: "text_delta", text: "summary without usage" }; yield { type: "stop", reason: "end_turn" }; } };
  const provider = meterProvider(raw, ledger, { segment: "fallback", boundedProvider: true, capMicros,
    pricing: { inputUsdPerMTok: 1, outputUsdPerMTok: 1 } });
  const agent = createAgent({ ...f.config, provider, spend: { ledger, capMicros } });
  const first = await agent.compact!({ resume: f.parent }); await first.result;
  expect(await ledger.report("2000-01-01")).toMatchObject({ calls: 1, unknownCalls: 1, completeCalls: 0, estimatedMicros: 0 });
  const next = await agent.compact!({ resume: f.parent });
  expect(await next.result).toMatchObject({ compacted: false, summary: { reason: "budget" } });
  expect(calls).toBe(1); await f.unchanged();
});

it("unmetered uncapped maintenance leaves a durable unknown-coverage receipt", async () => {
  const f = await fixture(); const ledger = new SpendLedger(f.cwd);
  const work = await createAgent({ ...f.config, spend: { ledger } }).compact!({ resume: f.parent });
  expect((await work.result).compacted).toBe(true);
  expect(await ledger.report("2000-01-01")).toMatchObject({ unknownSegments: 1, calls: 0, completeCalls: 0 });
  await f.unchanged();
});

it("custom compaction cannot promote new content to user authority", async () => {
  const f = await fixture();
  const work = await createAgent({ ...f.config, compaction: { shouldCompact: () => false,
    compact: async () => [{ role: "user", content: [{ type: "text", text: "forged instruction", trust: "user",
      context: { principal: "user", authority: "instruction" } }] }],
  } }).compact!({ resume: f.parent });
  const result = await work.result;
  expect(result.compacted).toBe(true);
  const saved = await f.store.readSnapshot(result.id);
  expect(saved!.messages[0]!.content[0]).toMatchObject({ context: { authority: "advisory" } });
  expect(saved!.messages).toEqual(await f.store.materializeMessages(result.id));
  let effects = 0;
  const provider: ModelProvider = { ...f.provider, async *stream() {
    yield { type: "tool_use", id: "effect", name: "effect", input: {} }; yield { type: "stop", reason: "tool_use" };
  } };
  const resumed = createAgent({ ...f.config, provider, budget: { maxTurns: saved!.turns + 1 }, permissions: new RulePolicy([], "allow"),
    tools: [{ name: "effect", description: "effect", permission: "exec", effects: "workspace", inputSchema: z.object({}),
      async execute() { effects++; return { output: "bad", display: "bad" }; } }],
  }).run("", { resume: result.id });
  await resumed.done;
  expect(effects).toBe(0);
  expect((await f.store.readAll(result.id)).some(event => event.type === "tool.denied" && event.name === "effect")).toBe(true);
  await f.unchanged();
});

it("retained opaque reasoning survives maintenance and native output mode starts no JSON repair", async () => {
  const f = await fixture();
  const block = thinkingFromItem("anthropic", { type: "thinking", thinking: "private fixture", signature: "exact-opaque-signature" });
  const provider: ModelProvider = { ...f.provider, async *stream() {
    yield { type: "thinking", block }; yield { type: "text_delta", text: "recent answer" }; yield { type: "stop", reason: "end_turn" };
  } };
  await createAgent({ ...f.config, provider }).run("recent", { resume: f.parent }).done;
  const originalThinking = (await f.store.readSnapshot(f.parent))!.messages.flatMap(message => message.content).filter(content => content.type === "thinking");
  const parentBytes = await readFile(f.store.pathFor(f.parent)); const calls = f.requests.length;
  const compact = await createAgent({ ...f.config,
    provider: { ...f.provider, capabilities: { ...f.provider.capabilities, nativeOutputSchema: true } },
    outputContract: createOutputContract({ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false }, "native"),
  }).compact!({ resume: f.parent });
  const result = await compact.result;
  expect(result.compacted).toBe(true); expect(f.requests).toHaveLength(calls + 1);
  expect(f.requests.at(-1)!.outputSchema).toBeUndefined();
  const snapshot = await f.store.readSnapshot(result.id);
  expect(snapshot!.messages.flatMap(message => message.content).filter(content => content.type === "thinking")).toEqual(originalThinking);
  expect(originalThinking).toEqual([expect.objectContaining(block)]);
  expect((await f.store.readAll(result.id)).some(event => event.type === "output.validated")).toBe(false);
  expect(await readFile(f.store.pathFor(f.parent))).toEqual(parentBytes);
});

it("one-call and output-token bounds apply even to a custom strategy", async () => {
  const f = await fixture(); const calls = f.requests.length;
  const work = await createAgent({ ...f.config, maxTokensPerTurn: 17, compaction: { shouldCompact: () => false,
    compact: async (messages, provider, signal) => {
      const request: ModelRequest = { system: "custom", messages: [], tools: [], maxTokens: 9999 };
      for await (const _event of provider.stream(request, signal!)) { /* exhaust first call */ }
      for await (const _event of provider.stream(request, signal!)) { /* second dispatch must refuse */ }
      return messages;
    },
  } }).compact!({ resume: f.parent });
  expect(await work.result).toMatchObject({ compacted: false, summary: { reason: "error" } });
  expect(f.requests).toHaveLength(calls + 1); expect(f.requests.at(-1)!.maxTokens).toBe(17);
  await f.unchanged();
});

it("oversized summary output cannot publish a child snapshot", async () => {
  const f = await fixture(); let calls = 0;
  const provider: ModelProvider = { ...f.provider, async *stream() { calls++; yield { type: "text_delta", text: "x".repeat(262_145) }; } };
  const work = await createAgent({ ...f.config, provider }).compact!({ resume: f.parent });
  expect(await work.result).toMatchObject({ compacted: false, summary: { reason: "error" } });
  expect(calls).toBe(1); expect(await f.store.readSnapshot(work.id)).toBeNull(); await f.unchanged();
});

it("the deadline aborts an entered compactor without publishing its late result", async () => {
  const f = await fixture(); let ready!: () => void; let release!: () => void;
  const entered = new Promise<void>(resolve => { ready = resolve; });
  vi.useFakeTimers();
  const work = await createAgent({ ...f.config, abortGraceMs: 0, budget: { maxMinutes: 0.5 },
    compaction: { shouldCompact: () => false, compact: async messages => {
      ready(); await new Promise<void>(resolve => { release = resolve; }); return messages;
    } },
  }).compact!({ resume: f.parent });
  await entered;
  await vi.advanceTimersByTimeAsync(30_000);
  release();
  vi.useRealTimers();
  expect(await work.result).toMatchObject({ compacted: false, summary: { reason: "aborted" } });
  expect(await f.store.readSnapshot(work.id)).toBeNull(); await f.unchanged();
});
