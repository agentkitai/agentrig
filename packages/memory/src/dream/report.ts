import type { DreamReport } from "../types.js";
import type { StructuralFindings } from "./lint.js";
import { proposedPath } from "./lint.js";
import type { PromotionRejection } from "./promote.js";

/**
 * Renders the change report a human reads in `review` mode. PLAN §3.7 is specific that review
 * means "review the artifact, not the plan", so this describes what the dreamt wiki *already
 * says* — it is a description of a directory that exists, not a proposal.
 */
export interface RenderOptions {
  structural?: StructuralFindings;
  promotionRejected?: PromotionRejection[];
  outputRoot?: string;
  applied?: boolean;
}

function section(title: string, lines: string[]): string[] {
  return lines.length === 0 ? [] : ["", `## ${title} (${lines.length})`, ...lines];
}

export function renderPromotionProposal(proposal: DreamReport["promoted"][number]): string {
  const lines = [`- ${proposal.from} → global (proposal; human review required; semantic truth not assessed)`];
  if (proposal.advisoryConfidence !== undefined) lines.push(`  page confidence (advisory, not evidence): ${proposal.advisoryConfidence}`);
  if (proposal.claims === undefined) lines.push("  No runtime witness metadata in this legacy proposal.");
  for (const claim of proposal.claims ?? []) {
    lines.push(`  claim [${claim.tag}]: ${JSON.stringify(claim.claim)}`);
    for (const witness of claim.witnesses) {
      lines.push(`  ${witness.citation} → session:${witness.sessionId} event=${witness.seq} ${witness.field}[${witness.from},${witness.to}) family=${witness.family} eventHash=${witness.eventHash}`);
      lines.push(`    excerpt: ${JSON.stringify(witness.excerpt.slice(0, 1000))}${witness.excerpt.length > 1000 ? " (display abbreviated; full range above)" : ""}`);
    }
  }
  if (proposal.publicationBody !== undefined) lines.push("  Publication contains only the checked claim lines and supporting session references; extra citations are omitted.");
  return lines.join("\n");
}

export function renderReport(report: DreamReport, opts: RenderOptions = {}): string {
  const out: string[] = ["# Dream report"];
  if (opts.outputRoot !== undefined) {
    out.push(
      "",
      opts.applied === true
        ? `Applied. The dreamt wiki is now live; the previous one was kept beside it.`
        : `Not applied. The dreamt wiki is at ${opts.outputRoot} — your wiki is untouched.`,
    );
  }

  out.push(
    ...section(
      "Contradictions",
      report.contradictions.map(
        (c) => `- ${c.pages.join(" ↔ ")}\n  claims: ${c.claims.join(" | ")}\n  resolution: ${c.resolution}`,
      ),
    ),
    ...section(
      "Superseded claims",
      report.superseded.map((s) => `- ${s.page}\n  was: ${s.old}\n  now: ${s.new}\n  per: ${s.source}`),
    ),
    ...section(
      "Merged pages",
      report.merged.map((m) => `- ${m.from.join(" + ")} → ${m.to}`),
    ),
    ...section(
      "Removed lines",
      report.removed.map((r) => `- ${r.page}: "${r.line}" (${r.reason})`),
    ),
    ...section(
      "Orphans (nothing links here, and the index does not list it)",
      report.orphans.map((o) => `- ${o}`),
    ),
    ...section(
      "Mentioned but missing",
      report.missingPages.map((m) => `- [[${m.concept}]] → ${proposedPath(m.concept)}  (from ${m.mentionedIn.join(", ")})`),
    ),
    ...section(
      "Promotion proposals",
      report.promoted.map(renderPromotionProposal),
    ),
    ...section(
      "Pins",
      report.pinsAffected.filter((p) => p.status !== "kept").map((p) => `- [${p.status}] ${p.pin}`),
    ),
  );

  const s = opts.structural;
  if (s !== undefined) {
    out.push(
      ...section("Index drift", [
        ...s.indexDrift.danglingRows.map((r) => `- row points at a page that is gone: ${r}`),
        ...s.indexDrift.unlisted.map((r) => `- page is not in the index: ${r}`),
      ]),
      ...section("Stale file references", s.staleFileRefs.map((r) => `- ${r.page} → ${r.ref} (no longer exists)`)),
      ...section(
        "Relative dates (will read wrong later)",
        s.relativeDates.map((r) => `- ${r.page}: "${r.phrase}" in "${r.line}"`),
      ),
      ...section("Reserved but never filled", s.unfilled.map((u) => `- ${u}`)),
      ...section("Facts with no source", s.unsourced.map((u) => `- ${u.page}: ${u.line}`)),
    );
  }

  const rejected = opts.promotionRejected ?? [];
  if (rejected.length > 0) {
    out.push(
      ...section(
        "Not promoted",
        rejected.map((r) => `- ${r.page}: ${r.reason}` + (r.claims ?? []).filter(claim => !claim.eligible)
          .map(claim => `\n  ${JSON.stringify(claim.claim)}: ${claim.reason}`).join("")),
      ),
    );
  }

  if (out.length === 1) out.push("", "Nothing to report — the wiki is clean.");
  return `${out.join("\n")}\n`;
}

/** Total findings, so a caller can decide an exit code without re-walking the report. */
export function findingCount(report: DreamReport, structural?: StructuralFindings): number {
  const base =
    report.contradictions.length +
    report.superseded.length +
    report.merged.length +
    report.removed.length +
    report.orphans.length +
    report.missingPages.length +
    report.pinsAffected.filter((p) => p.status !== "kept").length;
  if (structural === undefined) return base;
  return (
    base +
    structural.indexDrift.danglingRows.length +
    structural.indexDrift.unlisted.length +
    structural.staleFileRefs.length +
    structural.relativeDates.length +
    structural.unfilled.length +
    structural.unsourced.length
  );
}
