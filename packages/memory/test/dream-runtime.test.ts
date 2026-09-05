import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AuxiliaryReport, ModelEvent, ModelProvider } from "@agentkitai/agentrig-core";
import { FileMemoryStore, FileRawStore, fingerprint, runDream } from "@agentkitai/agentrig-memory";

vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename), writeFile: vi.fn(actual.writeFile) };
});
let root: string; let wiki: FileMemoryStore; let output: string;
const path = "concepts/a.md";
const events: ModelEvent[] = [{ type: "text_delta", text: "{}" }, { type: "stop", reason: "end_turn" }];
function provider(list: ModelEvent[] = events): ModelProvider {
  return { id: "fixture", model: "bounded-dream", capabilities: { tools: false, parallelTools: false, caching: false, contextWindow: 100000 },
    async *stream() { for (const event of list) yield event; } };
}
const options = () => ({ wiki, raw: new FileRawStore({ root }), outputRoot: output });
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "agentrig-dream-runtime-")));
  wiki = new FileMemoryStore({ root: join(root, "wiki") }); output = join(root, "output"); await wiki.init();
  await wiki.write(path, { path, body: "- [observed] original fact (doc:fixture)\n", frontmatter: {
    type: "concept", slug: "a", aliases: [], sources: ["doc:fixture"], updated: "2026-09-05", confidence: "high" } });
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
const absent = (file: string) => expect(fs.lstat(file)).rejects.toMatchObject({ code: "ENOENT" });

it("preflights a near-cap log before paying and preserves history when the cap is raised", async () => {
  const log = join(wiki.root, "log.md"); const history = (await fs.readFile(log, "utf8")) + "é".repeat(980);
  await fs.writeFile(log, history); const before = await fingerprint(wiki.root);
  const paid = provider(); const stream = vi.spyOn(paid, "stream"); const reports: AuxiliaryReport[] = [];
  await expect(runDream({ ...options(), provider: paid, scanLimits: { maxFileBytes: 2048 }, onUsage: report => reports.push(report) }))
    .rejects.toThrow("log capacity preflight");
  expect(stream).not.toHaveBeenCalled(); expect(reports[0]).toMatchObject({ outcome: "limit", calls: [], costUsd: 0 });
  expect(await fingerprint(wiki.root)).toBe(before); await absent(join(wiki.root, ".last-dream"));
  await absent(output); await absent(output + ".dream.json");
  const result = await runDream({ ...options(), provider: paid, scanLimits: { maxFileBytes: 4096 } });
  expect(stream).toHaveBeenCalledTimes(1);
  expect(await fs.readFile(join(output, "log.md"), "utf8")).toContain(history + "\n");
  expect(await fs.readFile(log, "utf8")).toBe(history); await result.workspace.dispose();
});

it("reports zero-call structural work and protects the result from a throwing/mutating usage callback", async () => {
  const result = await runDream({ ...options(), structuralOnly: true, onUsage: report => {
    report.reportedUsage.input = 999; throw new Error("notification failed");
  } });
  expect(result.auxiliary).toMatchObject({ operation: "dream", outcome: "completed", calls: [], costUsd: 0,
    unknownUsageCalls: 0, reportedUsage: { input: 0, output: 0 }, localCommitState: "completed" });
  await result.workspace.dispose();
});

it("ignores asynchronous diagnostic rejections without discarding a completed artifact", async () => {
  const result = await runDream({ ...options(), provider: provider([{ type: "text_delta", text: "not json" }, events[1]!]),
    onUsage: async () => { throw new Error("async usage notification"); },
    onError: async () => { throw new Error("async warning notification"); } });
  await new Promise(resolve => setImmediate(resolve));
  expect(result.consolidationError).toBeDefined(); expect(result.auxiliary!.outcome).toBe("failed");
  await result.workspace.dispose();
});

it("records the last cumulative usage snapshot and automatic apply within the same operation", async () => {
  const before = await fingerprint(wiki.root);
  const result = await runDream({ ...options(), autoApply: true, provider: provider([
    { type: "usage", usage: { input: 10, output: 2 } }, { type: "usage", usage: { input: 15, output: 3, cacheRead: 4 } }, ...events,
  ]) });
  expect(result.autoApply?.status).toBe("applied");
  if (result.autoApply?.status !== "applied") throw new Error("expected apply");
  expect(await fingerprint(result.autoApply.backup)).toBe(before);
  expect(result.auxiliary).toMatchObject({ outcome: "completed", reportedUsage: { input: 15, output: 3, cacheRead: 4 },
    unknownUsageCalls: 0, costUsd: null, calls: [{ provider: "fixture", model: "bounded-dream", outcome: "completed", usageComplete: true }] });
  await result.workspace.dispose();
});

it("times out an uncooperative iterator and closes it without awaiting a hung return", async () => {
  let seenSignal: AbortSignal | undefined; let late!: (value: IteratorResult<ModelEvent>) => void;
  const close = vi.fn(() => new Promise<IteratorResult<ModelEvent>>(() => {}));
  const p: ModelProvider = { ...provider(), stream(_request, signal) {
    seenSignal = signal;
    return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(resolve => { late = resolve; }), return: close }) };
  } };
  const reports: AuxiliaryReport[] = []; const before = await fingerprint(wiki.root);
  await expect(runDream({ ...options(), provider: p, autoApply: true, limits: { callTimeoutMs: 25 },
    onUsage: report => reports.push(report) })).rejects.toMatchObject({ name: "TimeoutError" });
  expect(seenSignal?.aborted).toBe(true); expect(close).toHaveBeenCalledTimes(1);
  expect(reports[0]).toMatchObject({ outcome: "timeout", unknownUsageCalls: 1, calls: [{ outcome: "timeout", usageComplete: false }] });
  late({ done: false, value: { type: "usage", usage: { input: 999, output: 999 } } });
  await new Promise(resolve => setImmediate(resolve));
  expect(reports[0]!.reportedUsage).toEqual({ input: 0, output: 0 });
  expect(await fingerprint(wiki.root)).toBe(before); await absent(output); await absent(output + ".dream.json");
});

it.each(["parent", "overall"])("propagates %s cancellation to a stalled provider and skips later phases", async kind => {
  const controller = new AbortController(); let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; }); let signal: AbortSignal | undefined;
  const p: ModelProvider = { ...provider(), stream(_request, nextSignal) {
    signal = nextSignal; started();
    return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
  } };
  const phases: string[] = []; const reports: AuxiliaryReport[] = [];
  const running = runDream({ ...options(), provider: p, autoApply: true, signal: controller.signal,
    limits: { timeoutMs: kind === "overall" ? 1000 : 5000, callTimeoutMs: 5000 },
    onPhase: phase => phases.push(phase), onUsage: report => reports.push(report) });
  const rejection = expect(running).rejects.toMatchObject({ name: kind === "overall" ? "TimeoutError" : "AbortError" });
  await ready; if (kind === "parent") controller.abort(); await rejection;
  expect(signal?.aborted).toBe(true); expect(phases).not.toContain("apply"); expect(phases).not.toContain("install");
  expect(reports[0]!.outcome).toBe(kind === "overall" ? "timeout" : "aborted"); await absent(output);
});

it.each(["input", "output", "events"])("stops on a model %s cap instead of applying a structural fallback", async kind => {
  const reports: AuxiliaryReport[] = [];
  const limits = kind === "input" ? { maxInputChars: 1 } : kind === "output" ? { maxOutputChars: 1 } : { maxModelEvents: 1 };
  await expect(runDream({ ...options(), provider: provider(), autoApply: true, limits,
    onUsage: report => reports.push(report) })).rejects.toMatchObject({ name: "MaintenanceLimitError" });
  expect(reports[0]!.outcome).toBe("limit"); expect(reports[0]!.calls).toHaveLength(kind === "input" ? 0 : 1);
  await absent(output); expect((await fs.readdir(root)).some(name => name.includes("before-dream"))).toBe(false);
});

it.each(["missing-stop", "malformed", "refusal"])("keeps a %s model response review-only and reports failure", async kind => {
  const list: ModelEvent[] = kind === "missing-stop" ? [events[0]!] : kind === "malformed"
    ? [{ type: "text_delta", text: "not json" }, events[1]!] : [{ type: "stop", reason: "refusal" }];
  const result = await runDream({ ...options(), provider: provider(list), autoApply: true, onError: () => { throw new Error("warning callback"); } });
  expect(result.autoApply).toEqual({ status: "refused", reason: "model consolidation failed" });
  expect(result.auxiliary!.outcome).toBe("failed"); expect(result.consolidationError).toBeDefined();
  expect((await fs.readdir(root)).some(name => name.includes("before-dream"))).toBe(false); await result.workspace.dispose();
});

it.each(["apply", "prune", "install"])("does not mutate the live wiki after cancellation at phase %s", async stopped => {
  const controller = new AbortController(); const before = await fingerprint(wiki.root);
  await expect(runDream({ ...options(), structuralOnly: true, autoApply: true, signal: controller.signal,
    onPhase: phase => { if (phase === stopped) controller.abort(); } })).rejects.toThrow();
  expect(await fingerprint(wiki.root)).toBe(before);
  expect((await fs.readdir(root)).some(name => name.includes("before-dream"))).toBe(false);
  if (stopped !== "install") await absent(output);
  else { expect(JSON.parse(await fs.readFile(output + ".dream.json", "utf8")).outputRoot).toBe(output); }
});

it("finishes a live swap after cancellation during its first rename and reports the committed result", async () => {
  const controller = new AbortController(); const actual = await vi.importActual<typeof fs>("node:fs/promises");
  let injected = false;
  vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    await actual.rename(from, to);
    if (String(from) === wiki.root) { injected = true; controller.abort(); }
  });
  const result = await runDream({ ...options(), structuralOnly: true, autoApply: true, signal: controller.signal });
  expect(injected).toBe(true); expect(result.autoApply?.status).toBe("applied");
  expect(result.auxiliary).toMatchObject({ outcome: "completed", localCommitState: "completed" });
  expect(await fs.readFile(join(wiki.root, path), "utf8")).toContain("original fact"); await result.workspace.dispose();
});

it("detects an exceeded per-call deadline even when synchronous provider work delayed its timer", async () => {
  const p: ModelProvider = { ...provider(), async *stream() {
    const until = performance.now() + 30; while (performance.now() < until) { /* bounded timer-starvation fixture */ }
    yield* events;
  } };
  await expect(runDream({ ...options(), provider: p, limits: { callTimeoutMs: 5 } })).rejects.toMatchObject({ name: "TimeoutError" });
  await absent(output);
});

it.each(["missing", "synthetic", "retry", "malformed"])("does not report %s usage as known/free", async kind => {
  const usage: ModelEvent = { type: "usage", usage: { input: 10, output: 2 } };
  const extra: ModelEvent[] = kind === "missing" ? [] : kind === "synthetic" ? [{ ...usage, reported: false }]
    : kind === "retry" ? [usage, { type: "retry", attempt: 1, maxAttempts: 3, delayMs: 1, reason: "transport" }, usage]
    : [{ type: "usage", usage: { input: -1, output: 2 } }, usage];
  const result = await runDream({ ...options(), provider: provider([...extra, ...events]) });
  expect(result.auxiliary).toMatchObject({ outcome: "completed", unknownUsageCalls: 1, costUsd: null,
    calls: [{ outcome: "completed", usageComplete: false }] });
  await result.workspace.dispose();
});

it("does not race a cancelled local writer or release its lock before the write settles", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs/promises"); const controller = new AbortController();
  let entered!: () => void; let release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }); const held = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(fs.writeFile).mockImplementation(async (file, data, options) => {
    await actual.writeFile(file, data, options);
    if (String(file).startsWith(join(output, path) + ".") && String(file).endsWith(".tmp")) {
      controller.abort(); entered(); await held;
    }
  });
  const before = await fingerprint(wiki.root); let settled = false;
  const p = provider([{ type: "text_delta", text: JSON.stringify({ removed: [{ page: path, line: "original fact (doc:fixture)", reason: "fixture" }] }) }, events[1]!]);
  const running = runDream({ ...options(), provider: p, autoApply: true, signal: controller.signal });
  void running.then(() => { settled = true; }, () => { settled = true; });
  const assertion = expect(running).rejects.toMatchObject({ name: "AbortError" });
  await ready;
  try {
    expect((await fs.readFile(output + ".write.lock", "utf8")).split(":")[0]).toBe(String(process.pid));
    await new Promise(resolve => setImmediate(resolve)); expect(settled).toBe(false);
  } finally { release(); await assertion; }
  expect(vi.mocked(fs.rename).mock.calls.some(([, to]) => String(to) === join(output, path))).toBe(false);
  await absent(output); await absent(output + ".write.lock"); expect(await fingerprint(wiki.root)).toBe(before);
});

it("lets timeout interrupts run during an endless immediately-resolved model stream", async () => {
  const p: ModelProvider = { ...provider(), async *stream() { for (;;) yield { type: "text_delta", text: "" }; } };
  await expect(runDream({ ...options(), provider: p, limits: { callTimeoutMs: 20, maxModelEvents: 2147483647 } }))
    .rejects.toMatchObject({ name: "TimeoutError" });
  await absent(output);
});
