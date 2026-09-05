import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { FileMemoryStore } from "../store.js";
import type { WikiPage } from "../types.js";
import type { Consolidation } from "./phases.js";
import type { StructuralFindings } from "./lint.js";
import type { ScanOptions } from "../scan.js";
import { withMemoryLock, type MemoryLockOptions } from "../lock.js";
import { serializePage } from "../page.js";
import { MaintenanceLimitError } from "../maintenance.js";
import { DEFAULT_SCAN_LIMITS } from "../scan.js";

/**
 * Actually edits the dreamt wiki. Without this the dream is a liar: it would report merges and
 * removals, hand you a "corrected" directory identical to the input, and — under `--auto` — tell
 * you the corrections were live. PLAN §3.7 says review means "review the artifact, not the plan",
 * which only means anything if the artifact differs from the input.
 *
 * Everything here is conservative in one direction: **losing a true fact is worse than keeping a
 * redundant one.** Merges append rather than interleave, removals must match a line exactly, and
 * anything that does not match is left alone and reported rather than guessed at.
 */

export interface AppliedChanges {
  /** Lines actually deleted, page by page. */
  removedLines: Array<{ page: string; line: string }>;
  /** Findings that named something the page did not contain — reported, not silently dropped. */
  unmatchedRemovals: Array<{ page: string; line: string }>;
  mergedPages: Array<{ from: string; into: string }>;
  rewrittenDates: Array<{ page: string; from: string; to: string }>;
  supersededMarked: Array<{ page: string; old: string }>;
}

const empty = (): AppliedChanges => ({
  removedLines: [],
  unmatchedRemovals: [],
  mergedPages: [],
  rewrittenDates: [],
  supersededMarked: [],
});

/** Compares two lines ignoring leading/trailing space and internal whitespace runs. */
function sameLine(a: string, b: string): boolean {
  const norm = (s: string): string => s.trim().replace(/\s+/g, " ");
  return norm(a) === norm(b);
}

/** A model quoting a fact often drops the `- [stated] ` prefix; match on the content too. */
function matchesRemoval(line: string, target: string): boolean {
  if (sameLine(line, target)) return true;
  const strip = (s: string): string => s.replace(/^\s*-\s*\[(stated|observed|inferred)\]\s*/, "");
  const l = strip(line);
  return l !== "" && sameLine(l, strip(target));
}

export interface ApplyOptions extends ScanOptions, MemoryLockOptions {
  /** ISO date the dream ran, used when rewriting relative dates. */
  today: string;
  /** Ranges over the structural findings too (relative dates). */
  structural?: StructuralFindings;
}

/**
 * Applies a consolidation to the output store. Returns what actually changed, which is what the
 * report should describe — a finding the pages did not support must not be reported as done.
 */
export async function applyConsolidation(
  out: FileMemoryStore,
  consolidation: Consolidation,
  opts: ApplyOptions,
): Promise<AppliedChanges> {
  const changes = empty();
  const pages = new Map<string, WikiPage>();
  for (const p of await out.pages(opts)) pages.set(p.path, p);
  // only pages that actually changed are rewritten: an untouched page must come out of a dream
  // byte-identical, or every dream would churn `updated` on the whole wiki
  const dirty = new Set<string>();

  // ---- removals: exact-ish line matches only
  const removalsByPage = new Map<string, string[]>();
  for (const r of consolidation.removed) {
    removalsByPage.set(r.page, [...(removalsByPage.get(r.page) ?? []), r.line]);
  }
  for (const [path, targets] of removalsByPage) {
    opts.signal?.throwIfAborted();
    const page = pages.get(path);
    if (page === undefined) continue;
    const kept: string[] = [];
    const remaining = [...targets];
    for (const line of page.body.split("\n")) {
      const hit = remaining.findIndex((t) => matchesRemoval(line, t));
      if (hit === -1) {
        kept.push(line);
        continue;
      }
      remaining.splice(hit, 1);
      changes.removedLines.push({ page: path, line: line.trim() });
    }
    for (const missed of remaining) changes.unmatchedRemovals.push({ page: path, line: missed });
    if (changes.removedLines.some((r) => r.page === path)) {
      page.body = kept.join("\n");
      pages.set(path, page);
      dirty.add(path);
    }
  }

  // ---- superseded: annotate rather than delete. A claim a newer source replaced is still
  // evidence of what was believed, and the wiki's own format has a tag for exactly this.
  for (const s of consolidation.superseded) {
    opts.signal?.throwIfAborted();
    const page = pages.get(s.page);
    if (page === undefined) continue;
    const lines = page.body.split("\n");
    let touched = false;
    for (let i = 0; i < lines.length; i += 1) {
      if (!matchesRemoval(lines[i]!, s.old)) continue;
      lines[i] = `${lines[i]!.replace(/\s*$/, "")} — superseded by "${s.new}" (${s.source})`;
      touched = true;
      break;
    }
    if (touched) {
      page.body = lines.join("\n");
      pages.set(s.page, page);
      dirty.add(s.page);
      changes.supersededMarked.push({ page: s.page, old: s.old });
    }
  }

  // ---- relative dates → absolute (PLAN §3.2). Rewriting in place would guess at what
  // "yesterday" meant; annotating preserves the text and makes it unambiguous from here on.
  for (const rd of opts.structural?.relativeDates ?? []) {
    opts.signal?.throwIfAborted();
    const page = pages.get(rd.page);
    if (page === undefined) continue;
    const marker = `[relative date "${rd.phrase}"`;
    if (page.body.includes(marker)) continue;
    const lines = page.body.split("\n");
    let touched = false;
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i]!.includes(rd.phrase) || lines[i]!.includes(marker)) continue;
      lines[i] = `${lines[i]!.replace(/\s*$/, "")} ${marker}, as of ${opts.today}]`;
      touched = true;
      break;
    }
    if (touched) {
      page.body = lines.join("\n");
      pages.set(rd.page, page);
      dirty.add(rd.page);
      changes.rewrittenDates.push({ page: rd.page, from: rd.phrase, to: opts.today });
    }
  }

  // ---- merges last, so a merged-away page carries the edits above with it
  for (const m of consolidation.merged) {
    opts.signal?.throwIfAborted();
    const target = pages.get(m.to);
    if (target === undefined) continue;
    const sources = m.from.filter((f) => f !== m.to && pages.has(f));
    if (sources.length === 0) continue;

    for (const from of sources) {
      opts.signal?.throwIfAborted();
      const src = pages.get(from)!;
      if (Buffer.byteLength(target.body) + Buffer.byteLength(src.body) + Buffer.byteLength(from) + 32
        > (opts.scanLimits?.maxFileBytes ?? DEFAULT_SCAN_LIMITS.maxFileBytes)) throw new MaintenanceLimitError("dream merged page output limit exceeded");
      // append rather than interleave: the merge is a model's judgement, and a wrong ordering
      // that keeps every fact is recoverable where a wrong interleaving is not
      target.body = `${target.body.replace(/\s*$/, "")}\n\n<!-- merged from ${from} -->\n${src.body.trim()}\n`;
      target.frontmatter.sources = [...new Set([...target.frontmatter.sources, ...src.frontmatter.sources])];
      target.frontmatter.aliases = [
        ...new Set([...target.frontmatter.aliases, src.frontmatter.slug, ...src.frontmatter.aliases]),
      ];
      pages.delete(from);
      dirty.delete(from);
      await withMemoryLock(out.root, async () => { opts.signal?.throwIfAborted(); await rm(join(out.root, from), { force: true }); }, opts);
      changes.mergedPages.push({ from, into: m.to });
    }
    pages.set(m.to, target);
    dirty.add(m.to);
  }

  for (const path of dirty) {
    opts.signal?.throwIfAborted();
    const page = pages.get(path);
    if (page === undefined) continue;
    if (Buffer.byteLength(serializePage(page.frontmatter, page.body)) > (opts.scanLimits?.maxFileBytes ?? DEFAULT_SCAN_LIMITS.maxFileBytes)) {
      throw new MaintenanceLimitError("dream page output limit exceeded");
    }
    await out.write(path, { path, frontmatter: page.frontmatter, body: page.body }, opts);
  }
  return changes;
}
