import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderConformance } from "@agentkitai/agentrig-core";
import { diagnose, type DoctorOptions } from "../src/doctor.ts";
import { buildProvider, resolveProviderEntries } from "../src/provider.ts";
import { providerProbeCachePath, providerProbeFingerprint, readProviderProbe, writeProviderProbe } from "../src/provider-probe-cache.ts";
import { buildProgram } from "../src/program.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of cleanup.splice(0)) await f(); });
async function temp() { const root = await mkdtemp(join(tmpdir(), "agentrig-probe-")); cleanup.push(() => rm(root, { recursive: true, force: true })); return root; }
const report = (now = Date.now()): ProviderConformance => ({ version: 1, observedAt: now, tools: "not-observed", parallelTools: "not-observed", promptedSchema: "observed", nativeStrictness: "unknown", caching: "observed", cacheReporting: "observed", streams: 5, retries: 0, usage: { input: 50, output: 10, cacheRead: 5 }, usageComplete: true });
async function fixture() {
  const root = await temp(); const home = join(root, "home"); const cwd = join(root, "project"); await mkdir(cwd);
  const opts: DoctorOptions = { home, cwd, env: {}, stdinTTY: false, stdoutTTY: false, probes: {
    boundary: async () => ({ projectRoot: cwd, userStateSafe: true }), gitState: async () => ({ inside: false }),
  } };
  return { root, home, cwd, opts };
}
it("normal doctor is network/cache-write free and never constructs provider; explicit flag is parsed", async () => {
  const f = await fixture(); const factory = vi.fn(() => { throw Error("must not build"); });
  const result = await diagnose({ ...f.opts, cli: { provider: "openai", model: "fixture", baseUrl: "http://127.0.0.1:1" }, probeFactory: factory });
  expect(factory).not.toHaveBeenCalled(); expect(result.lines.some(line => line.includes("probe:"))).toBe(false);
  await expect(readFile(providerProbeCachePath(f.home))).rejects.toMatchObject({ code: "ENOENT" });
  const program = buildProgram(); const cmd = program.commands.find(c => c.name() === "doctor")!; let parsed: unknown;
  cmd.action(opts => { parsed = opts; }); await program.parseAsync(["doctor", "--probe"], { from: "user" }); expect(parsed).toMatchObject({ probe: true });
});
it("explicit doctor probe uses actual local OpenAI SSE adapter, caches observations and affects builder capabilities", async () => {
  const f = await fixture(); const bodies: Record<string, any>[] = [];
  const server = createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk; const body = JSON.parse(text); bodies.push(body);
    const tools = body.tools ?? []; const roundtrip = body.messages.some((m: any) => m.role === "tool");
    const calls = tools.length === 1 && !roundtrip ? [{ index: 0, id: "echo", type: "function", function: { name: "probe_echo", arguments: '{"value":"probe"}' } }] :
      tools.length === 2 ? [{ index: 0, id: "a", type: "function", function: { name: "probe_alpha", arguments: '{"value":"alpha"}' } }, { index: 1, id: "b", type: "function", function: { name: "probe_beta", arguments: '{"value":"beta"}' } }] : undefined;
    const delta = calls === undefined ? { content: roundtrip ? "probe-result" : '{"ok":true,"value":7}' } : { tool_calls: calls };
    res.setHeader("content-type", "text/event-stream");
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: calls === undefined ? "stop" : "tool_calls" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 3 } } })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (address === null || typeof address === "string") throw Error("no listener");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`; const env = { OPENAI_API_KEY: "secret-fixture-key" };
  const result = await diagnose({ ...f.opts, env, cli: { provider: "openai", model: "fixture", baseUrl, probe: true } });
  expect(bodies).toHaveLength(5); expect(result.lines.join("\n")).toContain("tools=observed; parallelTools=observed; promptedSchema=observed; nativeStrictness=unknown");
  expect(result.lines.join("\n")).toContain("complete=true"); expect(result.lines.join("\n")).not.toContain(env.OPENAI_API_KEY);
  const path = providerProbeCachePath(f.home); const raw = await readFile(path, "utf8"); expect(raw).not.toContain(baseUrl); expect(raw).not.toContain(env.OPENAI_API_KEY); expect(raw).not.toContain("probe-result");
  const provider = buildProvider({ provider: "openai", model: "fixture", baseUrl, modelExplicit: true }, { env, conformanceCachePath: path });
  expect(provider.capabilities).toMatchObject({ tools: true, parallelTools: true, caching: true, conformance: { source: "observed" } });
  const fingerprint = providerProbeFingerprint({ provider: "openai", model: "fixture", baseUrl }, env)!;
  await writeProviderProbe(path, fingerprint, report());
  const limited = buildProvider({ provider: "openai", model: "fixture", baseUrl, modelExplicit: true }, { env, conformanceCachePath: path });
  expect(limited.capabilities).toMatchObject({ tools: false, parallelTools: false, caching: true });
  expect(bodies).toHaveLength(5); // loading observations never probes again
});
it("cache matches exact model/endpoint/tuning/credential, expires, and labels fallback unverified", async () => {
  const root = await temp(); const path = join(root, "cache.json"); const env = { OPENAI_API_KEY: "secret" };
  const entry = { provider: "openai" as const, model: "fixture", baseUrl: "http://127.0.0.1/v1", contextWindow: 10000 };
  const key = providerProbeFingerprint(entry, env)!; const now = Date.now(); await writeProviderProbe(path, key, report(now));
  expect(readProviderProbe(path, key, now)).toBeDefined(); expect(readProviderProbe(path, key, now - 1)).toBeUndefined(); expect(readProviderProbe(path, key, now + 86_400_001)).toBeUndefined();
  for (const patch of [{ model: "different" }, { baseUrl: "http://other/v1" }, { contextWindow: 9000 }, { reasoningEffort: "low" as const }]) {
    expect(readProviderProbe(path, providerProbeFingerprint({ ...entry, ...patch }, env)!, now)).toBeUndefined();
  }
  expect(providerProbeFingerprint(entry, { OPENAI_API_KEY: "other" })).not.toBe(key);
  const provider = buildProvider({ ...entry, model: "other", modelExplicit: true }, { env, conformanceCachePath: path });
  expect(provider.capabilities.conformance).toMatchObject({ source: "unverified-configured", sources: { tools: "unverified-configured" } });
});
it("bounded cache rejects malformed/oversized data and evicts oldest observations at 64 entries", async () => {
  const root = await temp(); const path = join(root, "cache.json");
  await writeFile(path, "x".repeat(131_073)); expect(readProviderProbe(path, "a".repeat(64))).toBeUndefined();
  await writeFile(path, '{"version":1,"entries":[{"report":{"tools":true}}]}'); expect(readProviderProbe(path, "a".repeat(64))).toBeUndefined();
  for (let i = 0; i < 65; i++) await writeProviderProbe(path, i.toString(16).padStart(64, "0"), report(1000 + i));
  expect(JSON.parse(await readFile(path, "utf8")).entries).toHaveLength(64); expect(readProviderProbe(path, "0".repeat(64), 1064)).toBeUndefined();
});
it("ChatGPT fingerprint follows file-first valid-token fallback without refresh or plaintext persistence", async () => {
  const root = await temp(); const path = join(root, "auth.json"); const entry = { provider: "openai-chatgpt" as const, model: "fixture" };
  const seed = JSON.stringify({ accessToken: "seed", refreshToken: "seed-refresh" }); const env = { AGENTRIG_OPENAI_CHATGPT_AUTH: path, AGENTRIG_OPENAI_CHATGPT_TOKEN: seed };
  const seeded = providerProbeFingerprint(entry, env); expect(seeded).toMatch(/^[a-f0-9]{64}$/);
  await writeFile(path, "bad"); expect(providerProbeFingerprint(entry, env)).toBe(seeded);
  await writeFile(path, JSON.stringify({ accessToken: "file", refreshToken: "file-refresh" })); expect(providerProbeFingerprint(entry, env)).not.toBe(seeded);
});
it("probe construction errors are secret-safe and never create cache; invalid config refuses construction", async () => {
  const f = await fixture(); const factory = vi.fn(() => { throw Error("SECRET endpoint?token=SECRET"); });
  const result = await diagnose({ ...f.opts, cli: { provider: "openai", model: "fixture", baseUrl: "http://127.0.0.1:1", probe: true }, probeFactory: factory });
  expect(factory).toHaveBeenCalledTimes(1); expect(result.exitCode).toBe(1); expect(result.lines.join("\n")).not.toContain("SECRET");
  await expect(readFile(providerProbeCachePath(f.home))).rejects.toMatchObject({ code: "ENOENT" });
  factory.mockClear(); await diagnose({ ...f.opts, cli: { provider: "openai", model: "fixture", baseUrl: "http://127.0.0.1:1", profile: "absent", probe: true }, probeFactory: factory });
  expect(factory).not.toHaveBeenCalled();
});
it("probe adapter transient retries are disabled: local 500 is one transport per outer sample", async () => {
  const f = await fixture(); let requests = 0; let probePhase = false;
  const server = createServer((_req, res) => { requests++;
    if (probePhase || requests === 1) { res.statusCode = 500; res.end("SECRET upstream body"); }
    else { res.setHeader("content-type", "text/event-stream"); res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (address === null || typeof address === "string") throw Error("no listener");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const ordinary = buildProvider({ provider: "openai", model: "fixture", modelExplicit: true, baseUrl }, { env: {}, conformanceCachePath: providerProbeCachePath(f.home) });
  for await (const _event of ordinary.stream({ system: "fixture", messages: [{ role: "user", content: [{ type: "text", text: "fixture" }] }], tools: [], maxTokens: 10 }, new AbortController().signal)) { /* ordinary retry remains enabled */ }
  expect(requests).toBe(2); requests = 0; probePhase = true;
  const result = await diagnose({ ...f.opts, cli: { provider: "openai", model: "fixture", baseUrl, probe: true } });
  expect(requests).toBe(4); expect(result.lines.join("\n")).toContain("tools=unknown"); expect(result.lines.join("\n")).toContain("complete=false"); expect(result.lines.join("\n")).not.toContain("SECRET");
});
it("only the resolved main entry is probed and credential changes during the sample prevent caching", async () => {
  const f = await fixture(); await mkdir(join(f.home, ".agentrig"), { recursive: true });
  await writeFile(join(f.home, ".agentrig", "config.json"), JSON.stringify({ providers: {
    chosen: { provider: "openai", model: "chosen-model", baseUrl: "http://127.0.0.1:1/v1" },
    unused: { provider: "anthropic", model: "unused-model" },
  }, roles: { main: "chosen" } }));
  const env = { OPENAI_API_KEY: "before", ANTHROPIC_API_KEY: "other-role" }; let builds = 0;
  const result = await diagnose({ ...f.opts, env, cli: { probe: true }, probeFactory: opts => {
    builds++; const resolved = resolveProviderEntries(opts); expect(resolved.roleNames.main).toBe("chosen");
    return { id: "fake", model: "chosen-model", capabilities: { tools: true, parallelTools: true, caching: false, contextWindow: 10000 },
      async *stream() { env.OPENAI_API_KEY = "after"; yield { type: "text_delta", text: "wrong" }; yield { type: "stop", reason: "end_turn" }; } };
  } });
  expect(builds).toBe(1); expect(result.lines.join("\n")).toContain("credential identity unavailable or changed");
  await expect(readFile(providerProbeCachePath(f.home))).rejects.toMatchObject({ code: "ENOENT" });
});
