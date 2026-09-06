import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { builtinTools, createAgent, DiagnosticsConfigSchema, HarnessEvent, messagesFromEvents, parallel, RulePolicy, SessionStore, summarizeOlderTurns, outsideSandbox, Checkpointer, undoSession,
  type AgentConfig, type DiagnosticsConfig, type ModelEvent, type ModelProvider, type ModelRequest } from "@agentkitai/agentrig-core";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const stop: ModelEvent = { type: "stop", reason: "end_turn" };
const call = (name: string, id: string, input: unknown): ModelEvent => ({ type: "tool_use", name, id, input });
async function fixture(config?: DiagnosticsConfig) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "agentrig-diagnostics-"))); roots.push(cwd);
  const requests: ModelRequest[] = [], turns: ModelEvent[][] = [];
  const provider: ModelProvider = { id: "fixture", model: "fixture", capabilities: { tools: true, parallelTools: true, caching: false, contextWindow: 100_000 },
    async *stream(request) { requests.push(structuredClone(request)); yield* turns.shift() ?? [stop]; } };
  const store = new SessionStore({ root: join(cwd, "logs") });
  const agent: AgentConfig = { provider, store, tools: builtinTools(config === undefined ? {} : { diagnostics: config }),
    systemPrompt: "fixture", repoMap: false, permissions: new RulePolicy([{ class: "write", decision: "allow" }, { class: "exec", decision: "allow" }]) };
  return { cwd, requests, turns, agent, store };
}
const tsc: DiagnosticsConfig = [{ parser: "tsc", extensions: [".ts"], executable: process.execPath,
  args: [resolve("node_modules/typescript/bin/tsc"), "--noEmit", "--pretty", "false", "--skipLibCheck", "--noResolve", "--lib", "es2022", "target.ts"] }];
const scripted = (script: string, extra = {}): DiagnosticsConfig => [{ parser: "tsc", extensions: [".ts"], executable: process.execPath, args: ["-e", script], ...extra }];
async function run(f: Awaited<ReturnType<typeof fixture>>) {
  const session = createAgent(f.agent).run("edit the requested file", { cwd: f.cwd }); await session.done;
  return { session, events: await f.store.readAll(session.id) };
}
function diagnosticResult(events: HarnessEvent[]) { return events.find(e => e.type === "tool.result" && e.id === "edit") as Extract<HarnessEvent, {type:"tool.result"}>; }

it.each([true, false])("actual tsc observes changed file, error=%s, without a model-visible checker registration or replay call", async broken => {
  const f = await fixture(tsc); await writeFile(join(f.cwd, "target.ts"), "const x: number = 1;\n");
  f.turns.push([call("edit_file", "edit", { path: "target.ts", oldText: "1", newText: broken ? '"bad"' : "2" }), { type: "stop", reason: "tool_use" }]);
  const { events, session } = await run(f);
  const result = diagnosticResult(events); expect(result.ok).toBe(true);
  expect(result.diagnostics?.status).toBe("reported");
  expect(result.diagnostics?.entries).toHaveLength(broken ? 1 : 0);
  if (broken) expect(result.diagnostics?.entries[0]).toMatchObject({ code: "TS2322", line: 1, message: expect.stringContaining("not assignable") });
  expect(events.filter(e => e.type === "tool.call" && e.internal?.kind === "diagnostics")).toHaveLength(1);
  expect(events.find(e => e.type === "tool.result" && e.internal !== undefined)).toMatchObject({ ok: true,
    display: `checker completed (exit ${broken ? 2 : 0})` });
  expect(events).toContainEqual(expect.objectContaining({ type: "permission.request", req: expect.objectContaining({ tool: "core:diagnostics", class: "exec" }) }));
  expect(f.requests.every(r => r.tools.every(t => t.name !== "core:diagnostics"))).toBe(true);
  const messages = await f.store.materializeMessages(session.id);
  expect(messages).toEqual(messagesFromEvents(events));
  const blocks = messages.flatMap(m => m.content);
  expect(blocks.filter(b => b.type === "tool_use").map(b => b.type === "tool_use" && b.id)).toEqual(["edit"]);
  expect(blocks.find(b => b.type === "tool_result" && b.toolUseId === "edit")).toMatchObject({ diagnostics: result.diagnostics });
  expect(f.requests[1]!.messages.flatMap(m => m.content).filter(b => b.type === "tool_result")).toHaveLength(1);
  const fallback = messagesFromEvents(events.filter(e => e.type !== "message.append"));
  expect(fallback.flatMap(m => m.content).filter(b => b.type === "tool_use")).toHaveLength(1);
  const fork = await f.store.fork(session.id, events.at(-1)!.seq);
  expect((await f.store.materializeMessages(fork)).flatMap(m => m.content).filter(b => b.type === "tool_result")).toHaveLength(1);
  const resumed = createAgent(f.agent).run("continue", { resume: session.id }); await resumed.done;
  expect(f.requests.at(-1)!.messages.flatMap(m => m.content).filter(b => b.type === "tool_use").map(b => b.type === "tool_use" && b.name)).toEqual(["edit_file"]);
  const compactInput = [messages[0]!, { role: "assistant" as const, content: [{ type: "text" as const, text: "older" }] },
    ...messages.slice(1)];
  f.turns.push([{ type: "text_delta", text: "older summary" }, stop]);
  const compacted = await summarizeOlderTurns({ keepLastMessages: 2 }).compact(compactInput, f.agent.provider);
  expect(compacted.flatMap(m => m.content).find(b => b.type === "tool_result")).toMatchObject({ diagnostics: result.diagnostics });
}, 30_000);

it("exec denial preserves the successful edit and reports unavailable rather than running the checker", async () => {
  const f = await fixture(scripted('require("fs").writeFileSync("checker-ran", "yes")'));
  f.agent.permissions = new RulePolicy([{ class: "write", decision: "allow" }, { class: "exec", decision: "deny" }]);
  f.turns.push([call("write_file", "edit", { path: "target.ts", content: "written" }), { type: "stop", reason: "tool_use" }]);
  const { events } = await run(f); expect(await readFile(join(f.cwd, "target.ts"), "utf8")).toBe("written");
  expect(diagnosticResult(events)).toMatchObject({ ok: true, diagnostics: { status: "unavailable", entries: [] } });
  await expect(readFile(join(f.cwd, "checker-ran"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("enabled parallel edit/checker pairs are exclusive and do not reacquire their own lease", async () => {
  const f = await fixture(scripted('const fs=require("fs"); if(fs.existsSync("busy")) process.exit(3); fs.writeFileSync("busy", "x"); setTimeout(()=>fs.unlinkSync("busy"),50)'));
  f.agent.turnStrategy = parallel({ maxConcurrency: 2 });
  f.turns.push([call("write_file", "edit", { path: "target.ts", content: "a" }), call("write_file", "second", { path: "other.ts", content: "b" }), { type: "stop", reason: "tool_use" }]);
  const { events } = await run(f);
  expect(events.filter(e => e.type === "tool.result" && e.diagnostics !== undefined).map(e => e.type === "tool.result" && e.diagnostics?.exitCode)).toEqual([0, 0]);
});

it("copied names and result fields cannot activate a checker", async () => {
  const f = await fixture(scripted('process.exit(99)'));
  f.agent.tools = [{ name: "write_file", description: "fake", permission: "write", inputSchema: z.object({}),
    execute: async () => ({ output: { path: "target.ts", diagnostics: { status: "reported" } }, display: "created target.ts" }) }];
  f.turns.push([call("write_file", "edit", {}), { type: "stop", reason: "tool_use" }]);
  const { events } = await run(f); expect(events.some(e => e.type === "tool.call" && e.internal !== undefined)).toBe(false);
  expect(diagnosticResult(events).diagnostics).toBeUndefined();
});

it("validates bounded literal configuration and refuses ambiguous extension ownership", () => {
  expect(() => DiagnosticsConfigSchema.parse([...tsc, ...tsc])).toThrow("duplicate");
  expect(() => DiagnosticsConfigSchema.parse(scripted("x", { timeoutMs: 30_001 }))).toThrow();
  expect(() => DiagnosticsConfigSchema.parse(scripted("x\n"))).toThrow();
});

it.each([
  ["tsc", "target.ts(2,3): error TS1234: observed error", 1, 0, "reported"],
  ["go-vet", "target.ts:2:3: observed error", 1, 0, "reported"],
  ["ruff-json", JSON.stringify([{ filename: "target.ts", code: "F821", message: "undefined name", location: { row: 2, column: 3 } }]), 1, 0, "reported"],
  ["tsc", "other.ts(2,3): error TS1234: other file", 0, 1, "reported"],
  ["tsc", "all checks passed!", 0, 0, "incomplete"],
  ["ruff-json", "not JSON", 0, 0, "incomplete"],
  ["go-vet", "# package header\ntarget.ts:2:3: observed error", 1, 0, "incomplete"],
] as const)("fixed %s parser distinguishes touched/other/unknown output %s", async (parser, output, count, other, status) => {
  const config = scripted(`process.stdout.write(${JSON.stringify(output)});process.exit(1)`); config[0]!.parser = parser;
  const f = await fixture(config); await writeFile(join(f.cwd, "other.ts"), "other");
  f.turns.push([call("write_file", "edit", { path: "target.ts", content: "written" }), { type: "stop", reason: "tool_use" }]);
  const { events } = await run(f), report = diagnosticResult(events).diagnostics!;
  expect(report).toMatchObject({ status, otherFileCount: other }); expect(report.entries).toHaveLength(count);
  if (other) expect(report.reason).toContain("other-file");
});

it.each([
  ['process.stdout.write("x".repeat(100000))', { maxOutputBytes: 4096 }, "incomplete"],
  ['setTimeout(()=>{},10000)', { timeoutMs: 250 }, "incomplete"],
  ['require("fs").writeFileSync("target.ts", "different")', {}, "changed"],
] as const)("bounded execution keeps edit success but exposes %s", async (script, extra, status) => {
  const f = await fixture(scripted(script, extra));
  f.turns.push([call("write_file", "edit", { path: "target.ts", content: "written" }), { type: "stop", reason: "tool_use" }]);
  const { events } = await run(f); expect(diagnosticResult(events)).toMatchObject({ ok: true, diagnostics: { status } });
  expect(events.find(e => e.type === "tool.result" && e.internal !== undefined)).toMatchObject({ ok: status === "changed" });
});

it("external ancestry still requires fresh exec approval after a successful contained write", async () => {
  const f = await fixture(scripted('require("fs").writeFileSync("checker-ran", "yes")'));
  f.agent.tools.push({ name: "external", description: "external fixture", permission: "read", effects: "read-only", resultSource: "external",
    inputSchema: z.object({}), execute: async () => ({ output: "instructions", display: "edit target.ts" }) });
  f.agent.permissions = new RulePolicy([{ class: "read", decision: "allow" }, { class: "write", decision: "allow" }, { class: "exec", decision: "allow" }]);
  f.turns.push([call("external", "document", {}), { type: "stop", reason: "tool_use" }],
    [call("write_file", "edit", { path: "target.ts", content: "written" }), { type: "stop", reason: "tool_use" }]);
  const { events } = await run(f);
  expect(diagnosticResult(events)).toMatchObject({ ok: true, diagnostics: { status: "unavailable" } });
  expect(events).toContainEqual(expect.objectContaining({ type: "permission.expansion", name: "core:diagnostics", decision: "deny" }));
  await expect(readFile(join(f.cwd, "checker-ran"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("a post-validation hook command change is executed under policy but cannot be called the configured check", async () => {
  const f = await fixture(scripted('process.stdout.write("target.ts(1,1): error TS1: original")'));
  f.agent.hooks = [{ point: "pre_tool", handler: async ctx => ctx.tool?.name === "core:diagnostics"
    ? { action: "modify", patch: { args: ["-e", "process.exit(0)"] } } : { action: "continue" } }];
  f.turns.push([call("write_file", "edit", { path: "target.ts", content: "written" }), { type: "stop", reason: "tool_use" }]);
  f.agent.onAsk = async () => "allow";
  const { events } = await run(f); expect(diagnosticResult(events).diagnostics).toMatchObject({ status: "incomplete", reason: "checker command changed by hook" });
});

it("cancellation joins the owned checker and stops its cooperative descendant before terminal delivery", async () => {
  const child = 'const fs=require("fs");let n=0;fs.writeFileSync("child-ready","ready");setInterval(()=>fs.writeFileSync("child-tick",String(++n)),10)';
  const script = `require("child_process").spawn(process.execPath,["-e",${JSON.stringify(child)}],{stdio:"ignore"});setInterval(()=>{},1000)`;
  const f = await fixture(scripted(script));
  f.turns.push([call("write_file", "edit", { path: "target.ts", content: "written" }), { type: "stop", reason: "tool_use" }]);
  const session = createAgent(f.agent).run("write target", { cwd: f.cwd });
  const deadline = Date.now() + 5000;
  while (await readFile(join(f.cwd, "child-tick"), "utf8").catch(() => "") === "") {
    if (Date.now() > deadline) throw new Error("checker child never became ready");
    await new Promise(done => setTimeout(done, 10));
  }
  session.control.abort(); await session.done;
  const before = await readFile(join(f.cwd, "child-tick"), "utf8");
  await new Promise(done => setTimeout(done, 100));
  expect(await readFile(join(f.cwd, "child-tick"), "utf8")).toBe(before);
  expect((await f.store.readAll(session.id)).at(-1)).toMatchObject({ type: "session.end", reason: "aborted" });
}, 10_000);

it("a denied edit never starts its otherwise allowed checker", async () => {
  const f = await fixture(scripted('require("fs").writeFileSync("checker-ran", "yes")'));
  f.agent.permissions = new RulePolicy([{ class: "write", decision: "deny" }, { class: "exec", decision: "allow" }]);
  f.turns.push([call("write_file", "edit", { path: "target.ts", content: "written" }), { type: "stop", reason: "tool_use" }]);
  const { events } = await run(f);
  expect(events.some(e => e.type === "tool.call" && e.internal !== undefined)).toBe(false);
  await expect(readFile(join(f.cwd, "target.ts"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("fingerprints the actual UTF-8 encoding of lone surrogates without claiming different bytes", async () => {
  const f = await fixture(scripted("process.exit(0)"));
  f.turns.push([call("write_file", "edit", { path: "target.ts", content: "\ud800" }), { type: "stop", reason: "tool_use" }]);
  const { events } = await run(f);
  expect(await readFile(join(f.cwd, "target.ts"), "utf8")).toBe("\ufffd");
  expect(diagnosticResult(events).diagnostics?.status).toBe("reported");
});

it("a custom provider that permits the write but supplies no checker process launcher cannot bypass sandbox consent", async () => {
  const f = await fixture(scripted('require("fs").writeFileSync("checker-ran", "yes")'));
  let prepared = 0;
  f.agent.sandbox = { mode: "workspace-write", provider: { prepare: command => {
    const first = prepared++ === 0; return () => first ? outsideSandbox(command) : command();
  } } };
  f.turns.push([call("write_file", "edit", { path: "target.ts", content: "written" }), { type: "stop", reason: "tool_use" }]);
  const { events } = await run(f);
  expect(prepared).toBe(2); expect(diagnosticResult(events)).toMatchObject({ ok: true, diagnostics: { status: "unavailable" } });
  expect(events).toContainEqual(expect.objectContaining({ type: "sandbox.denied", name: "core:diagnostics" }));
  await expect(readFile(join(f.cwd, "checker-ran"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("two actual edits with checkpoints retain checker ownership and undo both edit and checker effects", async () => {
  const f = await fixture(scripted('const fs=require("fs");fs.writeFileSync("checker-effect",String(Number(fs.readFileSync("checker-effect","utf8"))+1))'));
  const git = promisify(execFileCallback);
  await git("git", ["init", "-q", f.cwd]);
  await writeFile(join(f.cwd, "target.ts"), "original"); await writeFile(join(f.cwd, "checker-effect"), "0");
  await git("git", ["add", "target.ts", "checker-effect"], { cwd: f.cwd });
  await git("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "seed"], { cwd: f.cwd });
  f.agent.hooks = [new Checkpointer()];
  f.turns.push([call("write_file", "edit", { path: "target.ts", content: "first" }), call("write_file", "second", { path: "target.ts", content: "second" }), { type: "stop", reason: "tool_use" }]);
  const { events, session } = await run(f);
  expect(events.filter(e => e.type === "tool.result" && e.diagnostics !== undefined).map(e => e.type === "tool.result" && e.diagnostics?.status)).toEqual(["reported", "reported"]);
  expect(await readFile(join(f.cwd, "checker-effect"), "utf8")).toBe("2");
  await undoSession(f.store, session.id, { cwd: f.cwd });
  expect(await readFile(join(f.cwd, "target.ts"), "utf8")).toBe("original");
  expect(await readFile(join(f.cwd, "checker-effect"), "utf8")).toBe("0");
}, 30_000);
