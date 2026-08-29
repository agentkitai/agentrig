import { z } from "zod";
import type { PageFrontmatter, PageType, WikiPage } from "./types.js";

/**
 * Page format (PLAN §3.3): YAML-ish frontmatter between `---` fences, then a body of fact lines.
 * The frontmatter is deliberately a tiny hand-rolled subset — scalars and inline `[a, b]` lists —
 * so the wiki has no YAML dependency and stays trivially diffable by a human.
 */

export const FrontmatterSchema = z.object({
  type: z.enum(["entity", "concept", "source", "analysis"]),
  slug: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  sources: z.array(z.string()).default([]),
  updated: z.string(),
  confidence: z.enum(["high", "medium", "low"]).default("medium"),
});

const FENCE = "---";

function parseScalar(raw: string): string {
  const v = raw.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function parseList(raw: string): string[] {
  const v = raw.trim();
  if (!v.startsWith("[") || !v.endsWith("]")) return v === "" ? [] : [parseScalar(v)];
  const inner = v.slice(1, -1).trim();
  if (inner === "") return [];
  return inner.split(",").map((s) => parseScalar(s)).filter((s) => s !== "");
}

export interface ParsedPage {
  frontmatter: PageFrontmatter;
  body: string;
}

/** Throws on a malformed page — a corrupt wiki file should surface, not be silently half-read. */
export function parsePage(text: string, path = "<unknown>"): ParsedPage {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith(`${FENCE}\n`)) {
    throw new Error(`${path}: missing frontmatter fence`);
  }
  const end = normalized.indexOf(`\n${FENCE}`, FENCE.length);
  if (end === -1) throw new Error(`${path}: unterminated frontmatter`);
  const head = normalized.slice(FENCE.length + 1, end);
  const body = normalized.slice(end + FENCE.length + 2).replace(/^\n/, "");

  const raw: Record<string, unknown> = {};
  for (const line of head.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1);
    raw[key] = key === "aliases" || key === "sources" ? parseList(value) : parseScalar(value);
  }
  const parsed = FrontmatterSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${path}: invalid frontmatter — ${parsed.error.issues[0]?.message ?? "unknown"}`);
  return { frontmatter: parsed.data, body };
}

export function serializePage(frontmatter: PageFrontmatter, body: string): string {
  const list = (xs: string[]) => `[${xs.join(", ")}]`;
  const head = [
    `type: ${frontmatter.type}`,
    `slug: ${frontmatter.slug}`,
    `aliases: ${list(frontmatter.aliases)}`,
    `sources: ${list(frontmatter.sources)}`,
    `updated: ${frontmatter.updated}`,
    `confidence: ${frontmatter.confidence}`,
  ].join("\n");
  return `${FENCE}\n${head}\n${FENCE}\n\n${body.replace(/\s+$/, "")}\n`;
}

/** Directory each page type lives under (PLAN §3.1). */
export const PAGE_DIR: Record<PageType, string> = {
  source: "sources",
  entity: "entities",
  concept: "concepts",
  analysis: "analyses",
};

export function pagePath(type: PageType, slug: string): string {
  return `${PAGE_DIR[type]}/${slug}.md`;
}

/** `[[wikilinks]]` referenced by a body, deduped in order of appearance. */
export function wikilinks(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const link = m[1]!.trim();
    if (link !== "" && !out.includes(link)) out.push(link);
  }
  return out;
}

/** Fact lines carry a `[tag]` and usually a `(source:ref)` — used by lint and provenance checks. */
export interface FactLine {
  tag: "stated" | "observed" | "inferred";
  text: string;
  refs: string[];
}

export function factLines(body: string): FactLine[] {
  const out: FactLine[] = [];
  for (const line of body.split("\n")) {
    const m = /^\s*-\s*\[(stated|observed|inferred)\]\s*(.*)$/.exec(line);
    if (m === null) continue;
    const text = m[2]!.trim();
    const refs = [...text.matchAll(/\(([^)]*(?:session|doc|dream|lore):[^)]*)\)/g)].flatMap((r) =>
      r[1]!.split(",").map((s) => s.trim()).filter((s) => s !== ""),
    );
    out.push({ tag: m[1] as FactLine["tag"], text, refs });
  }
  return out;
}

export type { WikiPage };
