import type { WikiPage } from "../types.js";
import { factLines } from "../page.js";

/**
 * PLAN §3.4 and §7 both say it, so it is a hard gate rather than a prompt instruction:
 * **never promote anything derived from a single session.**
 *
 * The reason is that one session's conclusion is an observation, not a fact about the world. It
 * may be true only of that branch, that machine, that afternoon. Corroboration across two
 * independent sessions is the cheapest available proxy for "this generalizes", and it is the
 * difference between a global wiki that is worth consulting and one that accumulates noise.
 *
 * Because it is structural, a model cannot argue its way past it: the evidence is counted from
 * the page's own frontmatter and fact-line provenance, and a page that fails the count is never
 * offered for promotion regardless of how confident anything is about it.
 */

export interface PromotionCandidate {
  from: string;
  toGlobal: string;
  evidence: string[];
}

export interface PromotionRejection {
  page: string;
  reason: string;
  evidence: string[];
}

export interface PromotionOptions {
  /** Distinct sessions required. PLAN's rule is "never from a single session", so ≥ 2. */
  minSessions?: number;
  /** Refuse to promote a page whose confidence the ingest marked low. */
  minConfidence?: "low" | "medium" | "high";
}

const RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

/** Every distinct `session:<id>` backing a page, from frontmatter and from fact-line provenance. */
export function sessionEvidence(page: WikiPage): string[] {
  const sessions = new Set<string>();
  for (const s of page.frontmatter.sources) {
    const m = /^session:(.+)$/.exec(s.trim());
    if (m !== null) sessions.add(`session:${m[1]!.trim()}`);
  }
  for (const fact of factLines(page.body)) {
    // ONLY the parsed `(…)` provenance group counts. Free-scanning the line text let any prose
    // containing "session:" corroborate itself — a CI log URL like
    // `https://ci/logs/session:9f3a1b`, or a sentence mentioning another session — so a page
    // backed by exactly one session promoted itself to global. The model writes the page body,
    // so anything derived from the body's free text is something the model can talk its way past.
    for (const ref of fact.refs) {
      const m = /^session:([A-Za-z0-9._-]+)$/.exec(ref.trim());
      if (m !== null) sessions.add(`session:${m[1]!}`);
    }
  }
  return [...sessions].sort();
}

export interface PromotionSplit {
  promote: PromotionCandidate[];
  rejected: PromotionRejection[];
}

export function selectForPromotion(pages: WikiPage[], opts: PromotionOptions = {}): PromotionSplit {
  const minSessions = Math.max(2, opts.minSessions ?? 2);
  const minConfidence = opts.minConfidence ?? "medium";
  const promote: PromotionCandidate[] = [];
  const rejected: PromotionRejection[] = [];

  for (const page of pages) {
    const evidence = sessionEvidence(page);
    if (evidence.length < minSessions) {
      rejected.push({
        page: page.path,
        reason:
          evidence.length === 0
            ? "no session provenance at all"
            : `derived from ${evidence.length} session(s); global promotion needs ${minSessions}`,
        evidence,
      });
      continue;
    }
    if ((RANK[page.frontmatter.confidence] ?? 0) < (RANK[minConfidence] ?? 1)) {
      rejected.push({
        page: page.path,
        reason: `confidence "${page.frontmatter.confidence}" is below the "${minConfidence}" bar for promotion`,
        evidence,
      });
      continue;
    }
    promote.push({ from: page.path, toGlobal: page.path, evidence });
  }
  return { promote, rejected };
}
