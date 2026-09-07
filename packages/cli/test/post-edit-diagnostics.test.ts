import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionStore } from "@agentkitai/agentrig-core";
import { errorBurstDetector, initialState, reduce } from "@agentkitai/agentrig-supervisor";
import { buildProgram } from "../src/program.js";
import { renderChatEvent, renderEvent } from "../src/render.js";
import { redactExportMessages } from "../src/session-export.js";
import { heartbeatBuildOptions } from "../src/agent-builder.js";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it("actual configured CLI/adapter edit returns tsc diagnostics, logs/render/export retain them, and heartbeat disables checking", async () => {
  const compiler = resolve("node_modules/typescript/bin/tsc");
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-cli-diagnostics-"))); roots.push(root);
  const cwd = join(root, "project"), home = join(root, "home"), logs = join(root, "logs");
  await mkdir(cwd); await mkdir(home); await mkdir(join(cwd, ".agentrig"));
  await writeFile(join(cwd, "target.ts"), "const x: number = 1;\n");
  const diagnostics = [{ parser: "tsc", extensions: [".ts"], executable: process.execPath,
    args: [compiler, "--noEmit", "--pretty", "false", "--skipLibCheck", "--noResolve", "--lib", "es2022", "target.ts"] }];
  await writeFile(join(cwd, ".agentrig/config.json"), JSON.stringify({ ingestOnEnd: false, root: logs, diagnostics,
    repoMap: false, packages: false, extensionDiscovery: false, skillDiscovery: false }));
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  vi.stubEnv("OPENAI_API_KEY", "fixture-not-a-credential"); vi.stubEnv("LORE_API_URL", ""); vi.stubEnv("LORE_API_KEY", "");
  vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const delta = requests.length === 1 ? { tool_calls: [{ index: 0, id: "edit", type: "function", function: {
      name: "edit_file", arguments: JSON.stringify({ path: "target.ts", oldText: "1", newText: '"secret-fixture"' }) } },
      { index: 1, id: "second", type: "function", function: { name: "edit_file", arguments: JSON.stringify({ path: "target.ts", oldText: '"secret-fixture"', newText: '"secret-fixture-2"' }) } }] } : { content: "diagnostics received" };
    res.setHeader("content-type", "text/event-stream");
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: requests.length === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture address");
    await buildProgram({ config: { cwd, home } }).parseAsync(["run", "edit the file", "--trust", "--provider", "openai", "--model", "fixture",
      "--base-url", `http://127.0.0.1:${address.port}/v1`, "--allow", "write", "--allow", "exec:anywhere", "--max-turns", "3"], { from: "user" });
    expect(process.exitCode ?? 0, vi.mocked(console.error).mock.calls.flat().join("\n")).toBe(0);
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.filter((m: any) => m.role === "tool")).toHaveLength(2);
    expect(requests[1].messages.find((m: any) => m.role === "tool").content).toContain("TS2322");
    expect(requests[0].tools.some((t: any) => t.function.name === "core:diagnostics")).toBe(false);
    const store = new SessionStore({ root: logs }); const sessions = await store.list();
    const events = await store.readAll(sessions[0]!.id);
    const state = initialState(), detector = errorBurstDetector();
    const signals = events.flatMap(event => { reduce(state, event); const signal = detector.observe(event, state); return signal === null ? [] : [signal]; });
    expect(signals).toEqual([]); expect(state.toolErrors).toBe(0);
    const result = events.find(e => e.type === "tool.result" && e.id === "edit");
    if (result?.type !== "tool.result") throw new Error("missing result");
    expect(result.diagnostics?.entries[0]?.code).toBe("TS2322");
    expect(renderEvent(result)).toContain("diagnostics=reported entries=1"); expect(renderChatEvent(result)).toContain("1 touched-file");
    const messages = await store.materializeMessages(sessions[0]!.id);
    const block = messages.flatMap(m => m.content).find(b => b.type === "tool_result");
    if (block?.type !== "tool_result" || !block.diagnostics) throw new Error("missing diagnostic metadata");
    block.diagnostics.entries[0]!.message = "secret-fixture";
    expect(JSON.stringify(redactExportMessages(messages, ["secret-fixture"]).messages)).not.toContain("secret-fixture");
    expect(await readFile(join(cwd, "target.ts"), "utf8")).toContain("secret-fixture");
    expect(heartbeatBuildOptions({ provider: "openai", model: "fixture", maxTurns: "1", maxTokensPerTurn: "100", root: logs, heartbeat: "checklist", diagnostics } as any).diagnostics).toEqual([]);
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
}, 30_000);
