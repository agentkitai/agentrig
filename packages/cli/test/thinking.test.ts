import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
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
