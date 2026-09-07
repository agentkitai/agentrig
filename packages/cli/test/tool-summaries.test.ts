import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { render } from "ink";
import { afterEach, expect, it, vi } from "vitest";
import { createAgent, builtinTools, RulePolicy, SessionStore, HarnessEvent, type ModelProvider } from "@agentkitai/agentrig-core";
import { ToolSummaries, TOOL_SUMMARY_LIMITS } from "../src/tui/tool-summaries.js";
import { TuiController } from "../src/tui/controller.js";
import { App } from "../src/tui/app.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const call = (n: number, more = {}) => HarnessEvent.parse({ sessionId: "s", ts: n, seq: n, type: "tool.call", id: String(n), name: "read_file", input: { path: `${n}.txt` }, inputHash: "x", ...more });
const result = (n: number, more = {}) => HarnessEvent.parse({ sessionId: "s", ts: n + 1, seq: n + 1000, type: "tool.result", id: String(n), toolCallSeq: n, permission: "read", ok: true, display: "content", durationMs: 7, ...more });
it.each([80, 120])("actual five-file runtime renders one compact App line at %s columns and verbose restores five calls", async columns => {
  const root = await mkdtemp(join(tmpdir(), "agentrig-summaries-")); roots.push(root);
  for (let n = 1; n <= 5; n++) await writeFile(join(root, `${n}.txt`), `file ${n}`);
  let turn = 0;
  const provider: ModelProvider = { id: "fixture", model: "fixture", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100000 },
    async *stream() { if (++turn === 1) { for (let n = 1; n <= 5; n++) yield { type: "tool_use" as const, id: String(n), name: "read_file", input: { path: `${n}.txt` } }; yield { type: "stop" as const, reason: "tool_use" as const }; }
      else { yield { type: "text_delta" as const, text: "files inspected" }; yield { type: "stop" as const, reason: "end_turn" as const }; } } };
  const store = new SessionStore({ root: join(root, "logs") });
  const agent = createAgent({ provider, store, tools: builtinTools(), systemPrompt: "fixture", repoMap: false, permissions: new RulePolicy([{ class: "read", decision: "allow" }]) });
  const controller = new TuiController({ cwd: root, agent }); const writes: string[] = [];
  const stdout = Object.assign(new EventEmitter(), { columns, rows: 30, isTTY: true, write: (text: string) => { writes.push(text); return true; } });
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, setEncoding() {}, setRawMode() {}, ref() {}, unref() {}, read: () => null });
  const app = render(createElement(App, { controller }), { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false });
  try {
    await controller.submit("read the five files");
    await vi.waitFor(() => expect(writes.join("")).toContain("read 5 files"));
    const before = controller.snapshot().lines.map(line => line.text);
    expect(before.filter(line => line.includes("read 5 files"))).toHaveLength(1);
    expect(before.some(line => line.includes("read_file#"))).toBe(false);
    const original = await store.readAll(controller.snapshot().sessionId!);
    expect(original.filter(e => e.type === "tool.call")).toHaveLength(5);
    expect(original.filter(e => e.type === "tool.result" && e.ok)).toHaveLength(5);
    await controller.submit("/verbose");
    await vi.waitFor(() => expect(writes.join("")).toContain("read_file#5"));
    expect(controller.snapshot().lines.filter(line => /read_file#\d/.test(line.text))).toHaveLength(5);
    expect(controller.snapshot().lines.slice(0, before.length).map(line => line.text)).toEqual(before);
    await controller.submit("/verbose"); await controller.submit("/verbose");
    expect(controller.snapshot().lines.filter(line => /read_file#\d/.test(line.text))).toHaveLength(5);
    expect(await store.readAll(controller.snapshot().sessionId!)).toEqual(original);
    expect(writes.join("")).not.toContain("\u001b[2J");
  } finally { await controller.shutdown(); app.unmount(); }
});
it("matched out-of-order results use observed durations, not wall-clock or name guesses", () => {
  const fold = new ToolSummaries(); fold.push(call(1)); fold.push(call(2));
  expect(fold.push(result(2)).lines).toEqual([]); expect(fold.push(result(1)).lines).toEqual([]);
  expect(fold.finish()[0]?.text).toContain("2 requests, repeats counted · 14ms summed");
  for (const fields of [{ permission: undefined }, { permission: "exec" }, { toolCallSeq: undefined }, { durationMs: -1 }, { ok: false }]) {
    const f = new ToolSummaries(); f.push(call(1)); const lines = f.push(result(1, fields)).lines;
    expect(lines.some(line => line.text.includes("read 1 files"))).toBe(false); expect(lines.length).toBeGreaterThan(0);
  }
});
it("error, denial and question boundaries flush successful reads without hiding their content", () => {
  for (const payload of [{ type: "error", message: "failure", fatal: false }, { type: "tool.denied", id: "deny", name: "write_file" },
    { type: "permission.decision", d: "deny", toolUseId: "deny", tool: "write_file" },
    { type: "permission.decision", d: "allow", toolUseId: "grant", tool: "read_file", source: { kind: "grant", grantId: "grant" } },
    { type: "question.asked", id: "11a0b942-954c-4c32-a544-d9da32189830", toolUseId: "q", question: { prompt: "Choose", options: ["a", "b"] } },
    { type: "tool.result.patched", id: "p", by: "fixture", display: "patched", outputHash: "x" }]) {
    const f = new ToolSummaries(); f.push(call(1)); f.push(result(1));
    const event = HarnessEvent.parse({ sessionId: "s", ts: 3, seq: 3, ...payload });
    expect(f.push(event)).toMatchObject({ handled: false, lines: [{ text: expect.stringContaining("read 1 files") }] });
  }
});
it("diagnostics stay visible and unknown identity never borrows a successful receipt", () => {
  const f = new ToolSummaries(); f.push(call(1)); f.push(result(1)); f.push(call(2));
  const diagnostics = { path: "2.txt", contentHash: "x", status: "reported", reason: "checker observed", exitCode: 1, otherFileCount: 0, omitted: 0, entries: [{ line: 1, message: "error" }] };
  const lines = f.push(result(2, { diagnostics })).lines;
  expect(lines[0]?.text).toContain("read 1 files"); expect(lines.some(l => l.text.includes("Diagnostics: checker observed"))).toBe(true);
  const different = new ToolSummaries(); different.push(call(1));
  expect(different.push(result(1, { toolCallSeq: 99 })).lines[0]?.text).toContain("unmatched tool");
  expect(different.finish()[0]?.text).toContain("incomplete");
  const collision = new ToolSummaries(); collision.push(call(1)); collision.push(call(2, { id: "1" }));
  expect(collision.push(result(1, { toolCallSeq: undefined })).lines[0]?.text).toContain("unmatched tool");
  expect(collision.finish()).toHaveLength(2);
});
it("caps pending/read/expanded state explicitly and strips controls from key arguments", () => {
  const f = new ToolSummaries(); const lines: string[] = [];
  for (let n = 1; n <= 200; n++) lines.push(...f.push(call(n, { input: { path: "\u001b[2J\n\u202epath" + "x".repeat(5000) } })).lines.map(l => l.text));
  expect(lines.filter(line => line.includes("pending display cap"))).toHaveLength(72);
  expect(f.finish()).toHaveLength(128);
  const expanded = f.expand(); expect(expanded[0]?.text).toContain("older tool-detail lines elided");
  expect(expanded.length).toBeLessThanOrEqual(TOOL_SUMMARY_LIMITS.rawLines + 2);
  expect(expanded.map(l => l.text).join("")).not.toMatch(/[\u001b\n\u202e]/u);
  expect(f.expand()).toEqual([]);
  const oversize = new ToolSummaries(); expect(oversize.push(call(1, { id: "x".repeat(257) })).lines[0]?.text).toContain("identity cap");
  const reads = new ToolSummaries(); const groups: string[] = [];
  for (let n = 1; n <= 65; n++) { reads.push(call(n)); groups.push(...reads.push(result(n)).lines.map(l => l.text)); }
  expect(groups).toHaveLength(1); expect(groups[0]).toContain("64 requests"); expect(reads.finish()[0]?.text).toContain("1 requests");
});
