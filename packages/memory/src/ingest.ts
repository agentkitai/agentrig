import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { z } from "zod";
import type { ModelProvider } from "@agentkitai/agentrig-core";
import { PAGE_DIR, pagePath, serializePage } from "./page.js";
import { applyPinChecks, readPins, recheckPins } from "./pins.js";
import { tolerant, type MemoryBackend } from "./backend.js";
import type { FileMemoryStore } from "./store.js";
import type { Attempt, PageType } from "./types.js";

/**
 * Session ingest (PLAN §3.2): plan → reserve → generate → integrate.
 *
 * The coverage plan is the load-bearing part. A long session is split into bounded spans and
 * every span must come back either with distilled facts or explicitly closed as "nothing
 * durable here" — so a session can't silently lose its middle when the model's context runs
 * out. An unaccounted span is a hard error, not a shrug.
 */

export const DistilledFact = z.object({
  pageType: z.enum(["entity", "concept", "source", "analysis"]),
  slug: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, "slug must be kebab-case"),
  tag: z.enum(["stated", "observed", "inferred"]),
  text: z.string().min(1),
});
export type DistilledFact = z.infer<typeof DistilledFact>;

export const SpanDistillation = z.object({
  nothingDurable: z.boolean().default(false),
  summary: z.string().default(""),
  facts: z.array(DistilledFact).default([]),
});
export type SpanDistillation = z.infer<typeof SpanDistillation>;

export interface Span {
  id: string;
  from: number;
  to: number;
  /** Half-open UTF-16 offsets into the complete rendered transcript. */
  charFrom: number;
  charTo: number;
  text: string;
}

export interface EvidenceOmission {
  /** Zero-based event index in the parsed log. */
  eventIndex: number;
  field: string;
  reason: string;
}

export interface IngestResult {
  sessionId: string;
  /** Every span, and whether it was distilled or explicitly closed — the coverage guarantee. */
  coverage: Array<{ spanId: string; from: number; to: number; charFrom: number; charTo: number; outcome: "distilled" | "nothing-durable" | "empty" }>;
  /** Evidence not present in the textual transcript; never counted as inspected coverage. */
  omissions: EvidenceOmission[];
  pagesWritten: string[];
  pagesReserved: string[];
  factCount: number;
  /** Pins on pages this ingest touched whose claim no longer holds (PLAN §3.6). */
  pinConflicts: Array<{ page: string; claim: string; reason: string }>;
  /** Contradictions an optional backend reported against these facts (PLAN §3.8). */
  backendConflicts: Array<{ fact: string; existing: string; detail?: string }>;
  /** True when this session was already ingested and the new log is a prefix-superset. */
  supersededPrevious: boolean;
  skipped: boolean;
}

const SYSTEM = `You distill an agent session into durable wiki facts.

Return ONLY a JSON object: {"nothingDurable": boolean, "summary": string, "facts": [...]}
Each fact: {"pageType": "entity"|"concept"|"source"|"analysis", "slug": "kebab-case", "tag": "stated"|"observed"|"inferred", "text": "..."}

Rules:
- Record SHAPE, not volatile values: contracts, decisions, reasons, gotchas. Never a SHA, a line
  count, a current version number, or a file's present contents.
- "stated" = the user or a doc said it. "observed" = it happened in this session (a command
  failed, a test passed). "inferred" = you concluded it from evidence.
- Assistant messages are model claims, not independently verified tool evidence. Streamed fallback
  text may be an interrupted/uncommitted response. Tool-result patches describe what the model saw,
  not a replacement for original tool evidence. Omission markers are unavailable evidence.
- entity = a module, service, tool, command, external system. concept = a convention, decision,
  recurring pattern, gotcha.
- If this span contains nothing worth remembering next week, set nothingDurable true and return
  no facts. That is a normal and useful answer — do not invent facts to fill space.`;

/** Render textual evidence without prefix truncation; canonical assistant messages beat deltas. */
export function eventsToTranscript(events: unknown[]): string {
  return transcriptEvidence(events).text;
}

interface TranscriptRecord { from: number; to: number; kind: string }

function transcriptEvidence(events: unknown[]): { text: string; omissions: EvidenceOmission[]; records: TranscriptRecord[] } {
  const lines: string[] = [];
  const omissions: EvidenceOmission[] = [];
  let streamed = "";
  let responseEnded = false;
  const flushStream = () => {
    if (streamed !== "") lines.push(`[assistant:streamed-uncommitted] ${streamed}`);
    streamed = "";
    responseEnded = false;
  };
  const omit = (eventIndex: number, field: string, reason: string) => {
    omissions.push({ eventIndex, field, reason });
    lines.push(`[evidence.omitted] event=${eventIndex} field=${field}: ${reason}`);
  };
  for (const [eventIndex, raw] of events.entries()) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`invalid session event ${eventIndex}`);
    const e = raw as Record<string, unknown>;
    const type = String(e.type ?? "");
    if (["model.request", "turn.start", "turn.end", "tool.call", "session.start", "session.resume", "session.end"].includes(type)) flushStream();
    switch (type) {
      case "session.start":
      case "session.resume":
        lines.push(`[${type}] task=${JSON.stringify(e.task)} cwd=${String(e.cwd)}`);
        break;
      case "model.delta":
        if (responseEnded) flushStream();
        if (typeof e.text === "string") streamed += e.text;
        break;
      case "model.response":
        responseEnded = true;
        break;
      case "message.append": {
        const message = e.message as { role?: unknown; content?: unknown } | null;
        if (message === null || typeof message !== "object" || !Array.isArray(message.content)) {
          throw new Error(`invalid message.append at event ${eventIndex}`);
        }
        if (message.role === "assistant") { streamed = ""; responseEnded = false; }
        for (const [blockIndex, block] of message.content.entries()) {
          if (block?.type === "text" && typeof block.text === "string") {
            lines.push(`[${message.role === "assistant" ? "assistant" : "user.message"}] ${block.text}`);
          } else if (block?.type === "image") {
            omit(eventIndex, `message.content[${blockIndex}]`, "image content is not inspected by textual ingest");
          }
          // Tool-use/result blocks repeat the dedicated tool events, which retain full output.
        }
        break;
      }
      case "tool.call":
        lines.push(`[tool.call] ${String(e.name)} ${JSON.stringify(e.input)}`);
        break;
      case "tool.result": {
        const output = typeof e.output === "string" ? e.output : String(e.display ?? "");
        lines.push(`[tool.result] ok=${String(e.ok)} ${output}`);
        if (e.truncated === true && typeof e.output !== "string") {
          omit(eventIndex, "tool.result.output", "full output was not recorded; the undisplayed range is unavailable (length unknown)");
        }
        break;
      }
      case "tool.result.patched":
        lines.push(`[tool.result.patched] id=${String(e.id)} by=${String(e.by)} mode=${String(e.mode ?? "modify")} ${String(e.display ?? "")}`);
        break;
      case "file.changed":
        lines.push(`[file.changed] ${String(e.op)} ${String(e.path)}`);
        break;
      case "error":
        lines.push(`[error] fatal=${String(e.fatal)} ${String(e.message)}`);
        break;
      case "steer":
        lines.push(`[steer:${String(e.source)}] ${String(e.message)}`);
        break;
      case "session.end":
        lines.push(`[session.end] reason=${String(e.reason)}`);
        break;
      default:
        break;
    }
  }
  flushStream();
  let offset = 0;
  const records = lines.map((line, index) => {
    const from = offset;
    offset += line.length + (index < lines.length - 1 ? 1 : 0);
    return { from, to: offset, kind: /^\[([^\]]+)\]/.exec(line)![1]! };
  });
  return { text: lines.join("\n"), omissions, records };
}

/**
 * Split a transcript into bounded spans. Bounded by characters rather than events so one
 * enormous tool result can't produce a span that blows the context window.
 */
export function planCoverage(transcript: string, maxChars = 6000): Span[] {
  if (!Number.isSafeInteger(maxChars) || maxChars < 2) throw new Error("maxSpanChars must be an integer of at least 2");
  const spans: Span[] = [];
  let charFrom = 0;
  let line = 0;
  while (charFrom < transcript.length) {
    let charTo = Math.min(charFrom + maxChars, transcript.length);
    if (charTo < transcript.length) {
      const newline = transcript.lastIndexOf("\n", charTo - 1);
      if (newline >= charFrom) charTo = newline + 1;
      // Keep a surrogate pair together when splitting a very long line.
      else if (/[\uD800-\uDBFF]/.test(transcript[charTo - 1]!) && /[\uDC00-\uDFFF]/.test(transcript[charTo]!)) charTo--;
    }
    const text = transcript.slice(charFrom, charTo);
    const newlines = text.split("\n").length - 1;
    spans.push({
      id: `span-${spans.length + 1}`,
      from: line,
      to: line + newlines - (text.endsWith("\n") ? 1 : 0),
      charFrom,
      charTo,
      text,
    });
    charFrom = charTo;
    line += newlines;
  }
  return spans;
}

/** Shared with the dream (M5): one non-streaming JSON completion, no tools. */
export async function completeJson(provider: ModelProvider, system: string, user: string, maxTokens: number): Promise<string> {
  let text = "";
  for await (const ev of provider.stream(
    { system, messages: [{ role: "user", content: [{ type: "text", text: user }] }], tools: [], maxTokens },
    new AbortController().signal,
  )) {
    if (ev.type === "text_delta") text += ev.text;
  }
  return text;
}

/** Models fence JSON often enough that not handling it would be a self-inflicted failure. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();

  /** Index just past a balanced JSON value starting at `from`, or -1. */
  const balancedEnd = (from: number): number => {
    const open = candidate[from];
    const close = open === "{" ? "}" : open === "[" ? "]" : "";
    if (close === "") return -1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = from; i < candidate.length; i++) {
      const ch = candidate[i]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
    }
    return -1;
  };

  // Scan for TOP-LEVEL balanced values only (skipping past each one rather than descending into
  // it), then keep the richest. First-brace-to-last-brace slicing broke on a prose preamble, and
  // taking the first balanced value would return the "{}" in "use {} for defaults"; comparing
  // nested values would let a nested object outrank the real payload.
  let best: { value: unknown; size: number } | null = null;
  for (let i = 0; i < candidate.length; i++) {
    if (candidate[i] !== "{" && candidate[i] !== "[") continue;
    const end = balancedEnd(i);
    if (end === -1) continue;
    try {
      const value: unknown = JSON.parse(candidate.slice(i, end));
      const size = Array.isArray(value)
        ? value.length
        : typeof value === "object" && value !== null
          ? Object.keys(value).length
          : 0;
      if (best === null || size > best.size) best = { value, size };
    } catch {
      // not valid JSON on its own; fall through
    }
    i = end - 1; // skip past this value so nested ones are not considered separately
  }
  if (best !== null) return best.value;
  throw new Error(`no JSON object in model response: ${candidate.slice(0, 200)}`);
}

export interface IngestOptions {
  store: FileMemoryStore;
  provider: ModelProvider;
  sessionId: string;
  /** Path to the session's JSONL log. */
  logPath: string;
  attempts?: Attempt[];
  maxSpanChars?: number;
  maxTokens?: number;
  now?: () => number;
  /**
   * Optional sink (PLAN §3.8). Wrapped in `tolerant()` internally — the guarantee that a
   * backend cannot break an ingest must not depend on the caller remembering to wrap it.
   */
  backend?: MemoryBackend;
  /** Project name for backend scoping and provenance; defaults to the working directory's name. */
  project?: string;
  /** Ask the backend for contradictions during ingest. Off by default: PLAN §3.8 assigns the
   *  contradiction pass to the dream (M5), and each check is another round trip. */
  checkBackendConflicts?: boolean;
  /** Reported when a tolerated backend call fails; defaults to silence. */
  onBackendError?: (op: string, err: Error) => void;
}

async function readEvents(logPath: string): Promise<unknown[]> {
  const out: unknown[] = [];
  const rl = createInterface({ input: createReadStream(logPath, "utf8"), crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber++;
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      throw new Error(`invalid session JSON at line ${lineNumber}; retry ingest after the log is complete`);
    }
  }
  return out;
}

/**
 * Ingest one session into the wiki.
 *
 * Duplicate captures (`session_end` firing twice on a growing transcript) are detected by prefix
 * comparison: if the previous capture is a prefix of this one, this run supersedes it; if this
 * one is a prefix of what we already have, it is stale and skipped. Unique content is never
 * dropped — only a provably superseded snapshot is.
 */
export async function ingestSession(opts: IngestOptions): Promise<IngestResult> {
  const { store, provider, sessionId, logPath } = opts;
  const now = opts.now ?? (() => Date.now());
  const today = new Date(now()).toISOString().slice(0, 10);

  const events = await readEvents(logPath);
  const { text: transcript, omissions, records } = transcriptEvidence(events);
  const sourcePath = pagePath("source", `session-${sessionId}`);

  // prefix comparison against the previous capture of this same session
  const existing = await store.read(sourcePath).catch(() => null);
  const previousPrefix = /<!-- capture:prefix=([a-f0-9]+):len=(\d+) -->/.exec(existing?.body ?? "");
  let supersededPrevious = false;
  // Old projector captures may have discarded evidence before hashing. Reprocess once under
  // this coverage contract even when the surviving text happens to be identical.
  if (previousPrefix !== null && existing?.body.includes("<!-- ingest:version=2 -->")) {
    const prevLen = Number(previousPrefix[2]);
    const prevHash = previousPrefix[1]!;
    const thisPrefixHash = createHash("sha256").update(transcript.slice(0, prevLen)).digest("hex").slice(0, 16);
    if (thisPrefixHash === prevHash) {
      if (transcript.length <= prevLen) {
        return {
          sessionId,
          coverage: [],
          omissions,
          pagesWritten: [],
          pagesReserved: [],
          factCount: 0,
          supersededPrevious: false,
          skipped: true,
          pinConflicts: [],
          backendConflicts: [],
        };
      }
      supersededPrevious = true;
    }
  }

  const existingIndexSummary = (await store.index()).find((e) => e.slug === `session-${sessionId}`)?.summary;
  const spans = planCoverage(transcript, opts.maxSpanChars ?? 6000);
  const coverage: IngestResult["coverage"] = [];
  const facts: DistilledFact[] = [];
  const summaries: string[] = [];

  const emptyButNotClosed: string[] = [];
  let recordIndex = 0;
  for (const span of spans) {
    const range = { spanId: span.id, from: span.from, to: span.to, charFrom: span.charFrom, charTo: span.charTo };
    while (recordIndex < records.length && records[recordIndex]!.to <= span.charFrom) recordIndex++;
    const origins: string[] = [];
    for (let i = recordIndex; i < records.length && records[i]!.from < span.charTo; i++) {
      const record = records[i]!;
      origins.push(`${record.kind} [${Math.max(record.from, span.charFrom)}, ${Math.min(record.to, span.charTo)})`);
    }
    const attemptNote =
      opts.attempts === undefined || opts.attempts.length === 0
        ? ""
        : `\n\nAttempts recorded this session:\n${opts.attempts
            .map((a) => `- ${a.outcome}: ${a.hypothesis} — ${a.actions}${a.lesson ? ` (lesson: ${a.lesson})` : ""}`)
            .join("\n")}`;
    const raw = await completeJson(
      provider,
      SYSTEM,
      `Session ${sessionId}, span ${span.id} of ${spans.length}, transcript characters [${span.charFrom}, ${span.charTo}), lines ${span.from}-${span.to}. A span may continue a long event from an adjacent span. Evidence origins: ${origins.join("; ")}.\n\n${span.text}${attemptNote}`,
      opts.maxTokens ?? 2048,
    );
    let parsed: SpanDistillation;
    try {
      parsed = SpanDistillation.parse(extractJson(raw));
    } catch (err) {
      // a span we cannot account for is a coverage hole — fail loudly rather than lose it
      throw new Error(
        `ingest ${sessionId}: span ${span.id} (lines ${span.from}-${span.to}) could not be distilled: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    // a summary is evidence the span held something; keep it whatever the branch below decides
    if (parsed.summary !== "") summaries.push(parsed.summary);
    if (parsed.nothingDurable) {
      // the model explicitly closed this span — that is the coverage guarantee being met
      coverage.push({ ...range, outcome: "nothing-durable" });
      continue;
    }
    if (parsed.facts.length === 0) {
      if (parsed.summary === "") {
        // Nothing at all: no facts, no summary, and no explicit close. A truncated or degenerate
        // reply looks exactly like this, and calling it "covered" is the silent hole the
        // coverage plan exists to prevent — so fail at the end naming the span.
        coverage.push({ ...range, outcome: "empty" });
        emptyButNotClosed.push(`${span.id} (lines ${span.from}-${span.to})`);
        continue;
      }
      // a summary but no page-level facts is a real answer: the span was read and weighed
      coverage.push({ ...range, outcome: "distilled" });
      continue;
    }
    coverage.push({ ...range, outcome: "distilled" });
    facts.push(...parsed.facts);
  }

  if (emptyButNotClosed.length > 0) {
    throw new Error(
      `ingest ${sessionId}: ${emptyButNotClosed.length} span(s) returned no facts without ` +
        `explicitly reporting nothingDurable — coverage cannot be guaranteed: ${emptyButNotClosed.join(", ")}`,
    );
  }

  // reserve every non-source page before writing, so concurrent ingests converge on one page
  const targets = new Map<string, { type: PageType; slug: string; facts: DistilledFact[] }>();
  const sourceFacts: DistilledFact[] = [];
  for (const f of facts) {
    if (f.pageType === "source") {
      // the model is told "source" is a legal pageType, so these must be written somewhere —
      // they belong on this session's own page rather than being silently dropped
      sourceFacts.push(f);
      continue;
    }
    const key = `${f.pageType}/${f.slug}`;
    const target = targets.get(key) ?? { type: f.pageType, slug: f.slug, facts: [] };
    target.facts.push(f);
    targets.set(key, target);
  }
  const pagesReserved: string[] = [];
  for (const t of targets.values()) {
    const outcome = await store.reserve(t.slug, `session:${sessionId}`, t.type);
    if (outcome === "created") pagesReserved.push(pagePath(t.type, t.slug));
  }

  const pagesWritten: string[] = [];
  const ref = `session:${sessionId}`;

  // The source page: what happened, plus the capture marker used for prefix comparison.
  // Only a provably superseded capture may replace the previous body; otherwise merge, because
  // a re-ingest of a *different* transcript must not delete narrative that is still unique.
  const newLines = [
    ...summaries.map((s) => `- [observed] ${s} (${ref})`),
    ...sourceFacts.map((f) => `- [${f.tag}] ${f.text} (${ref})`),
  ];
  const priorSourceBody =
    existing === null || supersededPrevious
      ? ""
      : existing.body.replace(/<!-- capture:prefix=[^>]*-->/g, "").replace(/<!-- ingest:coverage=.*?-->/g, "")
        .replace(/<!-- ingest:version=\d+ -->/g, "").trim();
  const keptLines = priorSourceBody === "" ? [] : priorSourceBody.split("\n").filter((l) => l.trim() !== "");
  const merged = [...keptLines, ...newLines.filter((l) => !keptLines.includes(l))];
  const sourceBody = [
    ...(merged.length === 0 ? ["- [observed] Session produced no durable findings."] : merged),
    "",
    `<!-- capture:prefix=${createHash("sha256").update(transcript).digest("hex").slice(0, 16)}:len=${transcript.length} -->`,
    "<!-- ingest:version=2 -->",
    `<!-- ingest:coverage=${JSON.stringify({ coverage, omissions })} -->`,
  ].join("\n");
  await store.write(sourcePath, {
    path: sourcePath,
    frontmatter: {
      type: "source",
      slug: `session-${sessionId}`,
      aliases: [],
      sources: [ref],
      updated: today,
      confidence: "high",
    },
    body: sourceBody,
  });
  pagesWritten.push(sourcePath);
  await store.upsertIndex({
    slug: `session-${sessionId}`,
    path: sourcePath,
    type: "source",
    status: "active",
    summary: summaries[0] ?? existingIndexSummary ?? "session with no durable findings",
  });

  // entity/concept pages: append new fact lines, never rewriting what is already there
  for (const t of targets.values()) {
    const path = pagePath(t.type, t.slug);
    const page = await store.read(path).catch(() => null);
    const priorBody = page === null ? "" : page.body.replace(/^- \[inferred\] Reserved by .*$/gm, "").trim();
    const newLines = t.facts
      .map((f) => `- [${f.tag}] ${f.text} (${ref})`)
      .filter((line) => !priorBody.includes(line));
    const body = [priorBody, ...newLines].filter((s) => s !== "").join("\n");
    const sources = [...new Set([...(page?.frontmatter.sources ?? []), ref])];
    await store.write(path, {
      path,
      frontmatter: {
        type: t.type,
        slug: t.slug,
        aliases: page?.frontmatter.aliases ?? [],
        sources,
        updated: today,
        confidence: page?.frontmatter.confidence ?? "medium",
      },
      body,
    });
    pagesWritten.push(path);
    await store.upsertIndex({
      slug: t.slug,
      path,
      type: t.type,
      status: "active",
      summary: t.facts[0]?.text.slice(0, 120) ?? "",
    });
  }

  // PLAN §3.6: pins are re-checked after ANY regeneration, and surfaced where the change
  // happened — not only when a human remembers to run `memory lint`
  const touched = new Set(pagesWritten);
  const allPins = await readPins(store.root).catch(() => []);
  const relevant = allPins.filter((pin) => touched.has(pin.page));
  const checks = relevant.length === 0 ? [] : await recheckPins(store, relevant);
  if (checks.length > 0) await applyPinChecks(store.root, checks);
  const pinConflicts = checks
    .filter((c) => c.status !== "kept")
    .map((c) => ({ page: c.pin.page, claim: c.pin.claim, reason: c.reason }));

  await store.appendLog(
    `## [${today}] ingest | ${ref} | ${facts.length} facts, ${pagesWritten.length} pages` +
      `${supersededPrevious ? " (superseded an earlier capture)" : ""}` +
      `${pinConflicts.length === 0 ? "" : ` | ${pinConflicts.length} pin conflict(s)`}`,
  );

  // PLAN §3.8: the backend runs LAST — after every page, the pin re-check, and the log entry —
  // so no backend outcome, including an unwrapped throw, can leave the wiki half-written.
  const backendConflicts: IngestResult["backendConflicts"] = [];
  if (opts.backend !== undefined && facts.length > 0) {
    const backend = tolerant(opts.backend, opts.onBackendError ?? (() => {}));
    const project = opts.project ?? (basename(resolve(process.cwd())) || "default");
    if (opts.checkBackendConflicts === true && backend.conflicts !== undefined) {
      for (const c of await backend.conflicts(facts)) {
        backendConflicts.push(
          c.detail === undefined
            ? { fact: c.fact, existing: c.existing }
            : { fact: c.fact, existing: c.existing, detail: c.detail },
        );
      }
    }
    const acks = await backend.onIngest(facts, { ref, project });
    // provenance the wiki's way: annotate the fact lines we just wrote with their memory ids
    if (acks.length > 0) {
      await annotateProvenance(store, targets, acks, opts.backend.id, ref);
    }
  }

  return {
    sessionId,
    coverage,
    omissions,
    pagesWritten,
    pagesReserved,
    factCount: facts.length,
    supersededPrevious,
    skipped: false,
    pinConflicts,
    backendConflicts,
  };
}

/**
 * Append `(lore:<memory-id>)` to the fact lines a backend just stored (PLAN §3.8's first
 * provenance direction). Best-effort by design: it runs after everything else, and a failure
 * leaves the wiki correct, just without the cross-reference.
 */
async function annotateProvenance(
  store: FileMemoryStore,
  targets: Map<string, { type: PageType; slug: string; facts: DistilledFact[] }>,
  acks: Array<{ factText: string; memoryId: string }>,
  backendId: string,
  ref: string,
): Promise<void> {
  const idByText = new Map(acks.map((a) => [a.factText, a.memoryId]));
  for (const t of targets.values()) {
    const path = pagePath(t.type, t.slug);
    try {
      const page = await store.read(path);
      if (page === null) continue;
      let body = page.body;
      let changed = false;
      for (const fact of t.facts) {
        const memoryId = idByText.get(fact.text);
        if (memoryId === undefined) continue;
        const line = `- [${fact.tag}] ${fact.text} (${ref})`;
        if (!body.includes(line)) continue;
        body = body.replace(line, `${line.slice(0, -1)}, ${backendId}:${memoryId})`);
        changed = true;
      }
      if (changed) await store.write(path, { path, frontmatter: page.frontmatter, body });
    } catch {
      // provenance is an annotation, never a reason to fail an ingest that already succeeded
    }
  }
}

/** The schema doc the wiki ships with (PLAN §3.1); co-evolves with use. */
export const SCHEMA_MD = `# Wiki schema

How this wiki is written. The agent follows it; a human editing by hand should too.

## Layers

- \`raw/\` — immutable. Session logs, the attempts ledger, docs a human dropped in. Never rewritten.
  (\`<id>.snapshot.json\` and \`<id>.lock\` beside session logs are the harness's resume cache and
  lock, not raw sources — ingest ignores them.)
- \`wiki/\` — the agent writes, a human reads and corrects.
- \`SCHEMA.md\` — this file.

## Pages

${Object.entries(PAGE_DIR)
  .map(([type, dir]) => `- \`${dir}/\` — ${type} pages`)
  .join("\n")}

Every page:

\`\`\`markdown
${serializePage(
  { type: "entity", slug: "auth-module", aliases: ["auth"], sources: ["session:8f2a"], updated: "2026-08-29", confidence: "high" },
  "- [stated] Retries apply per request, not per batch (session:8f2a)\\n- [observed] The 429 path returns before the body is read (session:9c11)",
).trim()}
\`\`\`

- Every fact line carries a tag and a source ref.
- \`[[wikilinks]]\` connect pages.
- **Shape, not value.** Contracts, decisions, and reasons — never a SHA, a line count, or a
  current version. Read volatile state live from the repo. Historical narrative is the exception.

## Operations

- **Ingest** — plan (bounded spans, each distilled or explicitly closed as nothing-durable) →
  reserve page slugs atomically → generate → integrate into pages, \`index.md\`, and \`log.md\`.
- **Query** — \`index.md\` first, then the union of index-selected pages and BM25 over bodies.
  Additive only: BM25 adds recall, it never replaces an index pick.
- **Lint (dream)** — scheduled, offline, over a copy. Never modifies its input.

## Pins

\`pins.json\` holds human corrections that must survive regeneration. A pin stores the *claim*,
not a diff, so it can be re-checked after the page is rewritten. A contradicted pin is surfaced,
never silently dropped.
`;
