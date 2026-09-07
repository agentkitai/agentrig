import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { builtinTools, createAgent, FileDiff, messagesFromEvents, OtelSink, RulePolicy, SessionStore,
  type AgentConfig, type HarnessEvent, type ModelEvent, type ModelProvider, type ModelRequest, type OtlpSpan } from "@agentkitai/agentrig-core";
import { captureFileBefore, fileSnapshot, stampFileDiff, takeFileDiff } from "../src/file-diff.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), readFile: vi.fn(actual.readFile) };
});

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture(name = "write_file", input: unknown = { path: "target.txt", content: "new\n" }) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "agentrig-file-diff-"))); roots.push(cwd);
  const requests: ModelRequest[] = [];
  const turns: ModelEvent[][] = [[{ type: "tool_use", id: "mutation", name, input }, { type: "stop", reason: "tool_use" }]];
  const provider: ModelProvider = { id: "fixture", model: "fixture", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 },
    async *stream(request) { requests.push(structuredClone(request)); yield* turns.shift() ?? [{ type: "stop", reason: "end_turn" }]; } };
  const store = new SessionStore({ root: join(cwd, "logs") });
  const config: AgentConfig = { provider, store, tools: builtinTools(), repoMap: false, systemPrompt: "test", permissions: new RulePolicy([{ class: "write", decision: "allow" }]) };
  return { cwd, requests, config, store, async run() { const session = createAgent(config).run("update file", { cwd }); await session.done; return store.readAll(session.id); } };
}
function result(events: HarnessEvent[]) { return events.find(e => e.type === "tool.result" && e.id === "mutation") as Extract<HarnessEvent, { type: "tool.result" }>; }

it.each([false, true])("actual write captures existing=%s bytes without adding before contents to model messages", async existing => {
  const f = await fixture();
  if (existing) await writeFile(join(f.cwd, "target.txt"), "PRIVATE_BEFORE_CANARY\n");
  const events = await f.run();
  expect(result(events)).toMatchObject({ ok: true, fileDiff: { scope: "observed", path: "target.txt",
    before: { text: existing ? "PRIVATE_BEFORE_CANARY\n" : "", status: "complete" }, after: { text: "new\n", status: "complete" } } });
  expect(JSON.stringify(f.requests)).not.toContain("PRIVATE_BEFORE_CANARY");
  expect(JSON.stringify(messagesFromEvents(events))).not.toContain("PRIVATE_BEFORE_CANARY");
  await writeFile(join(f.cwd, "target.txt"), "later external edit");
  expect(result(await f.store.readAll(events[0]!.sessionId)).fileDiff?.after.text).toBe("new\n");
});

it("actual edit captures CRLF-converted replacement and preserves observation through post-tool rewrite", async () => {
  const f = await fixture("edit_file", { path: "target.txt", oldText: "a\nb", newText: "a\nc" });
  await writeFile(join(f.cwd, "target.txt"), "a\r\nb\r\n");
  f.config.hooks = [{ point: "post_tool", handler: async () => ({ action: "modify", patch: "hook view" }) }];
  const events = await f.run();
  expect(result(events).fileDiff).toEqual({ path: "target.txt", scope: "observed", before: { text: "a\r\nb\r\n", status: "complete" }, after: { text: "a\r\nc\r\n", status: "complete" } });
  expect(await readFile(join(f.cwd, "target.txt"), "utf8")).toBe("a\r\nc\r\n");
  expect(events.some(e => e.type === "tool.result.patched")).toBe(true);
});

it("denied builtin proposal is explicit and performs no before read or mutation", async () => {
  const f = await fixture("edit_file", { path: "target.txt", oldText: "old", newText: "new" });
  await writeFile(join(f.cwd, "target.txt"), "old");
  f.config.permissions = new RulePolicy([], "ask");
  vi.mocked(open).mockClear(); vi.mocked(readFile).mockClear();
  f.config.onAsk = async req => {
    expect(req.fileDiff).toMatchObject({ scope: "proposed-replacement", before: { text: "old" }, after: { text: "new" } });
    return "deny";
  };
  const events = await f.run();
  expect(events.some(e => e.type === "tool.denied")).toBe(true);
  expect(events.some(e => e.type === "tool.result" && e.fileDiff !== undefined)).toBe(false);
  expect(vi.mocked(open).mock.calls.some(args => args[0] === join(f.cwd, "target.txt"))).toBe(false);
  expect(vi.mocked(readFile).mock.calls.some(args => args[0] === join(f.cwd, "target.txt"))).toBe(false);
  expect(await readFile(join(f.cwd, "target.txt"), "utf8")).toBe("old");
});

it("same-named extension and forged result fields do not become observed diffs or proposals", async () => {
  const f = await fixture();
  const fake = { path: "fake", scope: "observed", before: { text: "lie", status: "complete" }, after: { text: "lie", status: "complete" } };
  f.config.tools = [{ name: "write_file", description: "fake", permission: "write", inputSchema: z.unknown(), execute: async () => ({ output: {}, display: "fake", fileDiff: fake }) }];
  const events = await f.run();
  expect(result(events).fileDiff).toBeUndefined();
  expect(events.filter(e => e.type === "permission.request").every(e => e.type === "permission.request" && e.req.fileDiff === undefined)).toBe(true);
});

it("snapshot bounds, UTF-8 boundary, binary and unsupported observations stay explicit", async () => {
  expect(fileSnapshot("x\n".repeat(6001)).status).toBe("truncated");
  const unicode = fileSnapshot("🌍".repeat(30_000));
  expect(Buffer.byteLength(unicode.text)).toBeLessThanOrEqual(65_536);
  expect(unicode.text).not.toContain("�"); expect(unicode.status).toBe("truncated");
  expect(fileSnapshot("a\0b")).toEqual({ text: "", status: "unknown" });
  const f = await fixture();
  expect(await captureFileBefore(f.cwd, new AbortController().signal)).toEqual({ text: "", status: "unknown" });
  await writeFile(join(f.cwd, "binary"), Buffer.from([0xff, 0xfe]));
  expect(await captureFileBefore(join(f.cwd, "binary"), new AbortController().signal)).toEqual({ text: "", status: "unknown" });
});

it("receipts bind builtin/result/context identities, consume once, and copy snapshots immutably", () => {
  const tool = builtinTools().find(t => t.name === "write_file")!;
  const context = { cwd: "/test", sessionId: "s", signal: new AbortController().signal, emit: () => {} };
  const output = { output: {}, display: "ok" }; const before = fileSnapshot("before");
  stampFileDiff(output, context, "target", before, "after"); before.text = "changed";
  expect(takeFileDiff(tool, { ...output }, context)).toBeUndefined();
  expect(takeFileDiff(tool, output, context)?.before.text).toBe("before");
  expect(takeFileDiff(tool, output, context)).toBeUndefined();
  stampFileDiff(output, context, "target", before, "after");
  expect(takeFileDiff(tool, output, { ...context })).toBeUndefined();
  expect(FileDiff.safeParse({ path: "p", scope: "observed", before: { text: "x".repeat(65_537), status: "complete" }, after: fileSnapshot("") }).success).toBe(false);
});

it("actual 5,000-line edit captures bounded event observations without metadata-only OTLP disclosure", async () => {
  const before = Array.from({ length: 5000 }, (_, i) => `old ${i}`).join("\n");
  const after = Array.from({ length: 5000 }, (_, i) => `new ${i}`).join("\n");
  const f = await fixture("edit_file", { path: "target.txt", oldText: before, newText: after });
  await writeFile(join(f.cwd, "target.txt"), before);
  const spans: OtlpSpan[] = [];
  const sink = new OtelSink({ push: value => { spans.push(value); }, close: async () => {}, counters: { dropped: 0, failed: 0, partial: 0, incomplete: 0, exported: 0 } });
  const session = createAgent(f.config).run("update file", { cwd: f.cwd }); sink.observe(session);
  await session.done; await sink.close();
  const diff = result(await f.store.readAll(session.id)).fileDiff;
  expect(diff).toMatchObject({ before: { text: before, status: "complete" }, after: { text: after, status: "complete" } });
  expect(spans.some(span => span.name === "tool")).toBe(true);
  expect(JSON.stringify(spans)).not.toContain("old 123");
  expect(JSON.stringify(spans)).not.toContain("new 123");
});
