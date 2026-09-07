import { safeSliceEnd, sanitizeLine, type HarnessEvent } from "@agentkitai/agentrig-core";
import { renderChatEvent, renderEvent } from "../render.js";

export interface ToolSummaryLine { text: string; tone: "event" | "error" }
export const TOOL_SUMMARY_LIMITS = { pending: 128, reads: 64, line: 160, rawLines: 128, rawBytes: 65_536, rawLine: 2_048 } as const;
const safe = (text: string, length: number = TOOL_SUMMARY_LIMITS.line): string => {
  const bounded = text.length > length * 4 ? `${text.slice(0, safeSliceEnd(text, length * 4))}…` : text;
  return sanitizeLine(bounded, length).replace(/\s+/gu, " ").trim();
};
interface Pending { session: string; seq: number; id: string; name: string; argument: string; file: boolean; internal: boolean }
function argument(input: unknown): string {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    for (const key of ["path", "command", "pattern", "query", "task", "name"]) {
      const value = (input as Record<string, unknown>)[key];
      if (typeof value === "string" && value !== "") return safe(value, 80);
    }
  }
  return "";
}
/** Presentation only. Runtime permissions/dispatch and the append-only event log never read this. */
export class ToolSummaries {
  private pending: Pending[] = [];
  private reads = 0;
  private elapsed = 0;
  private raw: string[] = [];
  private bytes = 0;
  private omitted = 0;
  private session: string | undefined;

  private remember(e: HarnessEvent): void {
    // Bound the projected input before the existing raw renderer serializes it. Full input stays
    // in the immutable log; this recent expansion is explicitly a bounded presentation.
    let event = e;
    if (e.type === "tool.call") {
      const input: Record<string, unknown> = Object.create(null);
      if (e.input && typeof e.input === "object" && !Array.isArray(e.input)) {
        let count = 0;
        for (const key in e.input) {
          if (!Object.hasOwn(e.input, key)) continue;
          if (++count > 8) { input["[omitted]"] = "further keys"; break; }
          const value = (e.input as Record<string, unknown>)[key];
          input[safe(key, 64)] = typeof value === "string" ? safe(value, 256)
            : typeof value === "number" || typeof value === "boolean" || value === null ? value : "[nested input omitted]";
        }
      } else input["[input]"] = "[non-object input omitted]";
      event = { ...e, id: safe(e.id, 256), name: safe(e.name, 64), inputHash: safe(e.inputHash, 128), input };
    }
    const line = safe(`[${safe(e.sessionId, 64)}] ${renderEvent(event)}`, TOOL_SUMMARY_LIMITS.rawLine);
    this.raw.push(line); this.bytes += Buffer.byteLength(line);
    while (this.raw.length > TOOL_SUMMARY_LIMITS.rawLines || this.bytes > TOOL_SUMMARY_LIMITS.rawBytes) {
      this.bytes -= Buffer.byteLength(this.raw.shift()!); this.omitted++;
    }
  }
  flushReads(): ToolSummaryLine[] {
    if (this.reads === 0) return [];
    const text = `✓ read ${this.reads} files · ${this.reads} requests, repeats counted · ${this.elapsed}ms summed`;
    this.reads = 0; this.elapsed = 0; return [{ text: safe(text), tone: "event" }];
  }
  finish(): ToolSummaryLine[] {
    const lines = this.flushReads();
    for (const call of this.pending) lines.push({ text: safe(`? ${call.name} ${call.argument} · elapsed unknown · incomplete (no matched result)`), tone: "error" });
    this.pending = []; return lines;
  }
  expand(): ToolSummaryLine[] {
    const lines = this.flushReads();
    if (this.omitted) lines.push({ text: `verbose: ${this.omitted} older tool-detail lines elided; full events remain in the session log`, tone: "event" });
    if (this.raw.length) lines.push({ text: "verbose: retained tool details (bounded input projection; earlier Static summaries remain)", tone: "event" });
    lines.push(...this.raw.map(text => ({ text, tone: "event" as const })));
    this.raw = []; this.bytes = 0; this.omitted = 0; this.pending = []; return lines;
  }
  push(e: HarnessEvent): { handled: boolean; lines: ToolSummaryLine[] } {
    const lines: ToolSummaryLine[] = [];
    if (this.session !== e.sessionId) { lines.push(...this.finish()); this.session = e.sessionId; }
    if (e.type === "permission.decision" && e.d === "allow" && (e.source?.kind === "rule" || e.source?.kind === "fallback")) {
      this.remember(e); return { handled: true, lines };
    }
    if (e.type === "tool.call") {
      this.remember(e);
      if (e.id.length > 256 || e.sessionId.length > 128) {
        lines.push(...this.flushReads(), { text: safe(`? ${e.name} · incomplete (display identity cap)`), tone: "error" });
        return { handled: true, lines };
      }
      const file = e.name === "read_file" && e.input !== null && typeof e.input === "object" &&
        typeof (e.input as Record<string, unknown>).path === "string" && (e.input as Record<string, unknown>).path !== "";
      if (!file || e.internal !== undefined) lines.push(...this.flushReads());
      if (this.pending.length >= TOOL_SUMMARY_LIMITS.pending) {
        const old = this.pending.shift()!;
        lines.push({ text: safe(`? ${old.name} ${old.argument} · incomplete (pending display cap)`), tone: "error" });
      }
      this.pending.push({ session: e.sessionId, seq: e.seq, id: e.id, name: safe(e.name, 64), argument: argument(e.input), file, internal: e.internal !== undefined });
      return { handled: true, lines };
    }
    if (e.type === "tool.result") {
      this.remember(e);
      const candidates = this.pending.filter(call => call.session === e.sessionId && call.id === e.id && (e.toolCallSeq === undefined || call.seq === e.toolCallSeq));
      const call = candidates.length === 1 ? candidates[0] : undefined;
      if (call) this.pending.splice(this.pending.indexOf(call), 1);
      const elapsed = Number.isSafeInteger(e.durationMs) && e.durationMs >= 0 ? e.durationMs : undefined;
      if (call?.file && !call.internal && e.internal === undefined && e.toolCallSeq === call.seq && e.permission === "read" && e.ok && e.diagnostics === undefined && elapsed !== undefined) {
        if (!Number.isSafeInteger(this.elapsed + elapsed)) lines.push(...this.flushReads());
        this.reads++; this.elapsed += elapsed;
        if (this.reads >= TOOL_SUMMARY_LIMITS.reads) lines.push(...this.flushReads());
      } else {
        lines.push(...this.flushReads());
        lines.push({ text: safe(`${call === undefined ? "?" : e.ok ? "✓" : "✗"} ${call?.name ?? "unmatched tool"} ${call?.argument ?? ""} · ${elapsed === undefined ? "elapsed unknown" : `${elapsed}ms`} · ${call === undefined ? "unmatched result" : e.ok ? "ok" : "failed"}`), tone: e.ok ? "event" : "error" });
        // Keep the existing diagnostic/error text visible rather than folding it into success.
        const detail = renderChatEvent(e); if (detail !== null) lines.push({ text: detail, tone: e.ok ? "event" : "error" });
      }
      return { handled: true, lines };
    }
    if (e.type === "turn.end" || e.type === "session.end") lines.push(...this.finish());
    else if (e.type === "model.delta" || e.type === "permission.decision" && e.d !== "allow" || renderChatEvent(e) !== null ||
      e.type === "message.append" && e.message.role === "assistant" && e.message.content.some(b => b.type === "thinking")) lines.push(...this.flushReads());
    return { handled: false, lines };
  }
}
