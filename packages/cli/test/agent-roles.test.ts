import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionStore } from "@agentkitai/agentrig-core";
import { buildProgram } from "../src/program.js";
import { renderChatEvent, renderEvent } from "../src/render.js";
import * as providers from "../src/provider.js";
import { buildAgent } from "../src/agent-builder.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it.each([undefined, "2", "2.0"])("actual trusted CLI role discovery reaches the child request and blocks bash despite YOLO (turns=%s)", async turns => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-cli-roles-"))); roots.push(root);
  const cwd = join(root, "project"), home = join(root, "home"), logs = join(root, "logs");
  await mkdir(join(cwd, ".agentrig", "agents"), { recursive: true }); await mkdir(home);
  await writeFile(join(cwd, ".agentrig", "agents", "reader.md"), '---\ntools: ["read_file"]\nmax-turns: 2\n---\nROLE FIXTURE: inspect only.');
  await writeFile(join(cwd, ".agentrig", "config.json"), JSON.stringify({ root: logs, repoMap: false,
    packages: false, extensionDiscovery: false, skillDiscovery: false, subagents: true }));
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  vi.stubEnv("OPENAI_API_KEY", "fixture-not-a-credential"); vi.stubEnv("LORE_API_URL", ""); vi.stubEnv("LORE_API_KEY", "");
  vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
  const requests: any[] = []; let children = 0, parents = 0;
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body); requests.push(request);
    const child = JSON.stringify(request.messages.filter((m: any) => m.role === "system")).includes("ROLE FIXTURE");
    const first = child ? ++children === 1 : ++parents === 1;
    const name = child ? "bash" : "subagent";
    const input = child ? { command: `${JSON.stringify(process.execPath)} -e 'require("fs").writeFileSync("escaped", "yes")'` }
      : { task: "inspect the project", agent: "reader" };
    const delta = first ? { tool_calls: [{ index: 0, id: child ? "blocked" : "spawn", type: "function",
      function: { name, arguments: JSON.stringify(input) } }] } : { content: "done" };
    res.setHeader("content-type", "text/event-stream");
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: first ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); if (!address || typeof address === "string") throw Error("fixture address");
    await buildProgram({ config: { cwd, home } }).parseAsync(["run", "delegate inspection", "--trust", "--yolo",
      "--provider", "openai", "--model", "fixture", "--base-url", `http://127.0.0.1:${address.port}/v1`, "--max-turns", "3",
      ...(turns === undefined ? [] : ["--subagent-max-turns", turns])], { from: "user" });
    expect(process.exitCode ?? 0, vi.mocked(console.error).mock.calls.flat().join("\n")).toBe(0);
    expect(children).toBe(2); expect(parents).toBe(2);
    const childRequests = requests.filter(r => JSON.stringify(r.messages.filter((m: any) => m.role === "system")).includes("ROLE FIXTURE"));
    expect(childRequests[0].tools.map((t: any) => t.function.name)).toEqual(["read_file"]);
    await expect(readFile(join(cwd, "escaped"))).rejects.toMatchObject({ code: "ENOENT" });
    const store = new SessionStore({ root: logs }); const events = (await Promise.all((await store.list()).map(s => store.readAll(s.id)))).flat();
    const spawn = events.find(e => e.type === "subagent.spawn");
    expect(spawn).toMatchObject({ role: { name: "reader", tools: ["read_file"], maxTurns: 2, delegable: false } });
    expect(events).toContainEqual(expect.objectContaining({ type: "tool.denied", name: "bash" }));
    expect(renderEvent(spawn!)).toContain("role=reader"); expect(renderChatEvent(spawn!)).toContain("reader");
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
}, 30_000);

it.each(["flag", "config-number", "config-string"])("actual CLI refuses fractional subagent turns before provider construction (%s)", async source => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-turn-limit-"))); roots.push(root);
  const cwd = join(root, "project"), home = join(root, "home");
  await mkdir(join(cwd, ".agentrig"), { recursive: true }); await mkdir(home);
  await writeFile(join(cwd, ".agentrig/config.json"), JSON.stringify({ subagents: true,
    ...(source === "flag" ? {} : { subagentMaxTurns: source === "config-number" ? 1.5 : "1.5" }) }));
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  const construct = vi.spyOn(providers, "buildProviders").mockImplementation(() => { throw Error("PROVIDER_CONSTRUCTION_CANARY"); });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  await buildProgram({ config: { cwd, home } }).parseAsync(["run", "task", "--trust", "--provider", "openai", "--model", "fixture",
    ...(source === "flag" ? ["--subagent-max-turns", "1.5"] : [])], { from: "user" });
  expect(process.exitCode).toBe(1); expect(construct).not.toHaveBeenCalled();
  expect(error.mock.calls.flat().join("\n")).toMatch(/integer/);
});

it.each(["1.5", "0", "NaN", "Infinity", "9007199254740992"])("direct builder refuses invalid subagent turn count %s before providers", async subagentMaxTurns => {
  const construct = vi.spyOn(providers, "buildProviders").mockImplementation(() => { throw Error("PROVIDER_CONSTRUCTION_CANARY"); });
  await expect(buildAgent({ provider: "openai", model: "fixture", subagentMaxTurns })).rejects.toThrow(/integer/);
  expect(construct).not.toHaveBeenCalled();
});
