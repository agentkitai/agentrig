import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionStore, SpendLedger, createAgent, meterProvider, RulePolicy, readFileTool } from "@agentkitai/agentrig-core";
import { buildProgram } from "../src/program.js";
import { renderChatEvent, renderEvent } from "../src/render.js";
import { costLines } from "../src/usage.js";
import { buildAgent } from "../src/agent-builder.js";
import * as providers from "../src/provider.js";
import { ScheduleStore } from "../src/schedule.js";
import { TuiController } from "../src/tui/controller.js";
import { connect } from "./web-fixture.js";
import type { serveWeb } from "../src/web.js";
import * as supervisor from "@agentkitai/agentrig-supervisor";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); process.exitCode = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-cli-spend-"))); roots.push(root);
  const cwd = join(root, "project"), home = join(root, "home"), logs = join(root, "logs");
  await mkdir(join(cwd, ".agentrig"), { recursive: true }); await mkdir(home);
  await writeFile(join(cwd, ".agentrig", "config.json"), JSON.stringify({ root: logs, repoMap: false,
    packages: false, extensionDiscovery: false, skillDiscovery: false, contextWindow: 10 }));
  vi.spyOn(process, "cwd").mockReturnValue(cwd); vi.stubEnv("OPENAI_API_KEY", "private-fixture-key");
  vi.stubEnv("LORE_API_URL", ""); vi.stubEnv("LORE_API_KEY", "");
  vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
  return { cwd, home, logs };
}
it("actual canonical-provider CLI caps the second session before fetch; offline usage agrees and exposes no credentials", async () => {
  const f = await fixture(); const requests: any[] = [];
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  });
  vi.stubGlobal("fetch", fetch);
  const args = ["run", "PRIVATE TASK", "--trust", "--provider", "openai", "--model", "fixture", "--daily-cap", "0.000020",
    "--price-in", "1", "--price-out", "1", "--max-tokens-per-turn", "10"];
  await buildProgram({ config: { cwd: f.cwd, home: f.home } }).parseAsync(args, { from: "user" });
  expect(process.exitCode ?? 0, vi.mocked(console.error).mock.calls.flat().join("\n")).toBe(0);
  await buildProgram({ config: { cwd: f.cwd, home: f.home } }).parseAsync(args, { from: "user" });
  expect(process.exitCode).toBe(1); expect(fetch).toHaveBeenCalledTimes(1);
  expect(requests[0].max_completion_tokens).toBe(10);
  const store = new SessionStore({ root: f.logs }); const events = (await Promise.all((await store.list()).map(s => store.readAll(s.id)))).flat();
  const cap = events.find(e => e.type === "budget.cap")!;
  expect(cap).toMatchObject({ reason: "exhausted" }); expect(renderEvent(cap)).toContain("configured-estimate"); expect(renderChatEvent(cap)).toContain("not invoice");
  const raw = await readFile(join(f.cwd, ".agentrig/usage.jsonl"), "utf8"); expect(raw).not.toContain("PRIVATE TASK"); expect(raw).not.toContain("private-fixture-key");
  const cost = await costLines(new SpendLedger(f.cwd)); expect(cost.join("\n")).toContain("$0.000020");
  process.exitCode = 0;
  await buildProgram().parseAsync(["usage", "--since", "2000-01-01", "--json"], { from: "user" });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]))).toMatchObject({ estimatedMicros: 20, calls: 1 });
});

it.each(["openai-chatgpt", "custom-endpoint"])("capped %s refuses before network and session dispatch", async mode => {
  const f = await fixture(); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const args = ["run", "test", "--trust", "--provider", mode === "openai-chatgpt" ? mode : "openai", "--model", "fixture",
    "--daily-cap", "1", "--price-in", "1", "--price-out", "1", ...(mode === "custom-endpoint" ? ["--base-url", "http://127.0.0.1:9999/v1"] : [])];
  await buildProgram({ config: { cwd: f.cwd, home: f.home } }).parseAsync(args, { from: "user" });
  expect(process.exitCode).toBe(1); expect(fetch).not.toHaveBeenCalled();
  expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain("configured output envelope");
});

it("CLI injected-provider uncapped behavior survives with unknown coverage; a capped injection refuses", async () => {
  const f = await fixture(); let calls = 0;
  const provider = { id: "fixture", model: "injected", capabilities: { tools: true, parallelTools: true, caching: false, contextWindow: 10 },
    async *stream() { calls++; yield { type: "stop" as const, reason: "end_turn" as const }; } };
  vi.spyOn(providers, "buildProviders").mockImplementation(() => ({ main: provider, subagents: provider, memory: provider, supervisor: provider,
    names: ["fixture"], roleNames: { main: "fixture", subagents: "fixture", memory: "fixture", supervisor: "fixture" }, get: () => provider }));
  const build = async (flags: string[]) => buildProgram({ config: { cwd: f.cwd, home: f.home }, run: async (task, opts) => {
    const built = await buildAgent(opts); await built.agent.run(task, { cwd: f.cwd }).done;
  } }).parseAsync(["run", "fixture", "--trust", ...flags], { from: "user" });
  await build([]); expect(calls).toBe(1);
  expect(await new SpendLedger(f.cwd).report("2000-01-01")).toMatchObject({ unknownSegments: 1, completeCalls: 0 });
  await expect(build(["--daily-cap", "1", "--price-in", "1", "--price-out", "1"])).rejects.toThrow("unsupported");
  expect(calls).toBe(1);
});

it.each(["config", "flag"])("actual scheduler consumes one allowance then refuses further model dispatch with failure receipt (%s)", async source => {
  const f = await fixture();
  await writeFile(join(f.cwd, ".agentrig/config.json"), JSON.stringify({ provider: "openai", model: "fixture", contextWindow: 10,
    priceIn: 1, priceOut: 1, maxTokensPerTurn: 10, ...(source === "config" ? { dailyCap: 0.000020 } : {}), repoMap: false, packages: false,
    extensionDiscovery: false, skillDiscovery: false, ingestOnEnd: false, dreamOnEnd: false }));
  const fetch = vi.fn(async () => new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }));
  vi.stubGlobal("fetch", fetch);
  const schedules = new ScheduleStore(f.cwd);
  for (const id of ["first", "second"]) await schedules.add({ id, cron: "* * * * *", task: "advisory test", flags: { maxTurns: 1 } });
  await buildProgram({ config: { cwd: f.cwd, home: f.home } }).parseAsync(["schedule", "tick", "--execute", "--trust",
    ...(source === "flag" ? ["--daily-cap", "0.000020"] : [])], { from: "user" });
  expect(fetch).toHaveBeenCalledTimes(1); expect(process.exitCode).toBe(1);
  const receipts = (await readFile(join(f.cwd, ".agentrig/schedule.log"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(receipts.map(r => r.outcome)).toEqual(["done", "budget"]);
  const logs = new SessionStore({ root: join(f.cwd, ".agentrig/raw/sessions") });
  const events = (await Promise.all((await logs.list()).map(s => logs.readAll(s.id)))).flat();
  expect(events.some(e => e.type === "budget.cap")).toBe(true);
  expect(events.filter(e => e.type === "run.scheduled")).toHaveLength(2);
});

it("actual controller /cost renders the completed current run and performs no new model call", async () => {
  const f = await fixture(); const ledger = new SpendLedger(f.cwd); let calls = 0;
  await writeFile(join(f.cwd, "cost.txt"), "$999 cost: this is tool text, not accounting");
  const raw = { id: "fixture", model: "fixture", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 10 },
    async *stream() { calls++; yield { type: "usage" as const, usage: { input: 5, output: 5 } };
      if (calls === 1) { yield { type: "tool_use" as const, id: "cost-file", name: "read_file", input: { path: "cost.txt" } }; yield { type: "stop" as const, reason: "tool_use" as const }; }
      else yield { type: "stop" as const, reason: "end_turn" as const }; } };
  const provider = meterProvider(raw, ledger, { segment: "auxiliary", pricing: { inputUsdPerMTok: 1, outputUsdPerMTok: 1 } });
  const agent = createAgent({ provider, store: new SessionStore({ root: f.logs }), tools: [readFileTool()], permissions: new RulePolicy([{ match: "read_file", decision: "allow" }]),
    systemPrompt: "", spend: { ledger }, maxTokensPerTurn: 10 });
  const controller = new TuiController({ cwd: f.cwd, model: "fixture", agent });
  controller.setCost(session => costLines(ledger, session));
  await controller.submit("fixture"); await controller.submit("/cost");
  const text = JSON.stringify(controller.snapshot().lines);
  expect(text).toContain("Current run segment"); expect(text).toContain("$0.000020"); expect(text).toContain("Not an invoice");
  expect(text).toContain("read 1 file");
  await controller.submit("/verbose"); await controller.submit("/cost"); await controller.submit("/verbose"); await controller.submit("/cost");
  expect(controller.snapshot().lines.filter(line => line.text.includes("$0.000020")).length).toBeGreaterThanOrEqual(3);
  expect((await ledger.report("2000-01-01")).estimatedMicros).toBe(20); expect(calls).toBe(2); await controller.submit("/quit");
});

it("actual Web ACP uses the shared capped adapter: first prompt settles, second never fetches", async () => {
  const f = await fixture(); const fetch = vi.fn(async () => new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }));
  vi.stubGlobal("fetch", fetch);
  let ready!: (server: Awaited<ReturnType<typeof serveWeb>>) => void;
  const started = new Promise<Awaited<ReturnType<typeof serveWeb>>>(resolve => { ready = resolve; });
  const running = buildProgram({ config: { cwd: f.cwd, home: f.home }, web: { ready } }).parseAsync([
    "web", "--trust", "--provider", "openai", "--model", "fixture", "--daily-cap", "0.000020",
    "--price-in", "1", "--price-out", "1", "--max-tokens-per-turn", "10", "--no-supervise",
  ], { from: "user" });
  const server = await Promise.race([started, running.then(() => { throw Error("Web exited before ready"); })]);
  const client = await connect(server);
  try {
    await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const created = await client.request("session/new", { cwd: f.cwd, mcpServers: [] });
    expect(created.error).toBeUndefined(); const sessionId = created.result.sessionId;
    for (let i = 0; i < 2; i++) await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello" }] });
    expect(fetch).toHaveBeenCalledTimes(1);
    const store = new SessionStore({ root: f.logs });
    const events = (await Promise.all((await store.list()).map(s => store.readAll(s.id)))).flat();
    expect(events.filter(e => e.type === "budget.cap")).toHaveLength(1);
    expect(events.filter(e => e.type === "session.end").map(e => e.reason)).toEqual(["done", "budget"]);
    expect(await new SpendLedger(f.cwd).report("2000-01-01")).toMatchObject({ calls: 1, completeCalls: 1, estimatedMicros: 20, unknownSegments: 0 });
  } finally { await client.close(); await server.close(); await running; }
}, 15000);

it.each([100, 2000])("actual ACP reviewer retains session accounting and cap events (cap=%i)", async cap => {
  const f = await fixture();
  await writeFile(join(f.cwd, ".agentrig/config.json"), JSON.stringify({ root: f.logs, repoMap: false, packages: false,
    extensionDiscovery: false, skillDiscovery: false, contextWindow: 10,
    providers: { review: { provider: "openai", model: "review", contextWindow: 10 } }, roles: { supervisor: "review" } }));
  let mainCalls = 0, reviewCalls = 0, release!: () => void;
  const attempted = new Promise<void>(resolve => { release = resolve; });
  const original = supervisor.supervise;
  vi.spyOn(supervisor, "supervise").mockImplementation((session, options) => {
    const reviewer = options!.reviewer!;
    return original(session, { ...options, errorBurst: { minSamples: 1 }, ladder: { ladder: ["run_reviewer"], maxInterventions: 1 },
      reviewer: { async review(input, opts) { try { return await reviewer.review(input, opts); } finally { release(); } } } });
  });
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)); let delta: object;
    if (req.model === "review") { reviewCalls++; delta = { content: JSON.stringify({ diagnosis: "fixture", guidance: "", directions: [] }) }; }
    else if (++mainCalls === 1) delta = { tool_calls: [{ index: 0, id: "missing", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "missing.txt" }) } }] };
    else { await attempted; delta = { content: "done" }; }
    return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: mainCalls === 1 && req.model !== "review" ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  }));
  let ready!: (s: Awaited<ReturnType<typeof serveWeb>>) => void;
  const started = new Promise<Awaited<ReturnType<typeof serveWeb>>>(resolve => { ready = resolve; });
  const running = buildProgram({ config: { cwd: f.cwd, home: f.home }, web: { ready } }).parseAsync([
    "web", "--trust", "--provider", "openai", "--model", "fixture", "--daily-cap", String(cap / 1_000_000),
    "--price-in", "1", "--price-out", "1", "--max-tokens-per-turn", "10", "--supervise", "--supervisor-review",
  ], { from: "user" });
  const server = await Promise.race([started, running.then(() => { throw Error("Web exited before ready"); })]);
  const client = await connect(server);
  try {
    await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const sessionId = (await client.request("session/new", { cwd: f.cwd, mcpServers: [] })).result.sessionId;
    await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Read missing.txt" }] });
    expect(mainCalls).toBe(2); expect(reviewCalls).toBe(cap === 100 ? 0 : 1);
    const store = new SessionStore({ root: f.logs }); const sessions = await store.list(); expect(sessions).toHaveLength(1);
    const events = await store.readAll(sessions[0]!.id);
    expect(events.filter(e => e.type === "budget.cap")).toHaveLength(cap === 100 ? 1 : 0);
    const records = await new SpendLedger(f.cwd).records(); const admissions = records.filter(r => r.type === "admit");
    expect(admissions).toHaveLength(cap === 100 ? 2 : 3);
    expect(admissions.every(r => r.session === sessions[0]!.id)).toBe(true);
    expect(new Set(admissions.map(r => r.segment)).size).toBe(1);
    expect(events.at(-1)?.type).toBe("session.end");
  } finally { release(); await client.close(); await server.close(); await running; }
}, 15000);

it.each([20, 40])("native output validates the real adapter before metering and charges repair admission (cap=%i)", async cap => {
  const f = await fixture(); const requests: any[] = [];
  await writeFile(join(f.cwd, "schema.json"), JSON.stringify({ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false }));
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    const content = requests.length === 1 ? "invalid" : '{"ok":true}';
    return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  }); vi.stubGlobal("fetch", fetch);
  await buildProgram({ config: { cwd: f.cwd, home: f.home } }).parseAsync(["run", "produce object", "--trust", "--provider", "openai", "--model", "fixture",
    "--daily-cap", String(cap / 1_000_000), "--price-in", "1", "--price-out", "1", "--max-tokens-per-turn", "10", "--max-turns", "2",
    "--output-schema", join(f.cwd, "schema.json"), "--output-mode", "native"], { from: "user" });
  expect(process.exitCode ?? 0, vi.mocked(console.error).mock.calls.flat().join("\n")).toBe(cap === 40 ? 0 : 1);
  expect(fetch).toHaveBeenCalledTimes(cap === 40 ? 2 : 1);
  expect(requests.every(r => r.response_format?.type === "json_schema")).toBe(true);
  expect(await new SpendLedger(f.cwd).report("2000-01-01")).toMatchObject({ estimatedMicros: cap, calls: cap / 20 });
});

it("actual named provider construction meters each cached or lazy entry exactly once", async () => {
  const f = await fixture(); const ledger = new SpendLedger(f.cwd);
  const fetch = vi.fn(async () => new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }));
  vi.stubGlobal("fetch", fetch);
  const meter = vi.fn((provider: Parameters<typeof meterProvider>[0]) => meterProvider(provider, ledger,
    { segment: "construction", pricing: { inputUsdPerMTok: 1, outputUsdPerMTok: 1 }, boundedProvider: true, capMicros: 100 }));
  const set = providers.buildProviders({ provider: "openai", model: "fixture", modelExplicit: true, contextWindow: 10, dailyCap: "0.000100",
    providers: { lazy: { provider: "openai", model: "other", contextWindow: 10 } } }, { meter });
  expect(set.main).toBe(set.supervisor); expect(set.get("default")).toBe(set.main); expect(meter).toHaveBeenCalledTimes(1);
  const lazy = set.get("lazy"); expect(set.get("lazy")).toBe(lazy); expect(meter).toHaveBeenCalledTimes(2);
  for (const provider of [set.main, lazy]) for await (const _ of provider.stream({ system: "", messages: [], tools: [], maxTokens: 10 }, new AbortController().signal)) { /* consume */ }
  expect(fetch).toHaveBeenCalledTimes(2); expect(await ledger.report("2000-01-01")).toMatchObject({ calls: 2, estimatedMicros: 40 });
});
