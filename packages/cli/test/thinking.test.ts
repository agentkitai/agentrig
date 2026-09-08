import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { EventEmitter } from "node:events";
import { render } from "ink";
import { createAgent, SessionStore, type ModelProvider, type ThinkingBlock, type HarnessEvent } from "@agentkitai/agentrig-core";
import { eventsToTranscript } from "@agentkitai/agentrig-memory";
import { condenseTrajectory } from "@agentkitai/agentrig-supervisor";
import { TuiController } from "../src/tui/controller.js";
import { App } from "../src/tui/app.js";
import { redactExportMessages, exportSession } from "../src/session-export.js";
import { renderEvent } from "../src/render.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const thinking: ThinkingBlock = { type: "thinking", format: "anthropic", text: "DISCLOSED_THOUGHT", signature: "OPAQUE_SECRET",
  replay: JSON.stringify({ type: "thinking", thinking: "DISCLOSED_THOUGHT", signature: "OPAQUE_SECRET" }) };

it.each([false, true])("real controller/Ink rendering verbose=%s shows disclosed thinking only when requested", async verbose => {
  const cwd = await mkdtemp(join(tmpdir(), "agentrig-thinking-tui-"));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  const store = new SessionStore({ root: join(cwd, "logs") });
  const provider: ModelProvider = { id: "fixture", model: "fixture", capabilities: { tools: false, parallelTools: false, caching: false, contextWindow: 100_000 },
    async *stream() { yield { type: "thinking", block: thinking }; yield { type: "text_delta", text: "NORMAL_ANSWER" };
      yield { type: "usage", usage: { input: 1, output: 1 } }; yield { type: "stop", reason: "end_turn" }; } };
  const controller = new TuiController({ cwd, agent: createAgent({ provider, store, tools: [], systemPrompt: "fixture", repoMap: false }) });
  cleanups.push(() => controller.shutdown());
  const output: string[] = [];
  const stdout = Object.assign(new EventEmitter(), { columns: 100, rows: 24, isTTY: true, write(s: string) { output.push(s); return true; } });
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, setEncoding() {}, read() { return null; }, ref() {}, unref() {} });
  const ink = render(createElement(App, { controller }), { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false });
  cleanups.push(async () => { ink.unmount(); });
  if (verbose) await controller.submit("/verbose");
  await controller.prompt("go");
  await new Promise(resolve => setTimeout(resolve, 60));
  const lines = controller.snapshot().lines.map(l => l.text).join("\n");
  expect(lines).toContain("NORMAL_ANSWER");
  expect(lines.includes("DISCLOSED_THOUGHT")).toBe(verbose);
  expect(lines).not.toContain("OPAQUE_SECRET");
  if (!verbose) expect(lines).toContain("thinking [collapsed]");
  expect(output.join("")).toContain(verbose ? "DISCLOSED_THOUGHT" : "thinking [collapsed]");
  expect(output.join("")).not.toContain("OPAQUE_SECRET");
  const exported = await exportSession(store, controller.snapshot().sessionId!, { format: "jsonl" });
  expect(exported).toContain("thinking omitted");
  expect(exported).not.toContain("OPAQUE_SECRET"); expect(exported).not.toContain("DISCLOSED_THOUGHT");
});

it("export, memory, supervisor and event rendering never stringify thinking payloads", () => {
  const event: HarnessEvent = { type: "message.append", seq: 1, ts: 1, sessionId: "fixture", message: { role: "assistant", content: [thinking,
    { type: "tool_use", id: "c", name: "read", input: {} }] } };
  const result = redactExportMessages([event.message]);
  expect(result.omittedOpaque).toBe(1);
  expect(result.messages[0]!.content[1]).toEqual(event.message.content[1]);
  for (const value of [JSON.stringify(result), eventsToTranscript([event]), condenseTrajectory([event]), renderEvent(event)]) {
    expect(value).not.toContain("OPAQUE_SECRET"); expect(value).not.toContain("DISCLOSED_THOUGHT");
  }
  expect(eventsToTranscript([event])).toContain("thinking replay and disclosed text");
});

it("actual CI CLI replays signed thinking across a read tool but excludes it from report and OTLP", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agentrig-thinking-ci-"));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(`${cwd}-home`); await writeFile(join(cwd, "task.txt"), "Read task.txt and finish.");
  const requests: Array<{ messages: Array<{ content: Array<Record<string, unknown>> }> }> = [];
  const telemetry: string[] = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    if (request.url === "/traces") { telemetry.push(body); response.setHeader("content-type", "application/json"); response.end("{}"); return; }
    requests.push(JSON.parse(body)); const first = requests.length === 1;
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 10 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: thinking.text } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: thinking.signature } },
      { type: "content_block_stop", index: 0 },
      ...(first ? [
        { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "read", name: "read_file" } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify({ path: "task.txt" }) } },
        { type: "content_block_stop", index: 1 },
      ] : [{ type: "content_block_delta", delta: { type: "text_delta", text: "NORMAL_ANSWER" } }]),
      { type: "message_delta", delta: { stop_reason: first ? "tool_use" : "end_turn" }, usage: { output_tokens: 2 } },
    ];
    response.setHeader("content-type", "text/event-stream"); response.end(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("no fixture listener");
  // Isolate main-loop assertions from the recommended session-end auxiliary call.
  await mkdir(join(`${cwd}-home`, ".agentrig"), { recursive: true });
  await writeFile(join(`${cwd}-home`, ".agentrig/config.json"), JSON.stringify({ ingestOnEnd: false }));
  cleanups.push(() => rm(`${cwd}-home`, { recursive: true, force: true }));
  const endpoint = `http://127.0.0.1:${address.port}`;
  const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url)),
    "run", "--ci", "--provider", "anthropic", "--model", "fixture", "--base-url", endpoint,
    "--task-file", "task.txt", "--report", "report.md", "--root", join(cwd, "logs"), "--otel-endpoint", `${endpoint}/traces`,
    "--max-turns", "2", "--no-repo-map", "--no-skill-discovery", "--no-extension-discovery"],
  { cwd, timeout: 15_000, env: { ...process.env, HOME: `${cwd}-home`, USERPROFILE: `${cwd}-home`, ANTHROPIC_API_KEY: "fixture-only" } });
  expect(requests).toHaveLength(2);
  expect(requests[1]!.messages.flatMap(m => m.content).filter(b => b.type === "thinking"))
    .toEqual([{ type: "thinking", thinking: thinking.text, signature: thinking.signature }]);
  const report = await readFile(join(cwd, "report.md"), "utf8");
  expect(report).toContain("Outcome: done"); expect(report).toContain("NORMAL_ANSWER");
  expect(telemetry.length).toBeGreaterThan(0);
  for (const output of [report, result.stdout + result.stderr, telemetry.join("")]) {
    expect(output).not.toContain(thinking.text); expect(output).not.toContain(thinking.signature!);
  }
  const files = await readdir(join(cwd, "logs"));
  const raw = await readFile(join(cwd, "logs", files.find(f => f.endsWith(".jsonl"))!), "utf8");
  expect(raw).toContain(thinking.text); expect(raw).toContain(thinking.signature!);
  const events = raw.trim().split("\n").map(line => JSON.parse(line));
  expect(events.find(e => e.type === "session.start").task).toBe("");
  expect(events.some(e => e.type === "tool.result" && e.id === "read" && e.ok)).toBe(true);
}, 30_000);
