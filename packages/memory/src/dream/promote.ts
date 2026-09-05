import type { WikiPage } from "../types.js";
import { factLines } from "../page.js";
import { witnessesForClaim, type PromotionEvidenceIndex, type PromotionWitness } from "./evidence.js";

/**
 * PLAN §3.4 and §7 both say it, so it is a hard gate rather than a prompt instruction:
 * **never promote anything derived from a single session.**
 *
 * The reason is that one session's conclusion is an observation, not a fact about the world. It
 * may be true only of that branch, that machine, that afternoon. Corroboration across two
 * independent sessions is the cheapest available proxy for "this generalizes", and it is the
 * difference between a global wiki that is worth consulting and one that accumulates noise.
 *
 * Citations only nominate sources. Runtime-loaded, claim-level witnesses establish structural
 * eligibility; semantic truth/generalization always remains a human-review judgment.
 */

export interface PromotionCandidate {
  from: string;
  toGlobal: string;
  evidence: string[];
  claims: ClaimPromotionAssessment[];
  requiresHumanReview: true;
  semanticAssessment: "not-assessed";
  advisoryConfidence: WikiPage["frontmatter"]["confidence"];
  /** Checked publication artifact; never send unvalidated extra citations from the input page. */
  publicationBody: string;
  publicationSources: string[];
}

export interface ClaimPromotionAssessment {
  claim: string;
  tag: "stated" | "observed" | "inferred";
  eligible: boolean;
  witnesses: PromotionWitness[];
  reason?: string;
}

export interface PromotionRejection {
  page: string;
  reason: string;
  evidence: string[];
  claims?: ClaimPromotionAssessment[];
}

export interface PromotionOptions {
  /** Distinct sessions required. PLAN's rule is "never from a single session", so ≥ 2. */
  minSessions?: number;
  /** Refuse to promote a page whose confidence the ingest marked low. */
  minConfidence?: "low" | "medium" | "high";
  /** Must come from loadPromotionEvidence; absent or fabricated indexes fail closed. */
  evidenceIndex?: PromotionEvidenceIndex;
}

const RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

/** Claimed session references for discovery/UI only. This is not proof of support. */
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

/** Combine repeated copies of the same tagged claim without conflating different claims. */
function claimsOf(page: WikiPage): Array<{ claim: string; tag: ClaimPromotionAssessment["tag"]; sessions: Set<string> }> {
  const claims = new Map<string, { claim: string; tag: ClaimPromotionAssessment["tag"]; sessions: Set<string> }>();
  for (const fact of factLines(page.body)) {
    let claim = fact.text;
    for (;;) {
      const stripped = claim.replace(/\s*\([^)]*(?:session|doc|dream|lore):[^)]*\)\s*$/, "").trim();
      if (stripped === claim) break;
      claim = stripped;
    }
    const key = `${fact.tag}\0${claim}`;
    const item = claims.get(key) ?? { claim, tag: fact.tag, sessions: new Set<string>() };
    for (const ref of fact.refs) {
      const match = /^session:([A-Za-z0-9_-]{1,128})$/.exec(ref);
      if (match !== null) item.sessions.add(match[1]!);
    }
    claims.set(key, item);
  }
  return [...claims.values()];
}

/** Maximum matching, not greedy selection: a family with two possible observations must not
 * accidentally consume the only observation available to a second independent family. */
function independentWitnesses(witnesses: PromotionWitness[]): PromotionWitness[] {
  const byFamily = new Map<string, PromotionWitness[]>();
  for (const witness of witnesses) byFamily.set(witness.family, [...(byFamily.get(witness.family) ?? []), witness]);
  const byObservation = new Map<string, PromotionWitness>();
  const assign = (family: string, visited: Set<string>): boolean => {
    for (const witness of byFamily.get(family) ?? []) {
      if (visited.has(witness.observationHash)) continue;
      visited.add(witness.observationHash);
      const prior = byObservation.get(witness.observationHash);
      if (prior === undefined || assign(prior.family, visited)) {
        byObservation.set(witness.observationHash, witness);
        return true;
      }
    }
    return false;
  };
  for (const family of [...byFamily.keys()].sort()) assign(family, new Set());
  return [...byObservation.values()].sort((a, b) => a.family.localeCompare(b.family));
}

export function selectForPromotion(pages: WikiPage[], opts: PromotionOptions = {}): PromotionSplit {
  if (opts.minSessions !== undefined && (!Number.isSafeInteger(opts.minSessions) || opts.minSessions < 0)) throw new Error("minSessions must be a non-negative integer");
  const minSessions = Math.max(2, opts.minSessions ?? 2);
  const minConfidence = opts.minConfidence ?? "medium";
  if (!Object.hasOwn(RANK, minConfidence)) throw new Error("invalid promotion confidence threshold");
  const promote: PromotionCandidate[] = [];
  const rejected: PromotionRejection[] = [];

  for (const page of pages) {
    const evidence = sessionEvidence(page);
    if (page.body.split("\n").some(line => line.trim() !== "" && !/^\s*-\s*\[(stated|observed|inferred)\]\s+\S/.test(line))) {
      rejected.push({ page: page.path, reason: "whole-page promotion contains prose without claim-level support; use cited fact lines", evidence });
      continue;
    }
    if (!Object.hasOwn(RANK, page.frontmatter.confidence) || (RANK[page.frontmatter.confidence] ?? 0) < (RANK[minConfidence] ?? 1)) {
      rejected.push({
        page: page.path,
        reason: `confidence "${page.frontmatter.confidence}" is below the "${minConfidence}" bar for promotion`,
        evidence,
      });
      continue;
    }
    const claims = claimsOf(page).map(({ claim, tag, sessions }): ClaimPromotionAssessment => {
      const witnesses: PromotionWitness[] = [];
      const errors: string[] = [];
      for (const id of [...sessions].sort()) {
        const checked = witnessesForClaim(opts.evidenceIndex, id, claim);
        witnesses.push(...checked.witnesses);
        if (checked.error !== undefined) errors.push(`session:${id}: ${checked.error}`);
      }
      const independent = independentWitnesses(witnesses);
      const eligible = claim !== "" && independent.length >= minSessions;
      return { claim, tag, eligible, witnesses: independent.slice(0, minSessions),
        ...(eligible ? {} : { reason: `${independent.length} independent runtime-supported observation(s); need ${minSessions}` +
          (errors.length === 0 ? "" : ` (${errors.join("; ")})`) }) };
    });
    if (claims.length === 0 || claims.some(claim => !claim.eligible)) {
      rejected.push({ page: page.path, evidence, claims, reason: claims.length === 0 ? "no tagged claims to validate" : "not every claim has independent runtime-backed support" });
      continue;
    }
    promote.push({ from: page.path, toGlobal: page.path,
      evidence: [...new Set(claims.flatMap(claim => claim.witnesses.map(w => w.citation)))].sort(),
      claims, requiresHumanReview: true, semanticAssessment: "not-assessed", advisoryConfidence: page.frontmatter.confidence,
      publicationBody: claims.map(claim => `- [${claim.tag}] ${claim.claim} (${[...new Set(claim.witnesses.map(w => `session:${w.sessionId}`))].sort().join(", ")})`).join("\n"),
      publicationSources: [...new Set(claims.flatMap(claim => claim.witnesses.map(w => `session:${w.sessionId}`)))].sort() });
  }
  return { promote, rejected };
}
