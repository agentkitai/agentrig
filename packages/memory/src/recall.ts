import type { RetrievalHit } from "./search.js";

/**
 * R17e. What a recall actually returned, in the terms a person can check: the page and the claim.
 *
 * A count ("8 results") is not evidence — it cannot be disagreed with. The wiki's whole promise is
 * that a human can open the page the agent read, so a recall line names the page and quotes the
 * line that matched.
 *
 * Both halves live here on purpose. `formatRecallHits` writes the tool's display and
 * `recallEvidence` reads it back, so the format is one package's business and a round-trip test
 * pins them together (`memory/test/recall.test.ts`). The CLI receives structure and does its own
 * bounding and sanitising for the terminal; it never has to know this shape.
 */

/** No control characters, no line breaks: one display line per claim, so the format stays parseable
 * and a backend's returned text cannot forge a second page entry. (Core's `sanitizeLine` does the
 * same job for the CLI, but `memory` depends on core for types only.) */
export function oneLine(value: string, max = 240): string {
  const flat = value
    // Control and format characters together: C0/C1 controls, zero-width joiners and the bidi
    // overrides that can visually reorder a rendered line.
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
}

export const RECALL_VIA = ["index", "bm25", "both", "backend"] as const;
export type RecallVia = (typeof RECALL_VIA)[number];

/** The retrieval tools whose results are a recall. Exported so the CLI need not restate them. */
export const MEMORY_RECALL_TOOLS: ReadonlySet<string> = new Set(["memory_search", "memory_read"]);

/** `memory_search`'s display: one `<page> [<via>]` line, then one indented claim line. */
const HIT = /^(\S[^\n]*?) \[(index|bm25|both|backend)\]$/;
const CLAIM = /^ {2}(.*)$/;

export function formatRecallHits(hits: readonly RetrievalHit[]): string {
  return hits
    .map((hit) => hit.via === "backend"
      ? `${oneLine(hit.ref, 120)} [backend]\n  ${oneLine(hit.text)}`
      : `${oneLine(hit.page.path, 120)} [${hit.via}]\n  ${oneLine(hit.snippet)}`)
    .join("\n");
}

export interface RecalledPage {
  page: string;
  via: RecallVia | "read";
  claim: string;
}

export interface RecallEvidence {
  tool: string;
  /** The search query, or the path for a direct read. */
  subject: string;
  pages: RecalledPage[];
  /** Pages the tool returned that this evidence does not list, because of the display bound. */
  omitted: number;
  /** The tool's own output was cut short, so even the full text is only part of what it found. */
  incomplete: boolean;
  /** Set when the recall found nothing; `pages` is then empty and that is the whole story. */
  empty: boolean;
}

export interface RecallInput {
  tool: string;
  /** The validated `tool.call` input, for the query or path. Unknown shapes degrade to "". */
  input?: unknown;
  display: string;
  ok: boolean;
  /** `tool.result.truncated` / `outputIncomplete`: the display or the collection was cut short. */
  truncated?: boolean;
  outputIncomplete?: boolean;
  /** How many pages the evidence lists before it starts counting omissions. */
  limit?: number;
}

function field(input: unknown, key: string): string {
  if (input === null || typeof input !== "object") return "";
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? oneLine(value, 120) : "";
}

/**
 * Structure for one memory recall, or null when there is nothing honest to say: a tool that is not
 * a recall tool, or a call that failed. A failed or denied read must never render as "memory says",
 * and a `post_tool` hook that rewrote what the model saw is a separate event — this describes what
 * the tool itself returned.
 */
export function recallEvidence(call: RecallInput): RecallEvidence | null {
  if (!MEMORY_RECALL_TOOLS.has(call.tool) || !call.ok) return null;
  const limit = call.limit ?? 5;
  const incomplete = call.truncated === true || call.outputIncomplete === true;
  if (call.tool === "memory_read") {
    const page = field(call.input, "path");
    const claims = readClaims(call.display);
    return {
      tool: call.tool,
      subject: page,
      pages: claims.slice(0, limit).map((claim) => ({ page: page === "" ? "(unnamed page)" : page, via: "read" as const, claim })),
      omitted: Math.max(0, claims.length - limit),
      incomplete,
      empty: claims.length === 0,
    };
  }
  const hits = parseRecallDisplay(call.display);
  return {
    tool: call.tool,
    subject: field(call.input, "query"),
    pages: hits.slice(0, limit),
    omitted: Math.max(0, hits.length - limit),
    incomplete,
    empty: hits.length === 0,
  };
}

/** Reads back exactly what `formatRecallHits` wrote; anything else is not claimed as a page. */
export function parseRecallDisplay(display: string): RecalledPage[] {
  const lines = display.split("\n");
  const out: RecalledPage[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = HIT.exec(lines[i] ?? "");
    if (match?.[1] === undefined || match[2] === undefined) continue;
    const claim = CLAIM.exec(lines[i + 1] ?? "");
    if (claim?.[1] === undefined) continue;
    out.push({ page: match[1], via: match[2] as RecallVia, claim: claim[1] });
    i += 1;
  }
  return out;
}

/** Fact lines of a page as `memory_read` printed it: `- [stated|observed|inferred] …`. */
function readClaims(display: string): string[] {
  const out: string[] = [];
  for (const line of display.split("\n")) {
    if (/^- \[[a-z]+\]/.test(line.trim())) out.push(oneLine(line.trim()));
  }
  return out;
}
