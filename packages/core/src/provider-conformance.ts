import { z } from "zod";
import type { ModelEvent, ModelProvider, ModelRequest } from "./provider.js";
import { Usage } from "./events.js";

const Observation = z.enum(["observed", "not-observed", "unknown"]);
export const ProviderConformance = z.object({
  version: z.literal(1), observedAt: z.number().int().nonnegative(),
  tools: Observation, parallelTools: Observation, promptedSchema: Observation,
  nativeStrictness: z.literal("unknown"), caching: Observation, cacheReporting: Observation,
  streams: z.number().int().min(0).max(5), retries: z.number().int().nonnegative(),
  usage: Usage, usageComplete: z.boolean(),
}).strict();
export type ProviderConformance = z.infer<typeof ProviderConformance>;
export interface ProviderCapabilityEvidence {
  /** Observed means at least one capability dimension has a non-unknown sample, not all. */
  source: "observed" | "unverified-configured";
  sources: Record<"tools" | "parallelTools" | "caching", "observed" | "unverified-configured">;
  report?: ProviderConformance;
}

/** Empirical samples only; no tools are executed and no server/permission attestation is made. */
export async function probeProvider(provider: ModelProvider, options: { signal?: AbortSignal; now?: () => number } = {}): Promise<ProviderConformance> {
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 30_000);
  const signal = options.signal === undefined ? abort.signal : AbortSignal.any([abort.signal, options.signal]);
  const report: ProviderConformance = { version: 1, observedAt: (options.now ?? Date.now)(), tools: "unknown", parallelTools: "unknown",
    promptedSchema: "unknown", nativeStrictness: "unknown", caching: "unknown", cacheReporting: "unknown", streams: 0, retries: 0,
    usage: { input: 0, output: 0 }, usageComplete: true };
  const base = (text: string): ModelRequest => ({ system: "You are running a bounded provider conformance sample. Follow the exact request. ".repeat(64),
    messages: [{ role: "user", content: [{ type: "text", text }] }], tools: [], maxTokens: 256, cacheHints: { systemPrefix: true } });
  const spec = (name: string) => ({ name, description: "Inert conformance fixture; return the requested value.",
    inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } });
  type Sample = { text: string; calls: Array<Extract<ModelEvent, { type: "tool_use" }>>; stop: string };
  async function sample(req: ModelRequest): Promise<Sample | undefined> {
    if (signal.aborted || report.streams >= 5) return undefined;
    report.streams++; let text = ""; const calls: Sample["calls"] = []; let count = 0; let chars = 0; let stops = 0; let stop = ""; let usageSeen = false; let complete = true;
    const stageAbort = new AbortController(); const streamSignal = AbortSignal.any([signal, stageAbort.signal]);
    const iterator = provider.stream(req, streamSignal)[Symbol.asyncIterator]();
    let onAbort: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => { onAbort = () => reject(new Error("probe interrupted")); streamSignal.addEventListener("abort", onAbort, { once: true }); if (streamSignal.aborted) onAbort(); });
    try {
      for (;;) {
        const next = await Promise.race([iterator.next(), interrupted]); if (next.done) break;
        const event = next.value; if (++count > 256) throw new Error("event limit");
        if (event.type === "text_delta") { chars += event.text.length; text += event.text; }
        else if (event.type === "tool_use") { chars += JSON.stringify(event).length; calls.push(event); if (calls.length > 8) throw new Error("tool count limit"); }
        else if (event.type === "stop") { stops++; stop = event.reason; }
        else if (event.type === "retry") { report.retries++; complete = false; }
        else if (event.type === "usage") {
          const usage = Usage.parse(event.usage); usageSeen = true; if (event.reported === false) { complete = false; continue; }
          report.usage.input += usage.input; report.usage.output += usage.output;
          for (const key of ["cacheRead", "cacheWrite"] as const) if (usage[key] !== undefined) {
            report.usage[key] = (report.usage[key] ?? 0) + usage[key];
            report.cacheReporting = "observed"; if (usage[key] > 0) report.caching = "observed";
          }
        }
        if (chars > 16_384) throw new Error("output limit");
      }
      if (stops !== 1 || (stop !== "end_turn" && stop !== "tool_use")) throw new Error("incomplete sample");
      return { text, calls, stop };
    } catch { complete = false; return undefined; }
    finally {
      report.usageComplete &&= usageSeen && complete;
      if (onAbort !== undefined) streamSignal.removeEventListener("abort", onAbort);
      stageAbort.abort();
      // Do not wait indefinitely for an uncooperative custom iterator. No destructive I/O is run.
      void iterator.return?.().catch(() => {});
    }
  }
  const exactCall = (call: Sample["calls"][number] | undefined, name: string, value: string) => call !== undefined &&
    typeof call.id === "string" && call.id.length > 0 && call.name === name && z.object({ value: z.literal(value) }).strict().safeParse(call.input).success;
  try {
    const firstReq = base('Call probe_echo exactly once with {"value":"probe"}. Do not answer in text.'); firstReq.tools = [spec("probe_echo")];
    const first = await sample(firstReq);
    if (first !== undefined) {
      report.tools = "not-observed";
      if (first.stop === "tool_use" && first.calls.length === 1 && exactCall(first.calls[0], "probe_echo", "probe")) {
        const roundtrip = structuredClone(firstReq); roundtrip.messages.push({ role: "assistant", content: first.calls },
          { role: "user", content: [{ type: "tool_result", toolUseId: first.calls[0]!.id, content: "probe-result" },
            { type: "text", text: "Reply with exactly the tool result text, no more tool calls." }] });
        const second = await sample(roundtrip);
        report.tools = second === undefined ? "unknown" : second.stop === "end_turn" && second.text.trim() === "probe-result" && second.calls.length === 0 ? "observed" : "not-observed";
      }
    }
    const parallelReq = base('In ONE response call probe_alpha with {"value":"alpha"} and probe_beta with {"value":"beta"}.');
    parallelReq.tools = [spec("probe_alpha"), spec("probe_beta")]; const parallel = await sample(parallelReq);
    if (parallel !== undefined) report.parallelTools = parallel.stop === "tool_use" && parallel.calls.length === 2 && parallel.calls[0]!.id !== parallel.calls[1]!.id &&
      parallel.calls.some(c => exactCall(c, "probe_alpha", "alpha")) && parallel.calls.some(c => exactCall(c, "probe_beta", "beta")) ? "observed" : "not-observed";
    const schemaReq = base('Return only JSON matching this exact schema, no markdown: {"type":"object","properties":{"ok":{"const":true},"value":{"const":7}},"required":["ok","value"],"additionalProperties":false}.');
    const schema = await sample(schemaReq);
    if (schema !== undefined) {
      try { report.promptedSchema = schema.stop === "end_turn" && schema.calls.length === 0 && z.object({ ok: z.literal(true), value: z.literal(7) }).strict().safeParse(JSON.parse(schema.text)).success ? "observed" : "not-observed"; }
      catch { report.promptedSchema = "not-observed"; }
    }
    await sample(schemaReq); // same stable request; missing/zero cache counts do not prove no caching
    if (report.streams === 0) report.usageComplete = false;
    return ProviderConformance.parse(report);
  } finally { clearTimeout(timer); abort.abort(); }
}

export function applyProviderConformance(provider: ModelProvider, report?: ProviderConformance): void {
  const sources = { tools: "unverified-configured", parallelTools: "unverified-configured", caching: "unverified-configured" } as ProviderCapabilityEvidence["sources"];
  for (const key of ["tools", "parallelTools", "caching"] as const) if (report !== undefined && report[key] !== "unknown") sources[key] = "observed";
  const source = Object.values(sources).some(value => value === "observed") ? "observed" : "unverified-configured";
  provider.capabilities.conformance = { source, sources, ...(report === undefined ? {} : { report: structuredClone(report) }) };
  if (report === undefined) return;
  for (const key of ["tools", "parallelTools", "caching"] as const) if (report[key] !== "unknown") provider.capabilities[key] = report[key] === "observed";
}
