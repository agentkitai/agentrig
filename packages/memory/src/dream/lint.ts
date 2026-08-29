import { access } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { IndexEntry, WikiPage } from "../types.js";
import { factLines, pagePath, wikilinks } from "../page.js";

/**
 * The structural half of the dream (PLAN §3.4's lint list). Everything here is derivable from
 * the wiki's own text, so it runs with **no model call at all** — which is what makes
 * `agentrig memory lint` free to run on every session end and makes the dream's expensive
 * phases (contradictions, merges) the only ones that cost tokens.
 *
 * Judgment stays out of here on purpose: "these two pages contradict each other" needs a model,
 * "this page links to a page that does not exist" does not.
 */

export interface StructuralFindings {
  /** Pages nothing links to and the index does not list — reachable only by search. */
  orphans: string[];
  /** `[[links]]` with no page behind them: the concept is mentioned but has no page. */
  missingPages: Array<{ concept: string; mentionedIn: string[] }>;
  /** Index rows whose page is gone, and pages the index never lists. */
  indexDrift: { danglingRows: string[]; unlisted: string[] };
  /** Fact lines citing a file that no longer exists on disk. */
  staleFileRefs: Array<{ page: string; ref: string }>;
  /** Relative dates ("yesterday", "last week") that will read wrong later. */
  relativeDates: Array<{ page: string; line: string; phrase: string }>;
  /** Pages reserved as placeholders and never filled in. */
  unfilled: string[];
  /** Fact lines with no `(source:...)` — unattributable, so unverifiable. */
  unsourced: Array<{ page: string; line: string }>;
}

/** Wikilink → the page path it should resolve to, matching `pagePath`'s layout. */
export function resolveLink(link: string, pages: WikiPage[]): WikiPage | undefined {
  const target = link.trim().toLowerCase();
  return pages.find((p) => {
    if (p.frontmatter.slug.toLowerCase() === target) return true;
    if (p.path.toLowerCase() === target) return true;
    if (p.path.toLowerCase() === `${target}.md`) return true;
    return p.frontmatter.aliases.some((a) => a.toLowerCase() === target);
  });
}

const RELATIVE_DATE =
  /\b(yesterday|today|tomorrow|last (?:week|month|year|night)|next (?:week|month|year)|this (?:morning|afternoon|week|month)|recently|just now|a few (?:days|weeks|months) ago|(?:\d+) (?:days?|weeks?|months?) ago)\b/gi;

/** `(file:path)` / backticked paths that look like repo files, for existence checking. */
const FILE_REF = /(?:^|[\s(`])((?:\.\/|packages\/|src\/|docs\/|test\/)[\w./-]+\.\w{1,6})/g;

export interface StructuralOptions {
  /** Root the file refs are relative to. Omit to skip the file-existence check entirely. */
  cwd?: string;
}

export async function structuralLint(
  pages: WikiPage[],
  index: IndexEntry[],
  opts: StructuralOptions = {},
): Promise<StructuralFindings> {
  const byPath = new Map(pages.map((p) => [p.path, p]));
  const linkedTo = new Set<string>();
  const missing = new Map<string, string[]>();
  const staleFileRefs: StructuralFindings["staleFileRefs"] = [];
  const relativeDates: StructuralFindings["relativeDates"] = [];
  const unsourced: StructuralFindings["unsourced"] = [];

  for (const page of pages) {
    for (const link of wikilinks(page.body)) {
      const target = resolveLink(link, pages);
      if (target === undefined) {
        missing.set(link, [...(missing.get(link) ?? []), page.path]);
      } else if (target.path !== page.path) {
        // a page linking to itself does not make itself non-orphaned
        linkedTo.add(target.path);
      }
    }

    for (const fact of factLines(page.body)) {
      // `human` stands alone (a pinned correction has no id to cite); the rest carry an id
      if (!/\(\s*(?:(?:session|doc|dream|lore)\s*:|human\b)/.test(fact.text)) {
        unsourced.push({ page: page.path, line: fact.text.slice(0, 160) });
      }
    }

    for (const line of page.body.split("\n")) {
      for (const m of line.matchAll(RELATIVE_DATE)) {
        relativeDates.push({ page: page.path, line: line.trim().slice(0, 160), phrase: m[0] });
      }
    }

    if (opts.cwd !== undefined) {
      const seen = new Set<string>();
      for (const m of page.body.matchAll(FILE_REF)) {
        const ref = m[1]!;
        if (seen.has(ref)) continue;
        seen.add(ref);
        // confine to the given root: a wiki must not be able to probe outside it
        const abs = resolve(opts.cwd, ref);
        if (!abs.startsWith(resolve(opts.cwd))) continue;
        if (isAbsolute(ref)) continue;
        const exists = await access(abs).then(
          () => true,
          () => false,
        );
        if (!exists) staleFileRefs.push({ page: page.path, ref });
      }
    }
  }

  const indexPaths = new Set(index.map((e) => e.path));
  const orphans = pages
    .filter((p) => !linkedTo.has(p.path) && !indexPaths.has(p.path))
    .map((p) => p.path)
    .sort();

  return {
    orphans,
    missingPages: [...missing.entries()]
      .map(([concept, mentionedIn]) => ({ concept, mentionedIn: [...new Set(mentionedIn)] }))
      .sort((a, b) => a.concept.localeCompare(b.concept)),
    indexDrift: {
      danglingRows: index.filter((e) => !byPath.has(e.path)).map((e) => e.path).sort(),
      unlisted: pages.filter((p) => !indexPaths.has(p.path)).map((p) => p.path).sort(),
    },
    staleFileRefs,
    relativeDates,
    unfilled: index.filter((e) => e.status === "planned").map((e) => e.path).sort(),
    unsourced,
  };
}

/** True when nothing structural needs attention — lets `lint` exit 0 meaningfully. */
export function isClean(f: StructuralFindings): boolean {
  return (
    f.orphans.length === 0 &&
    f.missingPages.length === 0 &&
    f.indexDrift.danglingRows.length === 0 &&
    f.indexDrift.unlisted.length === 0 &&
    f.staleFileRefs.length === 0 &&
    f.relativeDates.length === 0 &&
    f.unfilled.length === 0 &&
    f.unsourced.length === 0
  );
}

/** The path a missing concept's page would take, so the report can propose a concrete file. */
export function proposedPath(concept: string): string {
  const slug = concept
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return pagePath("concept", slug === "" ? "unnamed" : slug);
}
