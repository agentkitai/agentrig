import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as core from "@agentkitai/agentrig-core";
import { SessionStore } from "@agentkitai/agentrig-core";
import { buildProgram } from "../src/program.js";
import { cliEnv } from "./cli-env.js";
import { defaultSystemPrompt } from "../src/run.js";
import * as providers from "../src/provider.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture(declared = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "builder-provider-run-"))); roots.push(root);
  const cwd = join(root, "project"), home = join(root, "home"), logs = join(root, "logs");
  await mkdir(join(cwd, ".agentrig"), { recursive: true }); await mkdir(home);
  await writeFile(join(cwd, ".agentrig/config.json"), JSON.stringify({ ingestOnEnd: false, root: logs, repoMap: false,
    packages: false, extensionDiscovery: false, skillDiscovery: false, subagents: false,
    ...(declared ? { providers: { sol: { provider: "openai", model: "builder-model" } } } : {}) }));
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  vi.stubEnv("OPENAI_API_KEY", "fixture-key"); vi.stubEnv("LORE_API_URL", ""); vi.stubEnv("LORE_API_KEY", "");
  vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
  return { cwd, home, logs };
}
it.each(["default", "constructor", "toString"])("run refuses undeclared builder %s before provider construction", async entry => {
  const { cwd, home } = await fixture(false);
  const construct = vi.spyOn(providers, "buildProviders").mockImplementation(() => { throw Error("PROVIDER_CANARY"); });
  await buildProgram({ config: { cwd, home, env: cliEnv() } }).parseAsync(["run", "task", "--trust", "--builder-provider", entry], { from: "user" });
  expect(process.exitCode).toBe(1);
  expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain(`unknown builder provider entry "${entry}"`);
  expect(construct).not.toHaveBeenCalled();
});

it.each([undefined, "CUSTOM SYSTEM: keep exactly this base"])("real request appends builder routing after normal base resolution (system=%s)", async system => {
  const { cwd, home, logs } = await fixture();
  await writeFile(join(cwd, "CLAUDE.md"), "PROJECT INSTRUCTION CANARY");
  const requests: Array<{ model: string; messages: Array<{ role: string; content: string }> }> = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.setHeader("content-type", "text/event-stream");
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); if (!address || typeof address === "string") throw Error("fixture address");
    await buildProgram({ config: { cwd, home, env: cliEnv() } }).parseAsync(["run", "task", "--trust", "--headless", "--json",
      "--provider", "openai", "--model", "conductor-model", "--base-url", `http://127.0.0.1:${address.port}/v1`,
      "--max-turns", "1", "--builder-provider", "sol", ...(system === undefined ? [] : ["--system", system])], { from: "user" });
    expect(process.exitCode ?? 0, vi.mocked(console.error).mock.calls.flat().join("\n")).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.model).toBe("conductor-model");
    const prompt = requests[0]!.messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
    const base = system ?? defaultSystemPrompt(cwd);
    const routing = `Train builder provider entry: "sol". See ship's builder routing rule.`;
    expect(prompt).toContain(base);
    expect(prompt).toContain(routing);
    expect(prompt.indexOf(routing)).toBeGreaterThan(prompt.indexOf(base));
    expect(prompt).toContain("PROJECT INSTRUCTION CANARY");
    expect(prompt.indexOf("PROJECT INSTRUCTION CANARY")).toBeGreaterThan(prompt.indexOf(routing));
    if (system !== undefined) expect(prompt).not.toContain(defaultSystemPrompt(cwd));
    const store = new SessionStore({ root: logs });
    const events = (await Promise.all((await store.list()).map(s => store.readAll(s.id)))).flat();
    const manifest = events.find(e => e.type === "context.manifest");
    expect(manifest?.type).toBe("context.manifest");
    if (manifest?.type !== "context.manifest") throw Error("missing manifest");
    expect(manifest.blocks).toContainEqual(expect.objectContaining({ source: "system_prompt", origin: system === undefined ? "cli:default-system" : "cli:--system" }));
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
});

it.each([
  { agent: "legacy-ship-builder", count: 0, wide: false },
  { agent: "legacy-ship-fixer", count: 0, wide: false },
  { agent: "legacy-ship-builder-1", count: 2, wide: false },
  { agent: "legacy-ship-builder", count: 30, wide: false },
  { agent: undefined, count: 31, wide: false },
  { agent: undefined, count: 32, wide: false },
  { agent: undefined, count: 0, wide: true },
])("legacy CLI preserves runtime capabilities $agent/$count/$wide", async ({ agent, count, wide }) => {
  const { cwd, home, logs } = await fixture();
  await writeFile(join(cwd, "large.txt"), "x".repeat(40000) + "RECOVERY_CANARY");
  if (count) {
    await mkdir(join(cwd, ".agentrig/agents"));
    for (let i = 0; i < count; i++) {
      const name = count === 2 && i === 0 ? "legacy-ship-builder" : count === 2 && i === 1 ? "legacy-ship-fixer" : `role-${i}`;
      await writeFile(join(cwd, `.agentrig/agents/${name}.md`), '---\ntools: ["read_file"]\n---\nPROJECT ROLE CANARY');
    }
  }
  if (wide) {
    const builtins = core.builtinTools;
    vi.spyOn(core, "builtinTools").mockImplementation(options => {
      const tools = builtins(options);
      return [...tools, ...Array.from({ length: 65 }, (_, i) => ({ ...tools[0]!, name: `extra_${i}` }))];
    });
  }
  const requests: Array<{ model: string; messages: Array<{ role: string; content: string }>; tools: Array<{ function: { name: string } }> }> = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body); requests.push(request);
    const call = (name: string, args: unknown) => ({ tool_calls: [{ index: 0, id: `call-${requests.length}`, type: "function",
      function: { name, arguments: JSON.stringify(args) } }] });
    let delta: object = { content: "done" };
    if (requests.length === 1) delta = call("subagent", { task: "Read large.txt and recover overflow", ...(agent ? { agent } : { provider: "sol" }) });
    if (requests.length === 2) delta = call("read_file", { path: "large.txt" });
    if (requests.length === 3) {
      const text = request.messages.map((m: { content: unknown }) => typeof m.content === "string" ? m.content : "").join("\n");
      const handle = /read_output (\{"seq":\d+,"from":\d+,"to":\d+\})/.exec(text);
      delta = call("read_output", handle ? JSON.parse(handle[1]!) : { seq: 0, from: 0, to: 1 });
    }
    res.setHeader("content-type", "text/event-stream");
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); if (!address || typeof address === "string") throw Error("fixture address");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    await writeFile(join(cwd, ".agentrig/config.json"), JSON.stringify({ ingestOnEnd: false, root: logs, repoMap: false,
      packages: false, extensionDiscovery: false, skillDiscovery: false, subagents: true,
      providers: { sol: { provider: "openai", model: "builder-model", baseUrl } } }));
    await buildProgram({ config: { cwd, home, env: cliEnv() } }).parseAsync(["run", "task", "--trust", "--headless", "--json",
      "--provider", "openai", "--model", "conductor-model", "--base-url", baseUrl,
      "--max-turns", "2", "--yolo", "--builder-provider", "sol"], { from: "user" });
    expect(process.exitCode ?? 0, vi.mocked(console.error).mock.calls.flat().join("\n")).toBe(0);
    expect(requests.map(request => request.model)).toEqual(["conductor-model", "builder-model", "builder-model", "builder-model", "conductor-model"]);
    const store = new SessionStore({ root: logs });
    const events = (await Promise.all((await store.list()).map(session => store.readAll(session.id)))).flat();
    if (agent) expect(events).toContainEqual(expect.objectContaining({ type: "subagent.spawn", role: expect.objectContaining({ name: agent, provider: "sol" }) }));
    else expect(events.find(event => event.type === "subagent.spawn")).not.toHaveProperty("role");
    const childTools = requests[1]!.tools.map(tool => tool.function.name);
    expect(childTools).toContain("read_output");
    expect(childTools).toEqual(expect.arrayContaining(requests[0]!.tools.map(tool => tool.function.name).filter(name => name !== "subagent")));
    expect(requests[3]!.messages.filter(message => message.role === "tool").map(message => message.content).join("\n")).toContain("RECOVERY_CANARY");
    if (!agent) expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain("explicit-provider fallback");
    if (agent) expect(requests[1]!.messages.filter(message => message.role === "system").map(message => message.content).join("\n"))
      .toContain(`Act as the ship ${agent.includes("fixer") ? "fixer" : "builder"}`);
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toMatch(/deprecated.*provider-bound role/);
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
});
