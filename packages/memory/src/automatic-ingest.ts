import { z } from "zod";
import { readBoundedFile } from "./bounded-file.js";
import { DEFAULT_INGEST_LIMITS, eventsToTranscript, planCoverage, type IngestLimits } from "./ingest.js";
import { positiveLimit } from "./maintenance.js";

/** Automatic capture is opportunistic; explicit ingest retains its full-sized defaults. */
export const AUTOMATIC_INGEST_LIMITS = Object.freeze({ timeoutMs: 30_000, callTimeoutMs: 15_000, maxCalls: 4 });
const record = z.object({ type: z.string() }).passthrough();
const callRecord = z.object({ id: z.string(), name: z.string() });
const resultRecord = z.object({ id: z.string(), ok: z.boolean(), permission: z.enum(["read", "write", "exec", "network", "net"]).optional() });

/** Cost heuristic, NOT a security boundary or a claim that conversation contains no learning.
 * Inspect the latest run only for eligibility; admitted ingest still covers the entire log.
 * Unknown dispatched permissions count as work. Denied calls were not dispatched.
 */
export async function automaticIngestDecision(path: string, limits: Partial<IngestLimits>, signal: AbortSignal, maxSpanChars = 6000, backendSlots = 0): Promise<string | undefined> {
  try {
    const maxEvents = positiveLimit("maxEvents", limits.maxEvents ?? DEFAULT_INGEST_LIMITS.maxEvents);
    const text = (await readBoundedFile(path, limits.maxRawBytes ?? DEFAULT_INGEST_LIMITS.maxRawBytes, signal)).toString("utf8");
    let count = 0; let boundary = false; let work = false;
    const events: unknown[] = [];
    const pending = new Set<string>();
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (++count > maxEvents) throw new Error("event scan limit exceeded");
      const event = record.parse(JSON.parse(line));
      events.push(event);
      if (event.type === "session.start" || event.type === "session.resume") {
        boundary = true; work = false; pending.clear();
      } else if (event.type === "file.changed") {
        work = true;
      } else if (event.type === "tool.call") {
        const call = callRecord.parse(event); pending.add(call.id);
        if (call.name === "attempt_log") work = true;
      } else if (event.type === "tool.result") {
        const result = resultRecord.parse(event); pending.delete(result.id);
        if (!result.ok || result.permission !== "read") work = true;
      }
    }
    signal.throwIfAborted();
    if (!boundary) return "no run boundary in recorded evidence";
    if (work || pending.size > 0) {
      const maxCalls = positiveLimit("maxCalls", limits.maxCalls ?? AUTOMATIC_INGEST_LIMITS.maxCalls);
      const maxSpans = positiveLimit("maxSpans", limits.maxSpans ?? DEFAULT_INGEST_LIMITS.maxSpans);
      try { planCoverage(eventsToTranscript(events), maxSpanChars, Math.min(maxSpans, Math.max(0, maxCalls - backendSlots))); }
      catch (error) {
        if (error instanceof Error && error.name === "MaintenanceLimitError") return "complete evidence exceeds automatic span/call budget";
        throw error;
      }
      return undefined;
    }
    return "latest run has no observed non-read work or failed tool results; useful conversational learning may remain";
  } catch (error) {
    signal.throwIfAborted();
    // No speculative capture from a prefix, malformed records or an unreadable file.
    return `eligibility scan incomplete (${error instanceof Error ? error.name : "unknown error"})`;
  }
}
