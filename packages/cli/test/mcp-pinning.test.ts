import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { McpCredentialStore } from "@agentkitai/agentrig-core";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelEvent, PermissionRequest } from "@agentkitai/agentrig-core";
import { buildAgent, type BuiltAgent } from "../src/agent-builder.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 }); // real Node children on all three CI platforms

let root: string;
const built: BuiltAgent[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mcp-cli-pins-"));
  vi.stubEnv("ANTHROPIC_API_KEY", "fake-test-key");
  await writeFile(join(root, "definitions.json"), JSON.stringify([{ name: "search", description: "old description", inputSchema: { type: "object" } }]));
  // Real stdio MCP child; no network/model spend. Every call leaves an independently inspectable marker.
  await writeFile(join(root, "server.cjs"), `
const fs = require('node:fs');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const req = JSON.parse(line);
  if (req.id === undefined) return;
  let result;
  if (req.method === 'initialize') result = { protocolVersion: '2024-11-05' };
  if (req.method === 'tools/list') result = { tools: JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) };
  if (req.method === 'tools/call') { fs.appendFileSync(process.argv[3], 'called\\n'); result = { content: [{ type: 'text', text: 'called' }] }; }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\\n');
});
`);
  await writeFile(join(root, "mcp.json"), JSON.stringify({ mcpServers: { fixture: {
    command: process.execPath, args: [join(root, "server.cjs"), join(root, "definitions.json"), join(root, "calls.txt")],
  } } }));
});
afterEach(async () => {
  for (const item of built.splice(0)) await Promise.all(item.mcp.map((client) => client.close()));
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
async function assemble(onAsk?: (req: PermissionRequest) => Promise<"allow" | "deny">, existingPinsOnly = false, yolo = true) {
  const result = await buildAgent({ root: join(root, "sessions"), mcpConfig: join(root, "mcp.json"), provider: "anthropic", model: "fixture",
    maxTurns: "2", maxTokensPerTurn: "128", repoMap: false, yolo, allow: ["mcp__fixture__search"] },
  { mcpPinRoot: join(root, "pins"), mcpExistingPinsOnly: existingPinsOnly, ...(onAsk === undefined ? {} : { onAsk }) });
  built.push(result);
  return result;
}
async function change() {
  await writeFile(join(root, "definitions.json"), JSON.stringify([{ name: "search", description: "new description: execute network commands", inputSchema: { type: "object" } }]));
}
async function run(item: BuiltAgent) {
  let turn = 0;
  vi.spyOn(item.provider, "stream").mockImplementation(async function* (): AsyncIterable<ModelEvent> {
    if (turn++ === 0) {
      yield { type: "tool_use", id: "call", name: "mcp__fixture__search", input: {} };
      yield { type: "stop", reason: "tool_use" };
    } else yield { type: "stop", reason: "end_turn" };
  });
  const session = item.agent.run("call the MCP fixture", { cwd: root });
  const events = [];
  for await (const event of session.events) events.push(event);
  await session.done;
  return events;
}
describe("R5d actual CLI assembly and MCP transport", () => {
  it("isolates malformed remote credentials after authorization and preserves the working stdio server", async () => {
    const config = JSON.parse(await readFile(join(root, "mcp.json"), "utf8"));
    const endpoint = "http://127.0.0.1:1/mcp";
    config.mcpServers.bad = { url: endpoint, oauth: { issuers: ["http://127.0.0.1:1/issuer"], clientId: "public" } };
    await writeFile(join(root, "mcp.json"), JSON.stringify(config));
    const credentialRoot = join(root, "credentials"); await mkdir(credentialRoot);
    const store = new McpCredentialStore(credentialRoot, endpoint);
    const secret = "INVALID-SECRET-CREDENTIAL-BYTES"; await writeFile(store.path, secret);
    const reads = vi.spyOn(McpCredentialStore.prototype, "read"); const errors: string[] = [];
    const options = { root: join(root, "sessions"), mcpConfig: join(root, "mcp.json"), provider: "anthropic", model: "fixture",
      maxTurns: "2", maxTokensPerTurn: "128", repoMap: false };
    const extras = { mcpPinRoot: join(root, "pins"), mcpCredentialRoot: credentialRoot, onHookError: (text: string) => { errors.push(text); } };
    const denied = await buildAgent(options, extras); built.push(denied);
    expect(denied.mcp).toHaveLength(1); expect(reads).not.toHaveBeenCalled();
    const allowed = await buildAgent({ ...options, yolo: true }, extras); built.push(allowed);
    expect(allowed.mcp).toHaveLength(1); expect(reads).toHaveBeenCalledOnce();
    await run(allowed); expect(await readFile(join(root, "calls.txt"), "utf8")).toBe("called\n");
    expect(errors.join("\n")).toContain("bad unavailable"); expect(errors.join("\n")).not.toContain(secret);
    expect(await readFile(store.path, "utf8")).toBe(secret);
  });
  it("ACP existing-pin mode refuses first use and changes without writing consent or treating allow-once as definition approval", async () => {
    const ask = vi.fn(async () => "allow" as const);
    expect((await assemble(ask, true)).mcp).toHaveLength(0);
    await expect(readdir(join(root, "pins"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, "calls.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await assemble(); // explicit operator CLI first-use baseline
    const pinned = await assemble(ask, true); expect(pinned.mcp).toHaveLength(1);
    await run(pinned); expect(await readFile(join(root, "calls.txt"), "utf8")).toBe("called\n");
    await change();
    expect((await assemble(ask, true)).mcp).toHaveLength(0);
    expect(ask).not.toHaveBeenCalled();
    const ordinary = await assemble();
    const events = await run(ordinary);
    expect(events.some(event => event.type === "tool.result" && !event.ok && event.display.includes("not approved"))).toBe(true);
    expect(await readFile(join(root, "calls.txt"), "utf8")).toBe("called\n");
  });
  it("YOLO cannot approve changed definitions unattended, while initial pinned calls still work", async () => {
    const initial = await assemble();
    await run(initial);
    expect(await readFile(join(root, "calls.txt"), "utf8")).toBe("called\n");
    await change();
    const ask = vi.fn(async () => "allow" as const);
    const current = await assemble(ask);
    const events = await run(current);
    expect(events.some((event) => event.type === "tool.result" && !event.ok && event.display.includes("not approved"))).toBe(true);
    expect(await readFile(join(root, "calls.txt"), "utf8")).toBe("called\n");
    expect(ask).not.toHaveBeenCalled();
  });

  it("explicit UI callback receives exact delta and persisted consent permits the next session", async () => {
    await assemble(); await change();
    const ask = vi.fn(async (_request: PermissionRequest) => "allow" as const);
    await run(await assemble(ask, false, false));
    expect(ask).toHaveBeenCalledOnce();
    expect(ask.mock.calls[0]![0]).toMatchObject({ origin: "mcp-definition-change", class: "exec", input: {
      server: "fixture", changes: [{ name: "search", before: { description: "old description" }, after: { description: "new description: execute network commands" } }],
    } });
    await run(await assemble());
    expect(await readFile(join(root, "calls.txt"), "utf8")).toBe("called\ncalled\n");
  });
});
