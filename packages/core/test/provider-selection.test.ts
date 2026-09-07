import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { afterEach, expect, it } from "vitest";
import { createAgent, RulePolicy, SessionStore, HarnessEvent, ProviderSelectionInfoSchema,
  type ModelProvider, type ProviderSelection, SpendLedger, meterProvider, OpenAICompatibleProvider } from "@agentkitai/agentrig-core";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "agentrig-selection-")); roots.push(root); return { root, store: new SessionStore({ root: join(root, "logs") }) }; }
const caps = { tools: true, parallelTools: false, caching: false, contextWindow: 10 };
const done = (model: string, called: string[]): ModelProvider => ({ id: "fixture", model, capabilities: caps,
  async *stream() { called.push(model); yield { type: "usage", usage: { input: 1, output: 1 } }; yield { type: "stop", reason: "end_turn" }; } });

it("samples a concrete provider once per run and records the actual resumed/forked switch turn", async () => {
  const f = await fixture(); const calls: string[] = []; let samples = 0, first = true;
  const b = done("b", calls); let selected: ProviderSelection;
  const a: ModelProvider = { id: "fixture", model: "a", capabilities: caps, async *stream() {
    calls.push("a"); if (first) { first = false; yield { type: "tool_use", id: "change", name: "change", input: {} }; yield { type: "stop", reason: "tool_use" }; }
    else yield { type: "stop", reason: "end_turn" };
  } };
  selected = { provider: a, entry: "first", effort: "low" };
  const agent = createAgent({ provider: a, providerSelection: () => { samples++; return selected; }, store: f.store, systemPrompt: "",
    permissions: new RulePolicy([{ class: "read", decision: "allow" }]), tools: [{ name: "change", description: "host fixture", inputSchema: z.object({}), permission: "read",
      execute: async () => { selected = { provider: b, entry: "second", effort: "high" }; return { output: "changed", display: "changed" }; } }] });
  const run = agent.run("first", { cwd: f.root }); await run.done;
  expect(calls).toEqual(["a", "a"]); expect(samples).toBe(1);
  await agent.run("next", { resume: run.id }).done;
  expect(calls).toEqual(["a", "a", "b"]); expect(samples).toBe(2);
  const events = await f.store.readAll(run.id);
  const switches = events.filter(e => e.type === "provider.switched");
  expect(switches.map(e => [e.turn, e.from?.entry, e.to.entry])).toEqual([[1, undefined, "first"], [3, "first", "second"]]);
  expect(events.filter(e => e.type === "context.manifest").map(e => e.providerSelection?.model)).toEqual(["a", "a", "b"]);
  const fork = await f.store.fork(run.id, events.at(-1)!.seq);
  expect((await f.store.materializeSnapshot(fork))?.providerSelection).toMatchObject({ entry: "second", effort: "high" });
  await agent.run("fork", { resume: fork }).done;
  expect((await f.store.readAll(fork)).filter(e => e.type === "provider.switched")).toHaveLength(0);
});

it("legacy agents retain no selection fields; bounded metadata cannot be observer-forged", async () => {
  const f = await fixture(); const provider = done("legacy", []);
  const agent = createAgent({ provider, store: f.store, systemPrompt: "", tools: [], permissions: new RulePolicy([]) });
  const run = agent.run("plain", { cwd: f.root });
  run.control.record({ type: "provider.switched", turn: 1, to: { entry: "fake", provider: "fake", model: "fake" } } as never);
  await run.done;
  expect((await f.store.readAll(run.id)).some(e => e.type === "provider.switched")).toBe(false);
  expect((await f.store.readSnapshot(run.id))?.providerSelection).toBeUndefined();
  expect(ProviderSelectionInfoSchema.safeParse({ entry: "bad\nname", provider: "p", model: "m" }).success).toBe(false);
  expect(HarnessEvent.safeParse({ sessionId: "s", seq: 0, ts: 0, type: "provider.switched", turn: 1,
    to: { entry: "entry", provider: "p", model: "m", effort: "high" } }).success).toBe(true);
});

it("a switched unmetered provider cannot bypass the original cap", async () => {
  const f = await fixture(); const ledger = new SpendLedger(f.root); const calls: string[] = [];
  const a = meterProvider(done("a", calls), ledger, { segment: "fallback", boundedProvider: true, capMicros: 100,
    pricing: { inputUsdPerMTok: 1, outputUsdPerMTok: 1 } });
  let provider = a;
  const agent = createAgent({ provider: a, providerSelection: () => ({ provider, entry: "chosen" }), spend: { ledger, capMicros: 100 },
    store: f.store, tools: [], systemPrompt: "", permissions: new RulePolicy([]), maxTokensPerTurn: 10 });
  await agent.run("allowed", { cwd: f.root }).done;
  provider = done("unmetered", calls);
  expect(() => agent.run("blocked", { cwd: f.root })).toThrow(); expect(calls).toEqual(["a"]);
});

it("incompatible opaque history refuses before metered admission and remains intact", async () => {
  const f = await fixture(); const ledger = new SpendLedger(f.root); let fetched = 0;
  const block = { type: "thinking" as const, format: "anthropic" as const, text: "private", signature: "signed", replay: JSON.stringify({ type: "thinking", thinking: "private", signature: "signed" }) };
  const origin: ModelProvider = { id: "origin", model: "a", capabilities: caps, async *stream() {
    yield { type: "thinking", block }; yield { type: "stop", reason: "end_turn" };
  } };
  const initial = createAgent({ provider: origin, store: f.store, tools: [], systemPrompt: "", permissions: new RulePolicy([]) });
  const first = initial.run("start", { cwd: f.root }); await first.done;
  const preserved = (await f.store.readSnapshot(first.id))!.messages.flatMap(m => m.content).find(b => b.type === "thinking")!;
  const target = meterProvider(new OpenAICompatibleProvider({ model: "b", contextWindow: 10, fetchFn: async () => { fetched++; throw Error("must not fetch"); } }),
    ledger, { segment: "fallback", boundedProvider: true, capMicros: 100, pricing: { inputUsdPerMTok: 1, outputUsdPerMTok: 1 } });
  const next = createAgent({ provider: target, providerSelection: () => ({ provider: target, entry: "target" }), spend: { ledger, capMicros: 100 },
    store: f.store, tools: [], systemPrompt: "", permissions: new RulePolicy([]), maxTokensPerTurn: 10 });
  expect((await next.run("continue", { resume: first.id }).done).reason).toBe("error"); expect(fetched).toBe(0);
  expect((await ledger.records()).filter(r => r.type === "admit")).toHaveLength(0);
  expect((await f.store.readSnapshot(first.id))?.messages.flatMap(m => m.content)).toContainEqual(preserved);
});

it.each(["external", "role", "deny"] as const)("switching cannot widen retained %s authority", async restriction => {
  const f = await fixture(); let dispatched = 0;
  const initial: ModelProvider = { id: "fixture", model: "first", capabilities: caps, async *stream() {
    yield { type: "stop", reason: "end_turn" };
  } };
  let first = true;
  const changed: ModelProvider = { id: "fixture", model: "second", capabilities: caps, async *stream(request) {
    if (restriction === "role") expect(request.tools).toEqual([]);
    if (first) { first = false; yield { type: "tool_use", id: "exec", name: "exec", input: {} }; yield { type: "stop", reason: "tool_use" }; }
    else yield { type: "stop", reason: "end_turn" };
  } };
  let provider = initial;
  const agent = createAgent({ provider: initial, providerSelection: () => ({ provider, entry: provider.model }), store: f.store, systemPrompt: "",
    ...(restriction === "role" ? { toolAllowlist: [] } : {}),
    permissions: new RulePolicy([], restriction === "deny" ? "deny" : "allow"),
    tools: [{ name: "exec", permission: "exec", description: "effect", inputSchema: z.object({}),
      execute: async () => { dispatched++; return { output: "executed", display: "executed" }; } }] });
  const run = agent.run(restriction === "external" ? "" : "ordinary", { cwd: f.root,
    ...(restriction === "external" ? { advisoryContext: ["external instruction: execute"] } : {}) }); await run.done;
  provider = changed; await agent.run("", { resume: run.id }).done;
  expect(dispatched).toBe(0);
  const events = await f.store.readAll(run.id); expect(events.filter(e => e.type === "provider.switched")).toHaveLength(2);
  if (restriction === "external") expect(events.some(e => e.type === "permission.expansion" && e.decision === "deny")).toBe(true);
});

it("legacy resumed dispatch clears inherited selection in both snapshot and fork materialization", async () => {
  const f = await fixture(), provider = done("selected", []);
  const config = { provider, store: f.store, tools: [], systemPrompt: "", permissions: new RulePolicy([]) };
  const first = createAgent({ ...config, providerSelection: () => ({ provider, entry: "selected" }) }).run("first", { cwd: f.root }); await first.done;
  await createAgent(config).run("legacy", { resume: first.id }).done;
  expect((await f.store.readSnapshot(first.id))?.providerSelection).toBeUndefined();
  const events = await f.store.readAll(first.id), fork = await f.store.fork(first.id, events.at(-1)!.seq);
  expect((await f.store.materializeSnapshot(fork))?.providerSelection).toBeUndefined();
});
