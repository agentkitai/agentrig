import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { PAGE_DIR, pagePath, parsePage, serializePage } from "./page.js";
import { bm25Search } from "./search.js";
import type { IndexEntry, MemoryStore, PageType, Scope, WikiPage } from "./types.js";

/**
 * File-backed LLM Wiki (PLAN §3.1). The wiki is plain markdown on disk: the agent writes it,
 * a human reads and edits it, git diffs it. Nothing here is a database.
 *
 * `index.md` is the catalog read first on every query, and it doubles as the reservation
 * ledger: a page is claimed with an atomic O_EXCL placeholder so two concurrent ingests
 * converge on one page instead of forking near-duplicate slugs.
 */

const INDEX_FILE = "index.md";
const LOG_FILE = "log.md";
export const OVERVIEW_FILE = "overview.md";
const INDEX_HEADER = `# Index

Every page in this wiki, one line each. Read this first; open only what you need.

| slug | path | type | status | summary |
| --- | --- | --- | --- | --- |`;

export interface FileMemoryStoreOptions {
  root: string;
  scope?: Scope;
  now?: () => number;
}

function serializeEntry(e: IndexEntry): string {
  const claimed = e.claimedBy === undefined || e.claimedBy.length === 0 ? "" : ` (claimed: ${e.claimedBy.join(", ")})`;
  const summary = e.summary.replace(/\|/g, "\\|").replace(/\n/g, " ");
  return `| ${e.slug} | ${e.path} | ${e.type} | ${e.status}${claimed} | ${summary} |`;
}

function parseEntry(line: string): IndexEntry | null {
  if (!line.trim().startsWith("|")) return null;
  // split on unescaped pipes only, so a summary containing "a | b" survives the round trip
  const cells = line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
  if (cells.length < 5) return null;
  const [slug, path, type, statusCell, ...rest] = cells;
  if (slug === undefined || slug === "slug" || slug.startsWith("---")) return null;
  if (path === undefined || type === undefined || statusCell === undefined) return null;
  const claimMatch = /\(claimed:\s*([^)]*)\)/.exec(statusCell);
  const entry: IndexEntry = {
    slug,
    path,
    type: type as PageType,
    status: statusCell.startsWith("planned") ? "planned" : "active",
    summary: rest.join("|").replace(/\\\|/g, "|"),
  };
  if (claimMatch !== null) {
    entry.claimedBy = claimMatch[1]!.split(",").map((s) => s.trim()).filter((s) => s !== "");
  }
  return entry;
}

export class FileMemoryStore implements MemoryStore {
  readonly root: string;
  readonly scope: Scope;
  private readonly now: () => number;

  constructor(opts: FileMemoryStoreOptions) {
    this.root = opts.root;
    this.scope = opts.scope ?? "project";
    this.now = opts.now ?? (() => Date.now());
  }

  private abs(rel: string): string {
    return join(this.root, rel);
  }

  private today(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  /** Create the wiki skeleton if absent. Idempotent; never overwrites existing content. */
  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    for (const dir of Object.values(PAGE_DIR)) await mkdir(this.abs(dir), { recursive: true });
    await this.ensure(INDEX_FILE, `${INDEX_HEADER}\n`);
    await this.ensure(LOG_FILE, "# Log\n\nAppend-only chronology of ingests, dreams, and corrections.\n");
    await this.ensure(
      OVERVIEW_FILE,
      serializePage(
        { type: "concept", slug: "overview", aliases: [], sources: [], updated: this.today(), confidence: "low" },
        "- [inferred] Nothing ingested yet; this page is the project synthesis and fills in as sessions land.",
      ),
    );
  }

  private async ensure(rel: string, contents: string): Promise<void> {
    try {
      const handle = await open(this.abs(rel), "wx");
      try {
        await handle.writeFile(contents, "utf8");
      } finally {
        await handle.close();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }

  async index(): Promise<IndexEntry[]> {
    let text: string;
    try {
      text = await readFile(this.abs(INDEX_FILE), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return text.split("\n").map(parseEntry).filter((e): e is IndexEntry => e !== null);
  }

  async writeIndex(entries: IndexEntry[]): Promise<void> {
    const sorted = [...entries].sort((a, b) =>
      a.type === b.type ? a.slug.localeCompare(b.slug) : a.type.localeCompare(b.type),
    );
    await this.atomicWrite(INDEX_FILE, `${INDEX_HEADER}\n${sorted.map(serializeEntry).join("\n")}\n`);
  }

  /** Insert or replace one index row, preserving everything else. */
  async upsertIndex(entry: IndexEntry): Promise<void> {
    const entries = await this.index();
    const i = entries.findIndex((e) => e.slug === entry.slug && e.type === entry.type);
    if (i === -1) entries.push(entry);
    else entries[i] = entry;
    await this.writeIndex(entries);
  }

  async read(path: string): Promise<WikiPage | null> {
    const full = this.abs(path);
    let text: string;
    let mtime: number;
    try {
      text = await readFile(full, "utf8");
      mtime = (await stat(full)).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const { frontmatter, body } = parsePage(text, path);
    return { path, frontmatter, body, updatedAt: mtime };
  }

  async write(path: string, page: Omit<WikiPage, "updatedAt">): Promise<void> {
    await this.atomicWrite(path, serializePage(page.frontmatter, page.body));
  }

  /**
   * Claim a slug by creating its page with O_EXCL. `exists` means another ingest got there
   * first and this one should update that page rather than fork a near-duplicate slug.
   * The LLM call that fills the page happens outside this — the lock is only the placeholder.
   */
  async reserve(slug: string, claimant: string, type: PageType = "entity"): Promise<"created" | "exists"> {
    const rel = pagePath(type, slug);
    const full = this.abs(rel);
    await mkdir(dirname(full), { recursive: true });
    const placeholder = serializePage(
      { type, slug, aliases: [], sources: [], updated: this.today(), confidence: "low" },
      `- [inferred] Reserved by ${claimant}; content pending ingest.`,
    );
    try {
      const handle = await open(full, "wx");
      try {
        await handle.writeFile(placeholder, "utf8");
      } finally {
        await handle.close();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        const existing = (await this.index()).find((e) => e.slug === slug && e.type === type);
        if (existing !== undefined) {
          await this.upsertIndex({
            ...existing,
            claimedBy: [...new Set([...(existing.claimedBy ?? []), claimant])],
          });
        }
        return "exists";
      }
      throw err;
    }
    await this.upsertIndex({
      slug,
      path: rel,
      type,
      status: "planned",
      summary: `(reserved by ${claimant})`,
      claimedBy: [claimant],
    });
    return "created";
  }

  async appendLog(entry: string): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await appendFile(this.abs(LOG_FILE), entry.endsWith("\n") ? entry : `${entry}\n`, "utf8");
  }

  /** Every page on disk, for search and lint. */
  async pages(): Promise<WikiPage[]> {
    const out: WikiPage[] = [];
    for (const dir of Object.values(PAGE_DIR)) {
      let names: string[];
      try {
        names = await readdir(this.abs(dir));
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".md")) continue;
        const page = await this.read(join(dir, name)).catch(() => null);
        if (page !== null) out.push(page);
      }
    }
    const overview = await this.read(OVERVIEW_FILE).catch(() => null);
    if (overview !== null) out.push(overview);
    return out;
  }

  async search(query: string, k = 8): Promise<Array<{ page: WikiPage; score: number; snippet: string }>> {
    return bm25Search(await this.pages(), query, k);
  }

  private async atomicWrite(rel: string, contents: string): Promise<void> {
    const full = this.abs(rel);
    await mkdir(dirname(full), { recursive: true });
    const tmp = `${full}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, contents, "utf8");
      await rename(tmp, full);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }
}
