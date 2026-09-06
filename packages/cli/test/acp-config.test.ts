import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { client, ndJsonStream } from "@agentclientprotocol/sdk";
import { RulePolicy, type ModelProvider } from "@agentkitai/agentrig-core";
import { matchAcpMcp } from "../src/acp.js";
import { buildProgram } from "../src/program.js";
import type { AgentBuildOptions, BuiltAgent } from "../src/agent-builder.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0).reverse()) await fn(); });

it("matches exact trusted stdio config and refuses changed command/args/env/duplicate or HTTP without echoing secrets", () => {
  const secret = "SECRET-ACP-CREDENTIAL";
  const server = { name: "fixture", command: process.execPath, args: ["server.cjs"], env: [{ name: "TOKEN", value: secret }] };
  const trusted = [{ name: "fixture", command: process.execPath, args: ["server.cjs"], env: { TOKEN: secret } }];
  const request = { cwd: process.cwd(), mcpServers: [server] };
  expect(matchAcpMcp(request, trusted)[0]).toMatchObject({ cwd: process.cwd(), env: { TOKEN: secret } });
  for (const candidate of [ { ...server, command: `${process.execPath}-other` }, { ...server, args: [secret] },
    { ...server, env: [{ name: "TOKEN", value: `${secret}-other` }] }, { ...server, name: "unknown" },
    { ...server, env: [...server.env, ...server.env] } ]) {
    try { matchAcpMcp({ ...request, mcpServers: [candidate] }, trusted); throw new Error("must refuse"); }
    catch (error) { expect(String(error)).not.toContain(secret); expect(String(error)).not.toContain("must refuse"); }
  }
  expect(() => matchAcpMcp({ ...request, mcpServers: [server, server] }, trusted)).toThrow();
  expect(() => matchAcpMcp({ ...request, mcpServers: [{ type: "http", name: "fixture", url: "http://127.0.0.1", headers: [] }] }, trusted)).toThrow();
});

it("actual program resolves each client cwd separately; --trust cannot authorize another project or initialize a provider early", async () => {
  const holder = await mkdtemp(join(tmpdir(), "agentrig-acp-config-")); cleanup.push(() => rm(holder, { recursive: true, force: true }));
  const target = join(holder, "physical"); await mkdir(target);
  const root = join(holder, "alias"); await symlink(target, root, process.platform === "win32" ? "junction" : "dir");
  const home = join(root, "home"); const launch = join(root, "launch"); const other = join(root, "other");
  await mkdir(home); for (const cwd of [launch, other]) {
    await mkdir(join(cwd, ".agentrig"), { recursive: true });
    await writeFile(join(cwd, ".agentrig", "config.json"), JSON.stringify({ system: cwd === launch ? "trusted launch prompt" : "MUST NOT LOAD OTHER PROJECT" }));
  }
  const canonicalLaunch = await realpath(launch); const canonicalOther = await realpath(other);
  vi.spyOn(console, "error").mockImplementation(() => {});
  const input = new PassThrough(); const output = new PassThrough(); const captured: AgentBuildOptions[] = [];
  const index = vi.fn(async () => [{ path: "fixture.md", summary: "fixture" }]);
  const provider: ModelProvider = { id: "fixture", model: "fixture", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 1000 }, async *stream() { throw new Error("must not invoke provider"); } };
  const program = buildProgram({ config: { cwd: launch, home, env: {} }, acp: { input, output, build: async opts => {
    captured.push(opts);
    return { agent: { run() { throw new Error("not needed"); } }, provider, providers: {} as BuiltAgent["providers"],
      permissions: new RulePolicy([{ tool: "memory_search", decision: opts.extensionCwd === canonicalLaunch ? "allow" : "deny" }]),
      memoryStore: { index } as unknown as BuiltAgent["memoryStore"], tools: [], skills: [], memoryIndex: "", mcp: [] } as BuiltAgent;
  } } });
  const running = program.parseAsync(["acp", "--trust", "--no-extension-discovery", "--no-skill-discovery"], { from: "user" });
  const peer = client().connect(ndJsonStream(Writable.toWeb(input), Readable.toWeb(output)));
  cleanup.push(async () => { peer.close(); input.destroy(); output.destroy(); await running; });
  await peer.agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} }); expect(captured).toHaveLength(0);
  const a = await peer.agent.request("session/new", { cwd: launch, mcpServers: [] });
  const b = await peer.agent.request("session/new", { cwd: other, mcpServers: [] });
  expect(captured[0]).toMatchObject({ trustedProjectRoot: canonicalLaunch, extensionCwd: canonicalLaunch, system: "trusted launch prompt", root: join(canonicalLaunch, ".agentrig", "raw", "sessions") });
  expect(captured[1]).toMatchObject({ extensionCwd: canonicalOther, root: join(canonicalOther, ".agentrig", "raw", "sessions") });
  expect(captured[1]!.trustedProjectRoot).toBeUndefined(); expect(captured[1]!.system).not.toBe("MUST NOT LOAD OTHER PROJECT");
  expect(process.cwd()).not.toBe(launch); expect(process.cwd()).not.toBe(other);
  const secret = "UNKNOWN-SERVER-SECRET";
  await expect(peer.agent.request("session/new", { cwd: other, mcpServers: [{ name: "unknown", command: process.execPath,
    args: [secret], env: [{ name: "TOKEN", value: secret }] }] })).rejects.toThrow("existing MCP pins using the CLI");
  expect(captured).toHaveLength(2); // rejection before provider/MCP builder, never host execution
  expect(vi.mocked(console.error).mock.calls.flat().join("\n")).not.toContain(secret);
  expect(await peer.agent.request("_agentrig/memory", { sessionId: a.sessionId })).toMatchObject({ lines: ["fixture.md — fixture"] });
  await expect(peer.agent.request("_agentrig/memory", { sessionId: b.sessionId })).rejects.toThrow();
  await expect(peer.agent.request("_agentrig/memory", { sessionId: a.sessionId, path: "../../secret" })).rejects.toThrow();
  expect(index).toHaveBeenCalledOnce();
});
