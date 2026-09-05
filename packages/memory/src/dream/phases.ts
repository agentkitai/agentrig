import { z } from "zod";
import type { AuxiliaryReport, ModelProvider } from "@agentkitai/agentrig-core";
import type { Attempt, IndexEntry, WikiPage } from "../types.js";
import { extractJson } from "../ingest.js";
import { MaintenanceRun, MaintenanceLimitError, maintenanceDiagnostic, positiveLimit, type MaintenanceLimits } from "../maintenance.js";
import { factLines } from "../page.js";

/**
 * PLAN §3.7's four phases, each its own prompt "so they can be tested independently". They are
 * separate exported functions for exactly that reason: a test drives one phase with a scripted
 * provider and asserts on its output, without standing up a whole dream.
 *
 * Only `consolidate` and `promote` need a model. `orient` is pure assembly and `prune` is
 * arithmetic — keeping them model-free is what lets the dream stay cheap enough to schedule.
 */

// ---------------------------------------------------------------- phase 1: orient

export interface Orientation {
  /** The digest handed to every later prompt, so they share one view of the wiki. */
  summary: string;
  pageCount: number;
  schema: string;
}

/** Reads `index.md`, `overview.md` and `SCHEMA.md` into one bounded digest. No model call. */
export function orient(index: IndexEntry[], schema: string, overview: string, maxChars = 6000): Orientation {
  const rows = index
    .map((e) => `- ${e.path} [${e.type}] ${e.status === "planned" ? "(planned) " : ""}${e.summary}`)
    .join("\n");
  const parts = [
    overview.trim() === "" ? "" : `# Overview\n${overview.trim()}`,
    `# Index (${index.length} entries)\n${rows}`,
  ].filter((p) => p !== "");
  let summary = parts.join("\n\n");
  if (summary.length > maxChars) summary = `${summary.slice(0, maxChars)}\n…(index truncated)`;
  return { summary, pageCount: index.length, schema: schema.slice(0, 4000) };
}

// ------------------------------------------------------- phase 2: gather signal

export interface Signal {
  kind: "correction" | "decision" | "recurring_error" | "workaround" | "lesson";
  text: string;
  sources: string[];
}

/**
 * Scans raw material since the last dream for the five shapes PLAN §3.7 names. Attempts with a
 * `lesson` are the highest-value input here and need no model at all — the agent already wrote
 * the conclusion down, so lifting it is free.
 */
export function gatherFromAttempts(attempts: Attempt[]): Signal[] {
  const out: Signal[] = [];
  const byLesson = new Map<string, Set<string>>();

  for (const a of attempts) {
    if (a.lesson !== undefined && a.lesson.trim() !== "") {
      const key = a.lesson.trim();
      byLesson.set(key, (byLesson.get(key) ?? new Set()).add(`session:${a.sessionId}`));
    }
  }
  for (const [lesson, sources] of byLesson) {
    out.push({ kind: "lesson", text: lesson, sources: [...sources].sort() });
  }

  // an outcome that failed the same way across two or more sessions is a recurring error;
  // once is just a thing that happened
  const failures = new Map<string, Set<string>>();
  for (const a of attempts) {
    if (a.outcome !== "failed" && a.outcome !== "reverted") continue;
    const key = a.hypothesis.trim().toLowerCase();
    if (key === "") continue;
    failures.set(key, (failures.get(key) ?? new Set()).add(`session:${a.sessionId}`));
  }
  for (const [hypothesis, sources] of failures) {
    if (sources.size < 2) continue;
    out.push({
      kind: "recurring_error",
      text: `"${hypothesis}" was tried and failed in ${sources.size} separate sessions`,
      sources: [...sources].sort(),
    });
  }
  return out;
}

// --------------------------------------------------------- phase 3: consolidate

export const ContradictionSchema = z.object({
  pages: z.array(z.string()).min(1),
  claims: z.array(z.string()).min(1),
  resolution: z.string(),
});
export const SupersededSchema = z.object({
  page: z.string(),
  old: z.string(),
  new: z.string(),
  source: z.string(),
});
export const ConsolidationSchema = z.object({
  contradictions: z.array(ContradictionSchema).default([]),
  superseded: z.array(SupersededSchema).default([]),
  merged: z.array(z.object({ from: z.array(z.string()).min(2), to: z.string() })).default([]),
  removed: z.array(z.object({ page: z.string(), line: z.string(), reason: z.string() })).default([]),
});
export type Consolidation = z.infer<typeof ConsolidationSchema>;

const CONSOLIDATE_SYSTEM = `You are the consolidation pass of a wiki's scheduled lint ("dream").

You are given a set of wiki pages and the signals gathered from recent sessions. Find, strictly
from the text you are shown:

- contradictions: two pages (or two lines) that cannot both be true.
- superseded: a claim a NEWER source has replaced. Quote the old and the new text.
- merged: pages covering the same subject that should become one. Only when they genuinely
  duplicate; near-neighbours are not duplicates.
- removed: lines that should go, with a reason. Be conservative — losing a true fact is worse
  than keeping a redundant one.

Rules:
- Never invent a page path. Use only paths you were shown.
- Quote claims verbatim from the pages; do not paraphrase into the "claims" field.
- An empty finding list is a perfectly good answer. Do not manufacture findings.

Reply with ONLY this JSON:
{"contradictions":[{"pages":["..."],"claims":["..."],"resolution":"..."}],
 "superseded":[{"page":"...","old":"...","new":"...","source":"..."}],
 "merged":[{"from":["...","..."],"to":"..."}],
 "removed":[{"page":"...","line":"...","reason":"..."}]}`;

export interface ConsolidateOptions {
  signal?: AbortSignal;
  limits?: Partial<MaintenanceLimits>;
  onUsage?: (report: AuxiliaryReport) => void;
  provider: ModelProvider;
  pages: WikiPage[];
  signals: Signal[];
  orientation: Orientation;
  maxTokens?: number;
  /** Characters of page text sent; the dream must stay bounded on a large wiki. */
  maxPageChars?: number;
  /** Signals sent, and their total characters — the attempts ledger grows without bound. */
  maxSignals?: number;
  maxSignalChars?: number;
  /** Ordinary model/JSON failures are advisory; cancellation, timeouts and caps throw. */
  onError?: (err: Error) => void;
}

export async function consolidate(opts: ConsolidateOptions, sharedRun?: MaintenanceRun): Promise<Consolidation> {
  const run = sharedRun ?? new MaintenanceRun("dream", { maxInputChars: 65_536, maxCalls: 1, ...opts.limits }, opts.signal);
  let failure: unknown;
  try { return await consolidateWithin(opts, run, error => { failure = error; }); }
  catch (error) { failure = error; throw error; }
  finally {
    if (sharedRun === undefined) {
      const report = run.finish(failure);
      maintenanceDiagnostic(() => opts.onUsage?.(structuredClone(report)));
    }
  }
}

async function consolidateWithin(opts: ConsolidateOptions, run: MaintenanceRun, failed: (error: unknown) => void): Promise<Consolidation> {
  run.check();
  const maxPageChars = opts.maxPageChars ?? 24_000;
  positiveLimit("maxPageChars", maxPageChars);
  positiveLimit("maxSignals", opts.maxSignals ?? 40);
  positiveLimit("maxSignalChars", opts.maxSignalChars ?? 6000);
  let budget = maxPageChars;
  const rendered: string[] = [];
  for (const p of opts.pages) {
    run.check();
    const block = `--- ${p.path} (updated ${p.frontmatter.updated}, sources: ${p.frontmatter.sources.join(", ")})\n${p.body}`;
    if (block.length > budget) {
      rendered.push(`${block.slice(0, Math.max(0, budget))}\n…(truncated)`);
      break;
    }
    rendered.push(block);
    budget -= block.length;
  }

  // signals are bounded too. They come from the attempts ledger, which grows for the life of the
  // project — 400 attempts with long lessons built a 212k-char prompt against a 24k page budget,
  // which is neither cheap nor schedulable. Best-corroborated first, since those are the ones
  // worth spending context on.
  const maxSignals = opts.maxSignals ?? 40;
  const maxSignalChars = opts.maxSignalChars ?? 6000;
  const ranked = [...opts.signals].sort((a, b) => b.sources.length - a.sources.length);
  const signalLines: string[] = [];
  let signalBudget = maxSignalChars;
  for (const s of ranked.slice(0, maxSignals)) {
    const line = `- [${s.kind}] ${s.text.slice(0, 400)} (${s.sources.slice(0, 8).join(", ")})`;
    if (line.length > signalBudget) break;
    signalLines.push(line);
    signalBudget -= line.length;
  }

  const user = [
    opts.orientation.summary,
    "",
    "# Pages",
    rendered.join("\n\n"),
    "",
    "# Signals from recent sessions",
    signalLines.length === 0 ? "(none)" : signalLines.join("\n"),
  ].join("\n");

  const empty: Consolidation = { contradictions: [], superseded: [], merged: [], removed: [] };
  // `extractJson` THROWS on a response with no JSON in it, so it has to be guarded separately
  // from the schema check — a model that answers in prose must cost the consolidation pass, not
  // the whole dream. The structural findings are already gathered by this point and are worth
  // keeping on their own.
  let extracted: unknown;
  try {
    const raw = await run.completeJson(opts.provider, CONSOLIDATE_SYSTEM, user, opts.maxTokens ?? 4096, { requireEndTurn: true });
    run.check();
    extracted = extractJson(raw);
  } catch (err) {
    failed(err);
    if (run.signal.aborted || err instanceof MaintenanceLimitError || (err instanceof Error && err.name === "TimeoutError")) throw err;
    maintenanceDiagnostic(() => opts.onError?.(err instanceof Error ? err : new Error(String(err))));
    return empty;
  }
  const parsed = ConsolidationSchema.safeParse(extracted);
  if (!parsed.success) {
    const error = new Error(`consolidation response did not match the schema: ${parsed.error.issues[0]?.message ?? ""}`);
    failed(error); maintenanceDiagnostic(() => opts.onError?.(error));
    return empty;
  }
  return dropUnknownPages(parsed.data, opts.pages);
}

/**
 * A model that names a page the wiki does not have would send the apply step at a file that does
 * not exist. Findings are dropped rather than trusted — the report has to be actionable.
 */
export function dropUnknownPages(c: Consolidation, pages: WikiPage[]): Consolidation {
  const known = new Set(pages.map((p) => p.path));
  return {
    contradictions: c.contradictions.filter((x) => x.pages.every((p) => known.has(p))),
    superseded: c.superseded.filter((x) => known.has(x.page)),
    merged: c.merged.filter((x) => known.has(x.to) && x.from.every((p) => known.has(p)) && x.from.length >= 2),
    removed: c.removed.filter((x) => known.has(x.page)),
  };
}

// ----------------------------------------------------- phase 4: prune & index

/**
 * Rebuilds `index.md` lean: one row per page, summary clipped, planned rows that were never
 * filled dropped, and rows whose page is gone removed. No model call — the summary comes from
 * the page's own first fact line, which is what the ingest already wrote.
 */
export function rebuildIndex(pages: WikiPage[], previous: IndexEntry[], maxSummary = 120): IndexEntry[] {
  const prior = new Map(previous.map((e) => [e.path, e]));
  return pages
    .map((p) => {
      const facts = factLines(p.body);
      const was = prior.get(p.path);
      // A reservation that was never filled must stay `planned` and keep its claim. Stamping
      // every row `active` destroyed the ledger PLAN §3.1 depends on: the `unfilled` lint check
      // could never fire again after one dream, and `index.md` — injected into every system
      // prompt — began advertising placeholders as real pages.
      const stillAPlaceholder = was?.status === "planned" && facts.length === 0;
      const first = facts[0]?.text ?? was?.summary ?? "";
      const summary = first.replace(/\s+/g, " ").trim().slice(0, maxSummary);
      const entry: IndexEntry = {
        slug: p.frontmatter.slug,
        path: p.path,
        type: p.frontmatter.type,
        summary,
        status: stillAPlaceholder ? "planned" : "active",
      };
      if (stillAPlaceholder && was?.claimedBy !== undefined) entry.claimedBy = was.claimedBy;
      return entry;
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}
