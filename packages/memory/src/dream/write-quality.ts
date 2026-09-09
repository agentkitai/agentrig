import type { WikiPage } from "../types.js";
import { factBlocks, factLines, isReservationPlaceholder } from "../page.js";

export interface WriteQualityFinding {
  kind: "missing-provenance" | "inference-as-fact" | "status-noise" | "restated-claim" | "thin-generalization" | "subject-routing";
  page: string;
  line: string;
  reason: string;
  relatedPage?: string;
}

/** Remove only citation groups, not arbitrary parenthesized content or code. */
function claimText(text: string): string {
  return text.replace(/`[^`\n]*`|"[^"\n]*"|\(\s*(?:session|doc|dream|lore):[^)]*\)/g,
    match => match.startsWith("`") || match.startsWith('"') ? match : "").trim();
}
const proseOnly = (text: string) => text.replace(/`[^`\n]*`|"[^"\n]*"/g, " ");
const CALIBRATED = /\b(may|might|could|likely|possibly|possible|perhaps|suggests?|appears?|seems?|hypothesis|inferred|model synthesis)\b/i;
const UNIVERSAL = /\b(always|never|every|all cases|guarantees?|cannot fail|proves?)\b/i;
const STATUS = /\b(?:(?:tests?|ci|build) (?:is |are |has |have )?(?:passed|passing|green|failed|failing)|(?:pr|pull request) #?\d+ (?:is |was )?(?:merged|open|closed)|current (?:branch|version|commit)|\d+ tests? (?:passed|failed))\b/i;

/** Advisory text-shape checks, not semantic verification or promotion evidence. No mutation.
 * Existing dream scan limits bound input; cancellation is checked between pages and facts.
 * Routing requires an explicit leading subject link with one unambiguous existing target.
 * Source pages are historical narrative, so status and cross-page repetition are intentional. */
export function writeQualityLint(pages: WikiPage[], signal?: AbortSignal): WriteQualityFinding[] {
  signal?.throwIfAborted();
  const findings: WriteQualityFinding[] = [];
  const names = new Map<string, Set<string>>();
  for (const page of pages) {
    signal?.throwIfAborted();
    for (const name of [page.path, page.path.replace(/\.md$/, ""), page.frontmatter.slug, ...page.frontmatter.aliases]) {
      const key = name.trim().toLowerCase();
      if (key !== "") names.set(key, (names.get(key) ?? new Set()).add(page.path));
    }
  }
  const seen = new Map<string, string>();
  // Stable page order makes duplicate ownership and reports independent of directory enumeration.
  for (const page of [...pages].sort((a, b) => a.path.localeCompare(b.path))) {
    signal?.throwIfAborted();
    let fence: string | undefined;
    const legacyObservations = new Set(factLines(page.body).filter(f => f.tag === "observed").map(f => f.text));
    for (const block of factBlocks(page.body)) {
      signal?.throwIfAborted();
      const marker = /^\s*(`{3,}|~{3,})/.exec(block.raw)?.[1];
      if (marker !== undefined) {
        if (fence === undefined) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
        continue;
      }
      if (fence !== undefined || isReservationPlaceholder(block.raw)) continue;
      const add = (kind: WriteQualityFinding["kind"], reason: string, relatedPage?: string) => findings.push({
        kind, page: page.path, line: block.raw.slice(0, 240), reason,
        ...(relatedPage === undefined ? {} : { relatedPage }),
      });
      if (!block.fact) {
        // Indented handwritten bullets are supporting structure, not independent claim candidates.
        if (/^[-+*]\s+\S/.test(block.raw)) add("missing-provenance", "Possible claim bullet has no stated/observed/inferred tag; inspect before assigning provenance.");
        continue;
      }
      const fact = factLines(block.raw)[0];
      if (fact === undefined) continue;
      if (page.frontmatter.type === "source" && fact.tag === "inferred" && fact.text.startsWith("Model synthesis: ")
        && legacyObservations.has(fact.text.slice("Model synthesis: ".length))) {
        add("restated-claim", "Model synthesis repeats a legacy observed source line with the same references; inspect regrowth duplication. Original text and provenance remain unchanged.");
      }
      const text = claimText(fact.text);
      const prose = proseOnly(text);
      if (fact.tag === "inferred" && !CALIBRATED.test(prose)) {
        add("inference-as-fact", "Inferred claim lacks an explicit uncertainty or synthesis cue in its prose; review calibration, not just its tag.");
      }
      if (page.frontmatter.type !== "source" && STATUS.test(prose)) {
        add("status-noise", "Possible per-session status belongs in source history; keep a durable contract/reason only if it remains useful a month out.");
      }
      const sessions = new Set(fact.refs.filter(ref => /^session:[^\s]+$/.test(ref)));
      if (fact.tag === "observed" && sessions.size <= 1 && UNIVERSAL.test(prose)) {
        add("thin-generalization", "Universal wording has at most one cited session on this claim. Scope the observation; even multiple citations would not prove independence or truth.");
      }
      if (page.frontmatter.type !== "source" && text !== "") {
        const prior = seen.get(text);
        if (prior !== undefined) add("restated-claim", "The same claim text is already filed (ignoring citation groups). Inspect new evidence without treating repetition as a new fact.", prior);
        else seen.set(text, page.path);
        const subject = /^\[\[([^\]]+)\]\]/.exec(text)?.[1]?.trim().toLowerCase();
        const matches = subject === undefined ? undefined : names.get(subject);
        if (matches?.size === 1 && !matches.has(page.path)) {
          add("subject-routing", "The explicit leading subject link names another existing page; review whether this fact belongs there. No automatic move.", [...matches][0]!);
        }
      }
    }
  }
  return findings;
}
