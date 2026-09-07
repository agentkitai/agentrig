import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionStore, SpendLedger } from "@agentkitai/agentrig-core";
import { buildAgent, type BuiltAgent } from "../src/agent-builder.js";
import { buildProgram } from "../src/program.js";
import { TuiController } from "../src/tui/controller.js";
import { parseCommand } from "../src/tui/commands.js";
import { readOutputContract } from "../src/output-schema.js";
import { ProviderEntrySchema } from "../src/config.js";
import { renderChatEvent, renderEvent } from "../src/render.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); process.exitCode = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(extra: string[] = []) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-selection-"))); roots.push(root);
  const cwd = join(root, "project"), home = join(root, "home"), logs = join(root, "logs");
  await mkdir(join(cwd, ".agentrig"), { recursive: true }); await mkdir(home);
  await writeFile(join(cwd, "schema.json"), JSON.stringify({ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false }));
  await writeFile(join(cwd, ".agentrig/config.json"), JSON.stringify({ root: logs, repoMap: false, packages: false,
    extensionDiscovery: false, skillDiscovery: false, contextWindow: 10,
    providers: { second: { provider: "openai", model: "second-model", reasoningEffort: "low", contextWindow: 10 },
      foreign: { provider: "anthropic", model: "foreign-model" }, main: { provider: "openai", model: "ambiguous-name" } } }));
  vi.spyOn(process, "cwd").mockReturnValue(cwd); vi.stubEnv("OPENAI_API_KEY", "private-test-key"); vi.stubEnv("ANTHROPIC_API_KEY", "private-other-key");
  vi.stubEnv("LORE_API_URL", ""); vi.stubEnv("LORE_API_KEY", "");
  let built!: BuiltAgent;
  await buildProgram({ config: { cwd, home }, run: async (_task, opts) => { built = await buildAgent(opts,
    opts.outputSchema === undefined ? {} : { outputContract: await readOutputContract(join(cwd, opts.outputSchema), opts.outputMode ?? "prompted") }); } }).parseAsync([
    "run", "unused", "--trust", "--provider", "openai", "--model", "first-model", "--max-tokens-per-turn", "10", ...extra,
  ], { from: "user" });
  const controller = new TuiController({ cwd, model: built.provider.model, agent: built.agent }); controller.setProviderSelection(built.selection!);
  return { cwd, logs, built, controller };
}
function response(content = "done") { return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }); }

it("configured CLI switches reach actual next requests, preserve history and leave role providers unchanged", async () => {
  const requests: any[] = []; vi.stubGlobal("fetch", vi.fn(async (_url, init) => { requests.push(JSON.parse(init.body)); return response(); }));
  const f = await fixture(); const originalRole = f.built.providers.subagents;
  try {
    await f.controller.submit("first task");
    await f.controller.submit("/model"); await f.controller.submit("/effort"); expect(requests).toHaveLength(1);
    await f.controller.submit("/model second"); await f.controller.submit("/effort high"); expect(requests).toHaveLength(1);
    expect(f.controller.snapshot().providerSelection).toMatchObject({ entry: "second", effort: "high" });
    await f.controller.submit("second task");
    await f.controller.submit("/model second"); await f.controller.submit("third task");
    expect(requests.map(r => [r.model, r.reasoning_effort])).toEqual([["first-model", undefined], ["second-model", "high"], ["second-model", "low"]]);
    expect(JSON.stringify(requests[1].messages)).toContain("first task");
    expect(f.built.providers.subagents).toBe(originalRole); expect(f.built.provider.model).toBe("second-model");
    const store = new SessionStore({ root: f.logs }); const events = await store.readAll(f.controller.snapshot().sessionId!);
    expect(events.filter(e => e.type === "provider.switched").map(e => e.to.effort)).toEqual([undefined, "high", "low"]);
    expect(events.filter(e => e.type === "context.manifest").map(e => e.providerSelection?.entry)).toEqual(["default", "second", "second"]);
    expect(JSON.stringify(events)).not.toContain("private-test-key");
  } finally { await f.controller.submit("/quit"); }
});

it("busy and invalid selections never change the committed adapter or dispatch extra requests", async () => {
  let entered!: () => void, release!: () => void; const started = new Promise<void>(r => { entered = r; }); const held = new Promise<void>(r => { release = r; });
  const fetch = vi.fn(async () => { entered(); await held; return response(); }); vi.stubGlobal("fetch", fetch);
  const f = await fixture(); const running = f.controller.submit("task");
  try {
    await started; await f.controller.submit("/model second"); expect(f.built.provider.model).toBe("first-model");
    release(); await running;
    for (const command of ["/model nonexistent", "/model main", "/effort impossible", `/model ${"x".repeat(300)}`]) await f.controller.submit(command);
    expect(f.built.provider.model).toBe("first-model"); expect(fetch).toHaveBeenCalledTimes(1); expect(f.controller.snapshot().selecting).toBe(false);
    expect(parseCommand("/model second")).toEqual({ kind: "model", argument: "second" });
  } finally { release(); await running; await f.controller.submit("/quit"); }
});

it("switches share the daily allowance and cannot bypass metering via lazy effort variants", async () => {
  const fetch = vi.fn(async () => response()); vi.stubGlobal("fetch", fetch);
  const f = await fixture(["--daily-cap", "0.000040", "--price-in", "1", "--price-out", "1"]);
  try {
    await f.controller.submit("first"); await f.controller.submit("/model second"); await f.controller.submit("second");
    await f.controller.submit("/effort high"); await f.controller.submit("third");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await new SpendLedger(f.cwd).report("2000-01-01")).toMatchObject({ calls: 2, estimatedMicros: 40, unknownSegments: 0 });
    const events = await new SessionStore({ root: f.logs }).readAll(f.controller.snapshot().sessionId!);
    expect(events.filter(e => e.type === "budget.cap")).toHaveLength(1);
  } finally { await f.controller.submit("/quit"); }
});

it("native output prepares each real selected adapter before metering and refuses unsupported selection", async () => {
  const requests: any[] = []; vi.stubGlobal("fetch", vi.fn(async (_url, init) => { requests.push(JSON.parse(init.body)); return response('{"ok":true}'); }));
  const f = await fixture(["--output-schema", "schema.json", "--output-mode", "native", "--daily-cap", "0.000040", "--price-in", "1", "--price-out", "1"]);
  try {
    await f.controller.submit("first"); await f.controller.submit("/model second"); await f.controller.submit("/effort high");
    await f.controller.submit("/model foreign"); expect(f.controller.snapshot().providerSelection).toMatchObject({ entry: "second", effort: "high" });
    await f.controller.submit("second");
    expect(requests.map(r => r.model)).toEqual(["first-model", "second-model"]);
    expect(requests.every(r => r.response_format?.type === "json_schema")).toBe(true);
    expect(await new SpendLedger(f.cwd).report("2000-01-01")).toMatchObject({ calls: 2, estimatedMicros: 40 });
  } finally { await f.controller.submit("/quit"); }
});

it("a reentrant close invalidates prepared selection and clears its reservation", async () => {
  vi.stubGlobal("fetch", vi.fn()); const f = await fixture(); let committed = false;
  f.controller.setProviderSelection({ current: () => ({ entry: "default", provider: "openai", model: "first-model" }), describe: () => [],
    prepare: () => { void f.controller.submit("/quit"); return () => { committed = true; return { entry: "second", provider: "openai", model: "second-model" }; }; } });
  await f.controller.submit("/model second");
  expect(committed).toBe(false); expect(f.controller.snapshot().selecting).toBe(false);
});

it("bounded configured model names refuse before runtime or any fetch", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  expect(ProviderEntrySchema.safeParse({ provider: "openai", model: "m".repeat(129) }).success).toBe(false);
  await expect(fixture(["--model", "m".repeat(129)])).rejects.toThrow("provider selection names");
  expect(fetch).not.toHaveBeenCalled();
});

it("renders the canonical switch without inventing a previous selection", () => {
  const event = { type: "provider.switched" as const, sessionId: "s", seq: 2, ts: 0, turn: 3,
    to: { entry: "second", provider: "openai", model: "fixture", effort: "high" as const } };
  expect(renderEvent(event)).toContain("turn=3"); expect(renderEvent(event)).toContain('"effort":"high"');
  expect(renderChatEvent(event)).toContain("previous selection unknown");
  expect(renderChatEvent({ ...event, from: { ...event.to, entry: "first" } })).not.toContain("unknown");
});
