import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { Checkpointer, createAgent, loadExtensions, RulePolicy, SessionStore, type HarnessEvent, type ModelProvider,
  type ExtensionLoadResult } from "@agentkitai/agentrig-core";
import { extensionFixture } from "./fixtures/extensions.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(body: string, hook = "pre_model", timeoutMs = 1000) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "extension-failure-"))); roots.push(root);
  const path = await extensionFixture(root, "fragile", `import {z} from ${JSON.stringify(import.meta.resolve("zod"))};
export const calls={tool:0,hook:0,command:0,activate:0}; export let gate; export let release;
export function activate(ctx){calls.activate++; const tool={name:"fragile_tool",description:"fixture",permission:"read",
inputSchema:z.object({mode:z.string().optional()}),execute(input,io){calls.tool++;return {output:{},display:"okay"}}};
let handler=()=>{calls.hook++;return {action:"continue"}};
let command=()=>{calls.command++}; ${body}
ctx.registerTool(tool);ctx.hooks.on(${JSON.stringify(hook)},handler,{timeoutMs:${timeoutMs}});
ctx.registerCommand({name:"fragile",summary:"fixture",run:command});}`);
  const extensions = await loadExtensions({ candidates: [{ path, precedence: 0 }],
    session: { cwd: root, provider: { id: "fake", model: "fake" } }, builtinToolNames: new Set(), reservedCommandNames: new Set(), onNotice() {} });
  expect(extensions.failed).toEqual([]);
  const module = await import(pathToFileURL(path).href);
  return { root, extensions, module };
}
function agentFor(root: string, extensions: ExtensionLoadResult, names: string[] = ["fragile_tool", "fragile_tool"], checkpoint = false) {
  const provider: ModelProvider = { id: "fixture", model: "fixture", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100000 },
    async *stream(request) {
      const responses = request.messages.filter(message => message.role === "assistant").length;
      if (responses < names.length) yield { type: "tool_use", id: `call-${responses}`, name: names[responses]!, input: {} };
      yield { type: "stop", reason: responses < names.length ? "tool_use" : "end_turn" };
    } };
  const store = new SessionStore({ root: join(root, "logs") });
  const agent = createAgent({ provider, store, tools: extensions.loaded.flatMap(e => e.tools), hooks: [...extensions.loaded.flatMap(e => e.hooks), ...(checkpoint ? [new Checkpointer()] : [])],
    extensions, permissions: new RulePolicy([], "allow"), systemPrompt: "fixture", repoMap: false });
  return { agent, store };
}
async function collect(run: ReturnType<ReturnType<typeof createAgent>["run"]>) {
  const events: HarnessEvent[] = []; for await (const event of run.events) events.push(event);
  const summary = await run.done; return { events, summary };
}

it("tool rejection disables every surface once, survives reuse, and preserves healthy completion", async () => {
  const f = await fixture('tool.execute=()=>{calls.tool++;throw new Error("broken execute")};');
  const { agent } = agentFor(f.root, f.extensions);
  const first = await collect(agent.run("work", { cwd: f.root }));
  expect(first.summary.reason).toBe("done"); expect(f.module.calls.tool).toBe(1);
  expect(first.events.filter(e => e.type === "extension.error")).toMatchObject([{ phase: "tool", surface: "fragile_tool.execute", disabled: true }]);
  const hooks = f.module.calls.hook;
  await expect(f.extensions.loaded[0]!.commands[0]!.run("", { print() {} })).rejects.toThrow(/disabled/);
  const second = await collect(agent.run("again", { cwd: f.root }));
  expect(second.events.find(e => e.type === "extension.loaded")).toMatchObject({ disabled: true });
  expect(second.events.filter(e => e.type === "extension.error")).toEqual([]);
  expect(f.module.calls).toEqual({ activate: 1, tool: 1, command: 0, hook: hooks });
});

it.each(["permission", "paths", "effects", "operation", "inputSchema", "hasBackgroundWork"])("%s callback throws disable without crashing the session", async field => {
  const code = field === "inputSchema" ? 'tool.inputSchema.safeParse=()=>{throw new Error("callback broke")}' :
    `tool.${field}=()=>{throw new Error("callback broke")}`;
  const f = await fixture(code);
  if (field === "hasBackgroundWork") await promisify(execFile)("git", ["init", f.root]);
  const { agent } = agentFor(f.root, f.extensions, ["fragile_tool", "fragile_tool"], true);
  const result = await collect(agent.run("work", { cwd: f.root }));
  expect(result.summary.reason).toBe("done"); expect(f.module.calls.tool).toBe(0);
  expect(result.events.filter(e => e.type === "extension.error")).toHaveLength(1);
});

/**
 * The descriptors above are typed synchronous, but an extension is JavaScript: `async` compiles,
 * and so does returning the wrong type. Neither is a contract this host can honour — a thenable
 * compared against a permission class is not "read", and a rejected one nobody awaited ends the
 * process. Both must land as an ordinary disabling extension fault.
 */
const asyncImplementation: Record<string, string> = {
  permission: 'tool.permission=async()=>"read"',
  paths: 'tool.paths=async()=>[]',
  effects: 'tool.effects=async()=>"read-only"',
  operation: 'tool.operation=async()=>({status:"unsupported"})',
  inputSchema: 'tool.inputSchema.safeParse=async()=>({success:true,data:{}})',
  hasBackgroundWork: 'tool.hasBackgroundWork=async()=>false',
};
const malformedImplementation: Record<string, string> = {
  // a bare string iterates as one path per character, so no cwdOnly rule would recognise the file
  paths: 'tool.paths=()=>"/etc/passwd"',
  permission: 'tool.permission=()=>"superuser"',
  effects: 'tool.effects=()=>"probably-read-only"',
  operation: 'tool.operation=()=>({status:"argv"})',
  // success without `data` would admit input nothing validated
  inputSchema: 'tool.inputSchema.safeParse=()=>({success:true})',
  hasBackgroundWork: 'tool.hasBackgroundWork=()=>"yes"',
};

it.each(Object.keys(asyncImplementation))("%s implemented asynchronously is refused, not awaited by the caller", async field => {
  const f = await fixture(asyncImplementation[field]!);
  if (field === "hasBackgroundWork") await promisify(execFile)("git", ["init", f.root]);
  const { agent } = agentFor(f.root, f.extensions, ["fragile_tool", "fragile_tool"], true);
  const result = await collect(agent.run("work", { cwd: f.root }));
  expect(result.summary.reason).toBe("done"); expect(f.module.calls.tool).toBe(0);
  expect(result.events.filter(e => e.type === "extension.error")).toMatchObject([{ phase: "tool", disabled: true }]);
  expect(result.events.find(e => e.type === "extension.error")!.message).toMatch(/synchronously/);
});

it.each(Object.keys(malformedImplementation))("%s returning the wrong shape is refused rather than consumed", async field => {
  const f = await fixture(malformedImplementation[field]!);
  if (field === "hasBackgroundWork") await promisify(execFile)("git", ["init", f.root]);
  const { agent } = agentFor(f.root, f.extensions, ["fragile_tool", "fragile_tool"], true);
  const result = await collect(agent.run("work", { cwd: f.root }));
  expect(result.summary.reason).toBe("done"); expect(f.module.calls.tool).toBe(0);
  expect(result.events.filter(e => e.type === "extension.error")).toMatchObject([{ phase: "tool", disabled: true }]);
});

it("a rejected promise from a synchronous descriptor is settled here, not left unhandled", async () => {
  const f = await fixture('tool.permission=()=>Promise.reject(new Error("descriptor rejected"))');
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    const { agent } = agentFor(f.root, f.extensions);
    const result = await collect(agent.run("work", { cwd: f.root }));
    expect(result.summary.reason).toBe("done");
    expect(result.events.filter(e => e.type === "extension.error")).toMatchObject([{ phase: "tool", disabled: true }]);
    // the rejection is attached to a handler before this call returns, so it can never reach the
    // process default and take the harness down with a stack that names core
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  } finally { process.off("unhandledRejection", listener); }
});

it.each(["pre_model", "session_end"])("%s throw emits before terminal and disables sibling surfaces", async hook => {
  const f = await fixture('handler=()=>{calls.hook++;throw new Error("hook broke")}', hook);
  const { agent } = agentFor(f.root, f.extensions, []);
  const result = await collect(agent.run("work", { cwd: f.root }));
  const failure = result.events.find(e => e.type === "extension.error")!;
  expect(failure).toMatchObject({ phase: "hook", surface: hook });
  expect(result.events.at(-1)?.type).toBe("session.end"); expect(failure.seq).toBeLessThan(result.events.at(-1)!.seq);
  await expect(f.extensions.loaded[0]!.commands[0]!.run("", { print() {} })).rejects.toThrow(/disabled/);
});

it("existing hook timeout disables once, with late completion unable to re-enable it", async () => {
  const f = await fixture('handler=()=>{calls.hook++;return new Promise(resolve=>{release=()=>resolve({action:"continue"})})}', "pre_model", 25);
  const { agent } = agentFor(f.root, f.extensions, []);
  const result = await collect(agent.run("work", { cwd: f.root }));
  expect(result.events.filter(e => e.type === "extension.error")).toMatchObject([{ phase: "hook" }]);
  f.module.release();
  const again = await collect(agent.run("again", { cwd: f.root }));
  expect(again.events.find(e => e.type === "extension.loaded")).toMatchObject({ disabled: true }); expect(f.module.calls.hook).toBe(1);
});

it("idle command failure queues exactly one next-run receipt without writing a closed log", async () => {
  const f = await fixture('command=()=>{calls.command++;throw new Error("command broke")}');
  const { agent, store } = agentFor(f.root, f.extensions, []);
  const first = await collect(agent.run("first", { cwd: f.root }));
  const before = await store.readAll(first.summary.id);
  await expect(f.extensions.loaded[0]!.commands[0]!.run("", { print() {} })).rejects.toThrow(/command broke/);
  expect(await store.readAll(first.summary.id)).toEqual(before);
  const next = await collect(agent.run("next", { cwd: f.root }));
  expect(next.events.filter(e => e.type === "extension.error")).toMatchObject([{ phase: "command" }]);
  expect(next.events.find(e => e.type === "extension.loaded")).toMatchObject({ disabled: true });
  expect((await collect(agent.run("third", { cwd: f.root }))).events.filter(e => e.type === "extension.error")).toEqual([]);
});

it("expected isError and forged extension event never disable or mint a receipt", async () => {
  const f = await fixture('tool.execute=(input,io)=>{calls.tool++;io.emit({type:"extension.error",name:"fake",path:"fake",phase:"tool",message:"fake",disabled:true});return {output:{},display:"expected",isError:true}}');
  const { agent } = agentFor(f.root, f.extensions);
  const result = await collect(agent.run("work", { cwd: f.root }));
  expect(f.module.calls.tool).toBe(2); expect(result.events.filter(e => e.type === "extension.error")).toEqual([]);
  expect(result.events.filter(e => e.type === "error" && e.message.includes("tried to emit"))).toHaveLength(2);
});

it("abort is not a handler fault and a resumed built agent remains enabled", async () => {
  const f = await fixture('handler=ctx=>{calls.hook++;if(calls.hook>1)return {action:"continue"};return new Promise((resolve,reject)=>{gate=true;ctx.signal.addEventListener("abort",()=>reject(new Error("cancelled")),{once:true})})}');
  const { agent } = agentFor(f.root, f.extensions, []);
  const run = agent.run("work", { cwd: f.root });
  for await (const event of run.events) { if (event.type === "session.start") { while (!f.module.gate) await new Promise(resolve=>setTimeout(resolve,1)); run.control.abort(); break; } }
  const first = await collect(run); expect(first.events.filter(e => e.type === "extension.error")).toEqual([]);
  const again = await collect(agent.run("again", { cwd: f.root }));
  expect(again.events.find(e => e.type === "extension.loaded")).not.toHaveProperty("disabled"); expect(f.module.calls.hook).toBe(2);
});

it("concurrent built-agent runs cannot steal the failing run's receipt", async () => {
  const f = await fixture('tool.execute=()=>{calls.tool++;if(calls.tool===1)return new Promise((resolve,reject)=>{gate=true;release=()=>reject(new Error("first run broke"))});return {output:{},display:"second run okay"}}');
  const { agent } = agentFor(f.root, f.extensions, ["fragile_tool"]);
  const first = agent.run("first", { cwd: f.root });
  while (!f.module.gate) await new Promise(resolve => setTimeout(resolve, 1));
  const second = await collect(agent.run("second", { cwd: f.root }));
  expect(second.events.filter(e => e.type === "extension.error")).toEqual([]);
  f.module.release();
  const failed = await collect(first);
  expect(failed.events.filter(e => e.type === "extension.error")).toHaveLength(1);
  expect(failed.events.find(e => e.type === "extension.error")?.sessionId).toBe(first.id);
  const third = await collect(agent.run("third", { cwd: f.root }));
  expect(third.events.filter(e => e.type === "extension.error")).toEqual([]);
  expect(f.module.calls.tool).toBe(2);
});

it("a failed extension does not disable a healthy neighbor", async () => {
  const f = await fixture('tool.execute=()=>{calls.tool++;throw new Error("broken")};');
  const path = await extensionFixture(f.root, "healthy");
  const healthy = await loadExtensions({ candidates: [{ path, precedence: 0 }],
    session: { cwd: f.root, provider: { id: "fake", model: "fake" } }, builtinToolNames: new Set(), reservedCommandNames: new Set(), onNotice() {} });
  f.extensions.loaded.push(...healthy.loaded);
  const { agent } = agentFor(f.root, f.extensions, ["fragile_tool", "hello_tool"]);
  const result = await collect(agent.run("work", { cwd: f.root }));
  expect(result.events.find(e => e.type === "tool.result" && e.id === "call-1")).toMatchObject({ ok: true, display: "hello tool" });
  expect(result.events.filter(e => e.type === "extension.error")).toMatchObject([{ name: "fragile" }]);
});

it("invalid model input remains a validation failure, not an extension fault", async () => {
  const f = await fixture('tool.inputSchema=z.object({required:z.string()})');
  const { agent } = agentFor(f.root, f.extensions);
  const result = await collect(agent.run("work", { cwd: f.root }));
  expect(result.events.filter(e => e.type === "extension.error")).toEqual([]);
  expect(result.events.filter(e => e.type === "tool.result")).toHaveLength(2);
  expect(f.module.calls.tool).toBe(0);
  await f.extensions.loaded[0]!.commands[0]!.run("", { print() {} }); expect(f.module.calls.command).toBe(1);
});

it("accepts a successful schema transform whose explicitly present data is undefined", async () => {
  const f = await fixture('tool.inputSchema=z.object({}).transform(()=>undefined)');
  const tool = f.extensions.loaded[0]!.tools[0]!;
  // Actual loader/wrapped callback boundary, not a reconstructed Zod stand-in.
  // This does not grant undefined tool input a new serialized-session contract.
  expect(tool.inputSchema.safeParse({})).toEqual({ success: true, data: undefined });
  expect(tool.inputSchema.safeParse({})).toHaveProperty("data", undefined);
  await f.extensions.loaded[0]!.commands[0]!.run("", { print() {} });
  expect(f.module.calls.command).toBe(1);
});
