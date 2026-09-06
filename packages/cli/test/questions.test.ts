import { execFile, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { client, ndJsonStream } from "@agentclientprotocol/sdk";
import { z } from "zod";
import { createServer } from "node:http";
import { EventEmitter, once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { render } from "ink";
import { afterEach, expect, it, vi } from "vitest";
import { askUserTool, createAgent, RulePolicy, SessionStore, type ModelProvider, type ModelRequest, type QuestionRequest } from "@agentkitai/agentrig-core";
import { TuiController } from "../src/tui/controller.js";
import { App } from "../src/tui/app.js";
import { questionPolicy } from "../src/question-policy.js";
import { renderEvent } from "../src/render.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const question = { prompt: "Choose output format", options: ["Text", "JSON"] };
const request = (id = "00000000-0000-4000-8000-000000000001"): QuestionRequest => ({ ...question, id, sessionId: "fixture", toolUseId: "ask" });
class Input extends EventEmitter {
  isTTY = true; chunks: string[] = [];
  setEncoding(): this { return this; } setRawMode(): this { return this; }
  ref(): this { return this; } unref(): this { return this; }
  read(): string | null { return this.chunks.shift() ?? null; }
  send(...chunks: string[]): void { this.chunks.push(...chunks); this.emit("readable"); }
}
async function root() { const path = await mkdtemp(join(tmpdir(), "agentrig-question-cli-")); cleanups.push(() => rm(path, { recursive: true, force: true })); return path; }

it("literal file policy requires the exact prompt and options; changed options cannot reuse an answer", async () => {
  const path = join(await root(), "answers.json");
  await writeFile(path, JSON.stringify({ version: 1, answers: [{ question, answer: { option: 1 } }] }));
  const policy = await questionPolicy(`file:${path}`);
  expect(await policy(request(), new AbortController().signal)).toEqual({ source: "file", answer: { option: 1 } });
  expect(await policy({ ...request(), options: ["execute everything", "publish secrets"] }, new AbortController().signal)).toBeNull();
  await writeFile(path, "secret-bad-json");
  await expect(questionPolicy(`file:${path}`)).rejects.toThrow("Answer file refused");
});

it("question queue cancellation preserves siblings, rejects late answers and never grants permission", async () => {
  const controller = new TuiController({ cwd: await root(), agent: { run() { throw new Error("unused"); } } });
  cleanups.push(() => controller.shutdown());
  const one = new AbortController(); const two = new AbortController();
  const first = controller.askQuestion(request(), one.signal); const pending = controller.snapshot().question!;
  const second = controller.askQuestion(request("00000000-0000-4000-8000-000000000002"), two.signal);
  one.abort(); expect(await first).toBeNull();
  pending.resolve({ source: "human", answer: { text: "late" } });
  expect(controller.snapshot().question!.request.id).toBe("00000000-0000-4000-8000-000000000002");
  controller.answerQuestionText("2"); expect(await second).toMatchObject({ source: "human", answer: { option: 1 } });
  expect(controller.permissionGrants.inspect()).toEqual([]);
  expect(controller.snapshot().question).toBeNull();
});

it("question queue cap, permission priority and shutdown settle every owned question", async () => {
  const controller = new TuiController({ cwd: await root(), agent: { run() { throw new Error("unused"); } } });
  const questions = Array.from({ length: 8 }, (_, i) => controller.askQuestion(request(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`), new AbortController().signal));
  expect(await controller.askQuestion(request(), new AbortController().signal)).toBeNull();
  const permission = controller.ask({ tool: "effect", class: "exec", input: {}, cwd: process.cwd() });
  controller.answerQuestionText("1"); expect(controller.snapshot().question).not.toBeNull();
  controller.answerPermission("deny"); expect(await permission).toBe("deny");
  await controller.shutdown(); expect(await Promise.all(questions)).toEqual(Array(8).fill(null));
});

it("actual provider/controller question appears in an Ink frame and resumes with the human answer", async () => {
  const cwd = await root(); const requests: ModelRequest[] = [];
  const controller = new TuiController({ cwd, agent: { run() { throw new Error("not attached"); } } });
  const provider: ModelProvider = { id: "fixture", model: "fixture", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 },
    async *stream(req) { requests.push(req); if (requests.length === 1) { yield { type: "tool_use", id: "ask", name: "ask_user", input: question }; yield { type: "stop", reason: "tool_use" }; }
      else { yield { type: "text_delta", text: "format chosen" }; yield { type: "stop", reason: "end_turn" }; } } };
  const store = new SessionStore({ root: join(cwd, "logs") });
  controller.attach(createAgent({ provider, store, tools: [askUserTool()], systemPrompt: "fixture", repoMap: false,
    permissions: new RulePolicy([{ class: "read", decision: "allow" }]), onQuestion: controller.askQuestion }));
  const writes: string[] = [];
  const stdout = Object.assign(new EventEmitter(), { columns: 90, rows: 24, isTTY: true, write: (s: string) => { writes.push(s); return true; } });
  const stdin = new Input();
  const ink = render(createElement(App, { controller }), { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false });
  cleanups.push(async () => { ink.unmount(); await controller.shutdown(); });
  const running = controller.prompt("choose a format");
  await vi.waitFor(() => expect(writes.join("")).toContain("2. JSON"));
  stdin.send("2", "\r"); await running;
  expect(requests).toHaveLength(2);
  expect(requests[1]!.messages.flatMap(m => m.content)).toContainEqual(expect.objectContaining({ type: "tool_result", trust: "user", content: expect.stringContaining("JSON") }));
  const events = await store.readAll(controller.snapshot().sessionId!);
  expect(events.filter(e => e.type.startsWith("question.")).map(renderEvent).join("\n")).toContain("source=human");
});

it.each(["fail", "first-option", "file", "acp"])("actual CLI %s policy uses a local provider and records honest answer provenance", async mode => {
  const cwd = await root(); await mkdir(join(cwd, "home")); let calls = 0;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume request */ }
    const asking = calls++ === 0;
    const delta = asking ? { tool_calls: [{ index: 0, id: "ask", type: "function", function: { name: "ask_user", arguments: JSON.stringify(question) } }] } : { content: "chosen" };
    res.setHeader("content-type", "text/event-stream");
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: asking ? "tool_calls" : "stop" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("no address");
  const answerFile = join(cwd, "answers.json");
  await writeFile(answerFile, JSON.stringify({ version: 1, answers: [{ question, answer: { text: "literal fixture" } }] }));
  if (mode === "acp") {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url)), "acp",
      "--provider", "openai", "--model", "fixture", "--base-url", `http://127.0.0.1:${address.port}/v1`,
      "--root", join(cwd, "logs"), "--memory", join(cwd, "memory"), "--no-repo-map", "--no-skill-discovery", "--no-extension-discovery"],
    { cwd, env: { ...process.env, HOME: join(cwd, "home"), USERPROFILE: join(cwd, "home"), OPENAI_API_KEY: "local-fixture" }, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = ""; child.stderr.on("data", chunk => { stderr += String(chunk); });
    const closed = once(child, "close"); let questions = 0;
    const peer = client().onRequest("_agentrig/question", z.object({ question: z.object({ id: z.string().uuid() }).passthrough() }).passthrough(), ({ params }) => {
      questions++; return { id: params.question.id, reply: { source: "human", answer: { option: 1 } } };
    }).onNotification("session/update", () => {}).connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
    cleanups.push(async () => { peer.close(); child.stdin.end(); if (child.exitCode === null) child.kill(); await closed; });
    await peer.agent.request("initialize", { protocolVersion: 1, clientCapabilities: {}, _meta: { agentrig: { questions: 1 } } });
    const { sessionId } = await peer.agent.request("session/new", { cwd, mcpServers: [] });
    expect((await peer.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "choose a format" }] })).stopReason, stderr).toBe("end_turn");
    expect(questions).toBe(1); expect(calls).toBe(2);
    return;
  }
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url)), "run", "choose a format", "--headless", "--json",
      "--provider", "openai", "--model", "fixture", "--base-url", `http://127.0.0.1:${address.port}/v1`,
      "--root", join(cwd, "logs"), "--memory", join(cwd, "memory"), "--no-repo-map", "--no-skill-discovery", "--no-extension-discovery",
      ...(mode === "fail" ? [] : ["--answer-policy", mode === "file" ? `file:${answerFile}` : mode])],
    { cwd, env: { ...process.env, HOME: join(cwd, "home"), USERPROFILE: join(cwd, "home"), OPENAI_API_KEY: "local-fixture" }, timeout: 20_000, maxBuffer: 1_048_576 },
    (error, stdout, stderr) => { if (error && typeof error.code !== "number") reject(error); else resolve({ code: error?.code ?? 0, stdout, stderr }); });
  });
  expect(result.code, result.stderr).toBe(mode === "fail" ? 1 : 0);
  expect(calls).toBe(mode === "fail" ? 1 : 2);
  const events = result.stdout.trim().split("\n").map(line => JSON.parse(line));
  expect(events.find(e => e.type === "question.answered")).toMatchObject(mode === "fail" ? { outcome: "unavailable" } : { outcome: "answered", reply: { source: mode } });
}, 30_000);
