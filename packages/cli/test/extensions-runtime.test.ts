import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionStore, type ModelProvider, type ModelRequest } from "@agentkitai/agentrig-core";
import { buildProgram } from "../src/program.ts";
import { buildAgent, type BuiltAgent } from "../src/agent-builder.ts";
import { TuiController } from "../src/tui/controller.ts";
import { renderEvent } from "../src/render.ts";
import { extensionFixture } from "../../core/test/fixtures/extensions.ts";
import { parseConfigText, resolveConfig } from "../src/config.ts";

let provider: ModelProvider;
vi.mock("../src/provider.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/provider.ts")>();
  return { ...actual, buildProviders: () => ({ main: provider, memory: provider, supervisor: provider, subagents: provider,
    names: ["fixture"], roleNames: { main: "fixture", memory: "fixture", supervisor: "fixture", subagents: "fixture" }, get: () => provider }) };
});
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-extension-cli-"))); roots.push(root);
  const cwd = join(root, "project"); const home = join(root, "home");
  await mkdir(cwd); await mkdir(home);
  provider = { id: "fixture", model: "none", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100000 },
    async *stream() { yield { type: "text_delta", text: "done" }; yield { type: "stop", reason: "end_turn" }; } };
  return { root, cwd, home };
}
async function build(f: Awaited<ReturnType<typeof fixture>>, flags: string[] = [], notices: string[] = []) {
  let built: BuiltAgent | undefined;
  await buildProgram({ config: { cwd: f.cwd, home: f.home, env: {} }, run: async (_task, opts) => {
    built = await buildAgent(opts, { onNotice: message => notices.push(message) });
  } }).parseAsync(["run", "fixture", "--root", join(f.root, "logs"), "--no-repo-map", "--max-turns", "4", ...flags], { from: "user" });
  return built!;
}

it("untrusted project and home modules never import; trusted project and explicit path do, with pre-import warning", async () => {
  const f = await fixture(); const sentinel = join(f.root, "imported");
  const code = `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(sentinel)},'yes');export function activate(ctx){ctx.registerCommand({name:'test',summary:'test',run(){}})}`;
  const path = await extensionFixture(join(f.cwd, ".agentrig/extensions"), "test", code);
  await extensionFixture(join(f.home, ".agentrig/extensions"), "home", 'throw new Error("home must not import")');
  expect((await build(f)).commands).toEqual([]);
  await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  const notices: string[] = []; const trusted = await build(f, ["--trust"], notices);
  expect(trusted.commands?.map(c => c.name)).toEqual(["test"]);
  expect(notices[0]).toContain("ambient Node host code");
  expect((await build(f, ["--trust", "--no-extension-discovery"])).commands).toEqual([]);
  expect((await build(f, ["--extension", path, "--no-extension-discovery"])).commands).toHaveLength(1);
});

it("sandbox refusal precedes any explicit module import even under YOLO", async () => {
  const f = await fixture(); const sentinel = join(f.root, "imported");
  const path = await extensionFixture(f.root, "unsafe", `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(sentinel)},'yes');export function activate(){}`);
  await expect(build(f, ["--extension", path, "--sandbox", "workspace-write", "--yolo"])).rejects.toThrow(/ambient host code/);
  await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
});

it("actual extension slash command, registered tool and hook gate share real CLI/TUI wiring and ordered receipts", async () => {
  const f = await fixture(); await extensionFixture(join(f.cwd, ".agentrig/extensions"));
  await mkdir(join(f.cwd, ".agentrig/skills"));
  await writeFile(join(f.cwd, ".agentrig/skills/hello.md"), "Skill is shadowed by the extension command");
  let turn = 0;
  provider.stream = async function* () {
    if (turn++ === 0) { yield { type: "tool_use", id: "bash", name: "bash", input: { command: "printf fixture" } }; yield { type: "stop", reason: "tool_use" }; }
    else if (turn === 2) { yield { type: "tool_use", id: "hello", name: "hello_tool", input: {} }; yield { type: "stop", reason: "tool_use" }; }
    else { yield { type: "text_delta", text: "done" }; yield { type: "stop", reason: "end_turn" }; }
  };
  const notices: string[] = []; const built = await build(f, ["--trust", "--allow", "hello_tool"], notices);
  expect(notices.some(n => n.includes("shadows the skill"))).toBe(true);
  const controller = new TuiController({ cwd: f.cwd, agent: built.agent });
  controller.setSkills(built.skills); controller.setCommands(built.commands ?? []);
  await controller.submit("/hello User"); await controller.submit("/help");
  const text = controller.snapshot().lines.map(l => l.text).join("\n");
  expect(text).toContain("hello User"); expect(text).toContain("extensions:"); expect(text).not.toContain("loaded into this turn");
  await controller.submit("run fixture");
  const events = await new SessionStore({ root: join(f.root, "logs") }).readAll(controller.snapshot().sessionId!);
  expect(events[0]!.type).toBe("session.start");
  expect(events.findIndex(e => e.type === "extension.loaded")).toBeGreaterThan(0);
  expect(events.some(e => e.type === "tool.denied" && e.name === "bash")).toBe(true);
  expect(events.some(e => e.type === "tool.result" && e.id === "hello" && e.ok)).toBe(true);
  expect(events.at(-1)).toMatchObject({ type: "session.end", reason: "done" });
  expect(renderEvent(events.find(e => e.type === "extension.loaded")!)).toContain("commands=hello");
  await controller.shutdown();
});

it("failed activation is logged without partial commands and configuration overrides are deliberate", async () => {
  const f = await fixture(); const path = await extensionFixture(f.root, "bad", 'export function activate(ctx){ctx.registerCommand({name:"partial",summary:"partial",run(){}});throw new Error("bad activation")}');
  const built = await build(f, ["--extension", path]); expect(built.commands).toEqual([]);
  const run = built.agent.run("fixture", { cwd: f.cwd }); for await (const _event of run.events) { /* drain */ } await run.done;
  const events = await new SessionStore({ root: join(f.root, "logs") }).readAll(run.id);
  const error = events.find(e => e.type === "extension.error")!;
  expect(error).toMatchObject({ phase: "activate", name: "bad" }); expect(renderEvent(error)).toContain("bad activation");
  expect(events.at(-1)).toMatchObject({ type: "session.end", reason: "done" });
  expect(resolveConfig({ defaults: {}, user: { extension: [path] }, cli: { extension: [] } }).extension).toEqual([]);
  expect(() => parseConfigText("fixture", '{"extensionDiscovery":"true"}')).toThrow();
});

it("registered extension hooks stay advisory and child agents inherit neither tools nor paired hooks", async () => {
  const f = await fixture();
  const path = await extensionFixture(f.root);
  const source = await readFile(path, "utf8");
  await writeFile(path, source.replace('ctx.log("activated");', 'ctx.hooks.on("pre_model",()=>({action:"modify",patch:{system:"extension hint"}}));'));
  const requests: ModelRequest[] = []; let parentCalls = 0;
  provider.stream = async function* (request) {
    requests.push(request);
    if (request.tools.some(t => t.name === "hello_tool") && parentCalls++ === 0) {
      yield { type: "tool_use", id: "child", name: "subagent", input: { task: "independent fixture" } };
      yield { type: "stop", reason: "tool_use" };
    } else { yield { type: "text_delta", text: "done" }; yield { type: "stop", reason: "end_turn" }; }
  };
  const built = await build(f, ["--extension", path, "--subagents", "--allow", "subagent"]);
  const run = built.agent.run("fixture", { cwd: f.cwd });
  const events = []; for await (const event of run.events) events.push(event); await run.done;
  expect(events.some(e => e.type === "subagent.end")).toBe(true);
  const parent = requests.find(r => r.tools.some(t => t.name === "hello_tool"))!;
  expect(parent.systemContexts?.some(c => c.principal.startsWith("hook:ext:hello:") && c.authority === "advisory" && c.delegation === undefined)).toBe(true);
  const child = requests.find(r => !r.tools.some(t => t.name === "hello_tool"))!;
  expect(child).toBeDefined(); expect(child.system).not.toContain("extension hint");
  expect(child.systemContexts?.some(c => c.principal.startsWith("hook:ext:"))).not.toBe(true);
});
