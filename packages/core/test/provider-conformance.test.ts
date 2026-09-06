import { expect, it, vi } from "vitest";
import { applyProviderConformance, probeProvider, type ModelEvent, type ModelProvider, type ModelRequest } from "@agentkitai/agentrig-core";

function fixture(mode: "good" | "mismatch" | "missing" | "error" | "zero" = "good") {
  const requests: ModelRequest[] = []; const signals: AbortSignal[] = [];
  const provider: ModelProvider = { id: "fixture", model: "fixture", capabilities: { tools: true, parallelTools: true, caching: false, contextWindow: 12345 },
    async *stream(req, signal): AsyncIterable<ModelEvent> {
      requests.push(structuredClone(req)); signals.push(signal);
      if (mode === "error") throw new Error("server echoes SECRET");
      if (mode === "mismatch") yield { type: "text_delta", text: "wrong" };
      else if (req.tools.length === 1 && req.messages.length === 1) yield { type: "tool_use", id: "echo", name: "probe_echo", input: { value: "probe" } };
      else if (req.messages.length > 1) yield { type: "text_delta", text: "probe-result" };
      else if (req.tools.length === 2) {
        yield { type: "tool_use", id: "a", name: "probe_alpha", input: { value: "alpha" } };
        yield { type: "tool_use", id: "b", name: "probe_beta", input: { value: "beta" } };
      } else yield { type: "text_delta", text: '{"ok":true,"value":7}' };
      if (mode !== "missing") yield { type: "usage", usage: { input: 10, output: 2, cacheRead: mode === "zero" ? 0 : 3 } };
      yield { type: "stop", reason: req.tools.length > 0 && req.messages.length === 1 && mode !== "mismatch" ? "tool_use" : "end_turn" };
    } };
  return { provider, requests, signals };
}
it("observes exact roundtrip, simultaneous calls, prompted JSON and reported cache; applies actual flags", async () => {
  const f = fixture(); const report = await probeProvider(f.provider, { now: () => 123 });
  expect(report).toMatchObject({ tools: "observed", parallelTools: "observed", promptedSchema: "observed", nativeStrictness: "unknown", caching: "observed", cacheReporting: "observed", streams: 5,
    usage: { input: 50, output: 10, cacheRead: 15 }, usageComplete: true });
  expect(f.requests.every(req => req.maxTokens === 256)).toBe(true); expect(f.requests[4]).toEqual(f.requests[3]);
  expect(f.requests[1]!.messages[2]!.content[0]).toMatchObject({ type: "tool_result", toolUseId: "echo", content: "probe-result" });
  applyProviderConformance(f.provider, report); expect(f.provider.capabilities.caching).toBe(true); expect(f.provider.capabilities.contextWindow).toBe(12345);
  expect(f.provider.capabilities.conformance?.sources.caching).toBe("observed");
});
it("completed mismatches disable empirically unobserved tool flags, not context window", async () => {
  const f = fixture("mismatch"); const report = await probeProvider(f.provider);
  expect(report).toMatchObject({ tools: "not-observed", parallelTools: "not-observed", promptedSchema: "not-observed", streams: 4 });
  applyProviderConformance(f.provider, report); expect(f.provider.capabilities).toMatchObject({ tools: false, parallelTools: false, contextWindow: 12345 });
});
it.each(["missing", "zero", "error"] as const)("%s never becomes proof that caching is unsupported or known zero cost", async mode => {
  const f = fixture(mode); const report = await probeProvider(f.provider);
  expect(report.caching).toBe("unknown"); expect(report.usageComplete).toBe(mode === "zero");
  expect(report.cacheReporting).toBe(mode === "zero" ? "observed" : "unknown");
  expect(JSON.stringify(report)).not.toContain("SECRET");
  applyProviderConformance(f.provider, report); expect(f.provider.capabilities.conformance?.sources.caching).toBe("unverified-configured");
});
it("pre-abort spends no calls and reports usage incomplete", async () => {
  const f = fixture(); const report = await probeProvider(f.provider, { signal: AbortSignal.abort() });
  expect(report.streams).toBe(0); expect(report.usageComplete).toBe(false); expect(f.requests).toEqual([]);
});
it("deadline ends an uncooperative iterator without starting subsequent streams", async () => {
  const f = fixture(); const started = Promise.withResolvers<void>(); let signal: AbortSignal | undefined;
  f.provider.stream = (_req, s) => { signal = s; return { [Symbol.asyncIterator]() { return { next() { started.resolve(); return new Promise(() => {}); }, return() { return new Promise(() => {}); } }; } }; };
  const timers = vi.spyOn(globalThis, "setTimeout");
  try {
    const pending = probeProvider(f.provider); await started.promise;
    (timers.mock.calls.find(([, ms]) => ms === 30_000)![0] as () => void)();
    const report = await pending; expect(signal?.aborted).toBe(true); expect(report.streams).toBe(1); expect(report.usageComplete).toBe(false);
  } finally { timers.mockRestore(); }
});
it("oversized tool/text output remains unknown rather than successful conformance", async () => {
  const f = fixture(); f.provider.stream = async function* () { yield { type: "text_delta", text: "x".repeat(16_385) }; yield { type: "stop", reason: "end_turn" }; };
  const report = await probeProvider(f.provider); expect(report.promptedSchema).toBe("unknown"); expect(report.usageComplete).toBe(false);
});
it("synthesized usage does not masquerade as reported cost and retry usage remains incomplete", async () => {
  for (const synthesized of [true, false]) {
    const f = fixture(); f.provider.stream = async function* () {
      if (!synthesized) yield { type: "retry", attempt: 1, maxAttempts: 2, delayMs: 0, reason: "fixture" };
      yield { type: "usage", usage: { input: 99, output: 99, cacheRead: 99 }, reported: !synthesized };
      yield { type: "text_delta", text: "wrong" }; yield { type: "stop", reason: "end_turn" };
    };
    const report = await probeProvider(f.provider); expect(report.usageComplete).toBe(false);
    expect(report.usage.input).toBe(synthesized ? 0 : 396); expect(report.caching).toBe(synthesized ? "unknown" : "observed");
  }
});
