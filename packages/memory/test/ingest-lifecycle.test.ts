import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AuxiliaryReport, ModelProvider } from "@agentkitai/agentrig-core";
import { FileMemoryStore, ingestSession, MaintenanceRun, LoreBackend, type IngestOptions, type MemoryBackend } from "@agentkitai/agentrig-memory";

let root: string; let store: FileMemoryStore; let logPath: string;
const source = "sources/session-s1.md";
const fact = { pageType: "concept", slug: "retry", tag: "observed", text: "Retries apply per request" };
const answer = JSON.stringify({ summary: "Retry behavior", facts: [fact] });
const provider = (stream?: ModelProvider["stream"]): ModelProvider => ({ id: "scripted", model: "fixture",
  capabilities: { tools: false, parallelTools: false, caching: false, contextWindow: 100_000 },
  stream: stream ?? (async function* () { yield { type: "text_delta", text: answer }; yield { type: "stop", reason: "end_turn" }; }),
});
const ingest = (opts: Partial<IngestOptions> = {}) => ingestSession({ store, logPath, sessionId: "s1", provider: provider(), ...opts });
const gate = () => Promise.withResolvers<void>();
const backend = (onIngest: MemoryBackend["onIngest"]): MemoryBackend => ({ id: "remote", onIngest, recall: async () => [], promote: async () => {} });
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentrig-ingest-lifecycle-"));
  store = new FileMemoryStore({ root: join(root, "wiki") }); await store.init();
  logPath = join(root, "session.jsonl");
  await writeFile(logPath, JSON.stringify({ type: "session.start", task: "inspect retries", cwd: root }) + "\n");
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

it("reports usage snapshots once, cache counts separately, and never invents cost", async () => {
  const onUsage = vi.fn();
  const result = await ingest({ onUsage, provider: provider(async function* () {
    yield { type: "usage", usage: { input: 10, output: 1 } };
    yield { type: "text_delta", text: answer };
    yield { type: "usage", usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 3 } };
  }) });
  expect(onUsage).toHaveBeenCalledTimes(1);
  expect(result.auxiliary).toMatchObject({ outcome: "completed", reportedUsage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 3 }, unknownUsageCalls: 0, costUsd: null });
  expect(result.auxiliary!.calls[0]).toMatchObject({ provider: "scripted", model: "fixture", usageComplete: true });
});

it.each([false, true])("marks absent or synthesized usage as unknown (synthetic=%s)", async synthetic => {
  const result = await ingest({ provider: provider(async function* () {
    yield { type: "text_delta", text: answer };
    if (synthetic) yield { type: "usage", usage: { input: 0, output: 0 }, reported: false };
  }) });
  expect(result.auxiliary).toMatchObject({ unknownUsageCalls: 1, costUsd: null });
});

it("zero-call stale captures report zero auxiliary cost without replaying backend work", async () => {
  await ingest(); const sink = backend(vi.fn(async () => []));
  const result = await ingest({ backend: sink });
  expect(result.auxiliary).toMatchObject({ calls: [], unknownUsageCalls: 0, costUsd: 0 });
  expect(sink.onIngest).not.toHaveBeenCalled();
});

it("aborts an ignoring provider promptly, releases the session lock and ignores late text/usage", async () => {
  const entered = gate(); const late = gate(); const abort = new AbortController(); const reports: AuxiliaryReport[] = [];
  let received: AbortSignal | undefined; let closed = false;
  const work = ingest({ signal: abort.signal, onUsage: report => reports.push(report), provider: provider(async function* (_req, signal) {
    received = signal; entered.resolve();
    try { await late.promise; yield { type: "text_delta", text: answer }; yield { type: "usage", usage: { input: 999, output: 999 } }; }
    finally { closed = true; }
  }) });
  const rejected = expect(work).rejects.toMatchObject({ name: "AbortError" });
  await entered.promise; abort.abort(); await rejected;
  expect(received!.aborted).toBe(true); expect(await store.read(source)).toBeNull();
  expect((await readdir(root)).filter(name => name.endsWith(".write.lock"))).toEqual([]);
  const snapshot = structuredClone(reports);
  late.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
  expect(closed).toBe(true); expect(reports).toEqual(snapshot);
  expect(await store.read(source)).toBeNull();
  expect(reports[0]).toMatchObject({ outcome: "aborted", unknownUsageCalls: 1, reportedUsage: { input: 0, output: 0 } });
  expect((await ingest()).skipped).toBe(false);
});

it.each(["callTimeoutMs", "timeoutMs"] as const)("bounds a never-settling provider by %s and aborts its signal", async limit => {
  let signal: AbortSignal | undefined; const onUsage = vi.fn();
  await expect(ingest({ limits: { [limit]: limit === "timeoutMs" ? 1000 : 40 }, onUsage, provider: provider(async function* (_req, s) {
    signal = s; await new Promise(() => {}); yield { type: "text_delta", text: answer };
  }) })).rejects.toMatchObject({ name: "TimeoutError" });
  expect(signal!.aborted).toBe(true); expect(await store.read(source)).toBeNull();
  expect(onUsage.mock.calls[0]![0]).toMatchObject({ outcome: "timeout", unknownUsageCalls: 1 });
});

it("retains partial reported usage on failure but marks total usage unknown", async () => {
  const onUsage = vi.fn();
  await expect(ingest({ onUsage, provider: provider(async function* () {
    yield { type: "usage", usage: { input: 17, output: 2 } }; throw new Error("transport closed");
  }) })).rejects.toThrow("transport closed");
  expect(onUsage.mock.calls[0]![0]).toMatchObject({ outcome: "failed", reportedUsage: { input: 17, output: 2 }, unknownUsageCalls: 1 });
});

it("counts retry overhead as unknown even when the successful attempt reports usage", async () => {
  const result = await ingest({ provider: provider(async function* () {
    yield { type: "retry", attempt: 1, maxAttempts: 3, delayMs: 1, reason: "transport" };
    yield { type: "text_delta", text: answer };
    yield { type: "usage", usage: { input: 10, output: 5 } };
  }) });
  expect(result.auxiliary).toMatchObject({ reportedUsage: { input: 10, output: 5 }, unknownUsageCalls: 1 });
});

it.each([0, -1, NaN, Infinity, 2 ** 32])("rejects invalid configured limits %s", async value => {
  const stream = vi.fn(provider().stream);
  await expect(ingest({ limits: { maxCalls: value }, provider: provider(stream) })).rejects.toThrow("invalid maintenance limit");
  expect(stream).not.toHaveBeenCalled(); expect(await store.read(source)).toBeNull();
});

it("enforces the shared total call budget before starting additional external work", async () => {
  const run = new MaintenanceRun("ingest", { maxCalls: 1 }); const next = vi.fn(async () => 2);
  let error: unknown;
  try { await run.call("first", "fixture", async () => 1); await run.call("second", "fixture", next); }
  catch (e) { error = e; }
  expect(next).not.toHaveBeenCalled(); expect(run.finish(error)).toMatchObject({ outcome: "limit", unknownUsageCalls: 1 });
});

it.each([
  { limits: { maxRawBytes: 10 }, match: /file exceeds/ },
  { limits: { maxEvents: 1 }, match: /event limit/ },
  { limits: { maxSpans: 1 }, maxSpanChars: 5, match: /span\/call limit/ },
  { limits: { maxInputChars: 10 }, match: /model input limit/ },
])("rejects oversized inputs before any provider or memory commit: $limits", async ({ match, ...opts }) => {
  await writeFile(logPath, Array.from({ length: 2 }, () => JSON.stringify({ type: "session.start", task: "inspect retries" })).join("\n"));
  const stream = vi.fn(provider().stream);
  await expect(ingest({ ...opts, provider: provider(stream) })).rejects.toThrow(match);
  expect(stream).not.toHaveBeenCalled(); expect(await store.read(source)).toBeNull();
});

it.each([
  { limits: { maxOutputChars: 10 }, stream: async function* () { yield { type: "text_delta" as const, text: answer }; }, match: /output limit/ },
  { limits: { maxModelEvents: 4 }, stream: async function* () { for (;;) yield { type: "text_delta" as const, text: "" }; }, match: /event limit/ },
  { limits: { maxFacts: 1 }, stream: async function* () { yield { type: "text_delta" as const, text: JSON.stringify({ facts: [fact, fact] }) }; }, match: /fact limit/ },
  { limits: { maxPages: 1 }, stream: provider().stream, match: /page limit/ },
])("rejects excess model work without a reservation or page commit: $limits", async ({ stream, match, ...opts }) => {
  await expect(ingest({ ...opts, provider: provider(stream) })).rejects.toThrow(match);
  expect(await store.pages()).toHaveLength(1); // untouched overview only
  expect(await store.index()).toEqual([]);
});

it("does not commit valid-looking JSON when the provider reports truncation", async () => {
  await expect(ingest({ provider: provider(async function* () {
    yield { type: "text_delta", text: answer }; yield { type: "stop", reason: "max_tokens" };
  }) })).rejects.toThrow("max_tokens");
  expect(await store.read(source)).toBeNull();
});

it("aborts a queued source mutation, retains completed reservations, and retries the partial run", async () => {
  const abort = new AbortController(); const original = store.update.bind(store);
  vi.spyOn(store, "update").mockImplementation(async (path, transform, opts) => {
    if (path === source) abort.abort();
    return original(path, transform, opts);
  });
  await expect(ingest({ signal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(await store.read(source)).toBeNull();
  expect((await store.index())[0]).toMatchObject({ status: "planned" });
  vi.restoreAllMocks(); expect((await ingest()).skipped).toBe(false);
});

it("checks cancellation before index, log, and final completion writes", async () => {
  const abort = new AbortController(); const original = store.appendLog.bind(store);
  vi.spyOn(store, "appendLog").mockImplementation(async (entry, opts) => { abort.abort(); return original(entry, opts); });
  const beforeLog = await readFile(join(store.root, "log.md"), "utf8");
  await expect(ingest({ signal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(await readFile(join(store.root, "log.md"), "utf8")).toBe(beforeLog);
  expect((await store.read(source))!.body).toContain("ingest:pending");
  expect((await store.read(source))!.body).not.toContain("ingest:events-v1");
});

it("aborts backend delivery without late provenance commits; local completion is not undone", async () => {
  const entered = gate(); const late = gate(); const abort = new AbortController(); let signal: AbortSignal | undefined;
  const sink = backend(async (_facts, _source, opts) => { signal = opts!.signal; entered.resolve(); await late.promise; return [{ factText: fact.text, memoryId: "late" }]; });
  const onUsage = vi.fn(); const work = ingest({ signal: abort.signal, backend: sink, onUsage });
  const rejected = expect(work).rejects.toMatchObject({ name: "AbortError" });
  await entered.promise;
  const before = await readFile(join(store.root, "concepts/retry.md"), "utf8");
  abort.abort(); await rejected; expect(signal!.aborted).toBe(true);
  late.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
  expect(await readFile(join(store.root, "concepts/retry.md"), "utf8")).toBe(before);
  expect((await store.read(source))!.body).toContain("ingest:events-v1");
  expect(onUsage.mock.calls[0]![0].calls[1]).toMatchObject({ operation: "backend.onIngest", outcome: "aborted", usageComplete: false });
  expect(onUsage.mock.calls[0]![0].localCommitState).toBe("completed");
});

it("tolerates backend timeout while reporting unknown remote cost and aborting cooperative work", async () => {
  let signal: AbortSignal | undefined; const onBackendError = vi.fn();
  const result = await ingest({ limits: { callTimeoutMs: 40 }, onBackendError, backend: backend(async (_facts, _source, opts) => {
    signal = opts!.signal; await new Promise(() => {}); return [];
  }) });
  expect(signal!.aborted).toBe(true); expect(onBackendError).toHaveBeenCalledTimes(1);
  expect(result.auxiliary!.calls[1]).toMatchObject({ outcome: "timeout", usageComplete: false });
  expect(result.auxiliary!.unknownUsageCalls).toBe(2);
});

it("bounded file reads reject directories and oversized existing pages without provider calls", async () => {
  const stream = vi.fn(provider().stream);
  await expect(ingest({ logPath: root, provider: provider(stream) })).rejects.toThrow(/regular file|EISDIR/);
  await store.write(source, { path: source, frontmatter: { type: "source", slug: "session-s1", aliases: [], sources: [], updated: "2026-09-05", confidence: "high" }, body: "x".repeat(3000) });
  await expect(ingest({ limits: { maxFileBytes: 1024 }, provider: provider(stream) })).rejects.toThrow("file exceeds");
  expect(stream).not.toHaveBeenCalled();
});

it("does not let a usage callback failure mask a completed ingest", async () => {
  expect((await ingest({ onUsage: () => { throw new Error("broken UI"); } })).factCount).toBe(1);
});

it("checks an already-aborted run before provider work and mutation-lock acquisition", async () => {
  const controller = new AbortController(); controller.abort(); const onUsage = vi.fn();
  const stream = vi.fn(provider().stream);
  await expect(ingest({ signal: controller.signal, provider: provider(stream), onUsage })).rejects.toMatchObject({ name: "AbortError" });
  expect(stream).not.toHaveBeenCalled(); expect(onUsage.mock.calls[0]![0]).toMatchObject({ calls: [], outcome: "aborted" });
  expect((await readdir(root)).filter(name => name.endsWith(".write.lock"))).toEqual([]);
});

it("bounded call cleanup cannot hang on iterator.return", async () => {
  const run = new MaintenanceRun("ingest", { callTimeoutMs: 30 });
  const p = provider(() => ({ [Symbol.asyncIterator]: () => ({ next: async () => new Promise(() => {}), return: async () => new Promise(() => {}) }) }));
  let error: unknown;
  try { await run.completeJson(p, "s", "u", 10); } catch (e) { error = e; }
  expect(error).toMatchObject({ name: "TimeoutError" });
  expect(run.finish(error).unknownUsageCalls).toBe(1);
});

it("passes ingest cancellation into the real Lore fetch adapter", async () => {
  const entered = gate(); const abort = new AbortController(); let received: AbortSignal | undefined;
  const lore = new LoreBackend({ apiUrl: "http://fixture", apiKey: "test", project: "test", fetchFn: (async (_url, init) => {
    received = init!.signal as AbortSignal; entered.resolve();
    return new Promise<Response>((_resolve, reject) => received!.addEventListener("abort", () => reject(received!.reason), { once: true }));
  }) as typeof fetch });
  const work = ingest({ backend: lore, signal: abort.signal }); const rejected = expect(work).rejects.toMatchObject({ name: "AbortError" });
  await entered.promise; abort.abort(); await rejected; expect(received!.aborted).toBe(true);
});

it("caps Lore response bodies and cancels oversized streams", async () => {
  const cancelled = vi.fn();
  const lore = new LoreBackend({ apiUrl: "http://fixture", apiKey: "test", project: "test", fetchFn: async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel: cancelled,
  })) });
  await expect(lore.onIngest([fact as Parameters<MemoryBackend["onIngest"]>[0][number]], { ref: "session:s1", project: "test" })).rejects.toThrow("response exceeds");
  expect(cancelled).toHaveBeenCalledTimes(1);
});

it("honors cancellation while waiting for the canonical wiki mutation lock", async () => {
  const controller = new AbortController(); const p = provider(async function* () {
    await writeFile(`${await realpath(store.root)}.write.lock`, "other owner");
    yield { type: "text_delta", text: answer };
    controller.abort();
  });
  await expect(ingest({ signal: controller.signal, provider: p })).rejects.toMatchObject({ name: "AbortError" });
  expect(await readFile(`${await realpath(store.root)}.write.lock`, "utf8")).toBe("other owner");
  expect(await store.read(source)).toBeNull();
});
