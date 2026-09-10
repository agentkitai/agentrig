import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ingestOnSessionEnd } from "@agentkitai/agentrig-memory";
import type { HookContext, ModelProvider } from "@agentkitai/agentrig-core";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "auto-ingest-")); await mkdir(join(dir, "raw", "sessions"), { recursive: true }); });
afterEach(async () => { vi.useRealTimers(); await rm(dir, { recursive: true, force: true }); });
const start = { type: "session.start", task: "Explain this code", cwd: "/w" };
const call = { type: "tool.call", id: "r", name: "read_file" };
const read = { type: "tool.result", id: "r", permission: "read", ok: true, display: "evidence" };
async function run(events: unknown[], options = {}) {
  const path = join(dir, "raw", "sessions", "s.jsonl");
  const raw = events.map(e => typeof e === "string" ? e : JSON.stringify(e)).join("\n") + "\n";
  await writeFile(path, raw);
  const stream = vi.fn(async function* () { yield { type: "text_delta" as const, text: '{"nothingDurable":true}' }; yield { type: "stop" as const, reason: "end_turn" as const }; });
  const provider: ModelProvider = { id: "fake", model: "fake", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 }, stream };
  const onDone = vi.fn(); const onError = vi.fn(); const onSettled = vi.fn();
  const hook = ingestOnSessionEnd({ dir, provider, policy: "automatic", onDone, onError, onSettled, ...options });
  const context: HookContext = { point: "session_end", sessionId: "s", cwd: dir, turn: 1, signal: new AbortController().signal };
  expect(await hook.handler(context)).toEqual({ action: "continue" });
  expect(await readFile(path, "utf8")).toBe(raw);
  expect(onSettled).toHaveBeenCalledTimes(1);
  return { stream, onDone, onError, onSettled, hook };
}
it("defers successful read-only explanation including denied tools without provider or wiki writes", async () => {
  const result = await run([start, call, read, { type: "error", message: "checkpoint lock" }, { type: "tool.denied", id: "d", name: "subagent" }]);
  expect(result.stream).not.toHaveBeenCalled(); expect(result.onError).not.toHaveBeenCalled();
  expect(result.onDone.mock.calls[0]?.[0]).toMatch(/deferred.*manual/i);
  expect(result.onSettled).toHaveBeenCalledWith(undefined);
  expect(await readdir(dir)).toEqual(["raw"]);
});
it("ignores earlier writes when the latest resumed run only reads", async () => {
  const result = await run([start, { type: "file.changed", path: "a" }, { type: "session.end", reason: "done" }, { type: "session.resume", task: "explain" }, call, read]);
  expect(result.stream).not.toHaveBeenCalled();
});
it.each([
  { type: "file.changed", path: "a" },
  { ...read, permission: "write" }, { ...read, permission: undefined }, { ...read, ok: false },
  { type: "tool.call", id: "u", name: "custom_tool" },
  { type: "tool.call", id: "a", name: "attempt_log" },
])("captures observed work/uncertainty: %j", async event => {
  const result = await run([start, call, read, event]); expect(result.stream).toHaveBeenCalled();
});
it.each(["invalid JSON", { type: "tool.result", ok: "yes" }, read])("defers incomplete scan evidence without spending: %j", async event => {
  const result = await run([event]); expect(result.stream).not.toHaveBeenCalled(); expect(result.onDone.mock.calls[0]?.[0]).toMatch(/deferred.*manual/i);
});
it("defers oversized evidence rather than truncating it", async () => {
  const result = await run([start, call, read], { limits: { maxRawBytes: 10 } }); expect(result.stream).not.toHaveBeenCalled(); expect(result.onDone.mock.calls[0]?.[0]).toMatch(/deferred.*manual/i);
});
it("defers event scan overflow even when the prefix contains work", async () => {
  const result = await run([start, { type: "file.changed", path: "a" }, read], { limits: { maxEvents: 2 } });
  expect(result.stream).not.toHaveBeenCalled(); expect(result.onDone.mock.calls[0]?.[0]).toContain("eligibility scan incomplete");
});
it("reserves backend calls before admitting full coverage", async () => {
  const onIngest = vi.fn();
  const result = await run([start, { ...read, permission: "write" }], { limits: { maxCalls: 1 }, backend: { id: "fake", onIngest, recall: async () => [], promote: async () => {} } });
  expect(result.stream).not.toHaveBeenCalled(); expect(onIngest).not.toHaveBeenCalled();
  expect(result.onDone.mock.calls[0]?.[0]).toContain("span/call budget");
});
it("preserves explicit all-session capture", async () => {
  const result = await run([start, call, read], { policy: "all" }); expect(result.stream).toHaveBeenCalled();
});
it.each([4, 1])("bounds automatic calls at %i without publishing partial coverage", async maxCalls => {
  const result = await run([start, { ...read, permission: "write", display: "evidence ".repeat(5000) }], maxCalls === 4 ? {} : { limits: { maxCalls } });
  expect(result.stream).not.toHaveBeenCalled();
  expect(result.onError).not.toHaveBeenCalled();
  expect(result.onDone.mock.calls[0]?.[0]).toMatch(/complete evidence exceeds automatic span\/call budget/);
  expect(result.onSettled).toHaveBeenCalledWith(undefined);
  expect(await readdir(dir)).toEqual(["raw"]);
  expect(result.hook.timeoutMs).toBe(90_000);
});
it("retains explicit larger automatic run budgets", async () => {
  const result = await run([start, call, read], { limits: { timeoutMs: 120_000 } });
  expect(result.hook.timeoutMs).toBe(180_000);
});
it("stops an uncooperative automatic provider at the 15-second per-call default", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const provider: ModelProvider = {
    id: "stalled", model: "fake", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 },
    async *stream() { entered(); await new Promise(() => {}); yield { type: "stop", reason: "end_turn" }; },
  };
  const pending = run([start, { ...read, permission: "write" }], { provider });
  await ready;
  await vi.advanceTimersByTimeAsync(15_001);
  const result = await pending;
  expect(result.onError.mock.calls[0]?.[0].message).toMatch(/15000ms.*overall budget 30000ms/);
  expect(result.onSettled.mock.calls[0]?.[0].localCommitState).toBe("not-started");
});
