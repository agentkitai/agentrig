import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { PAGE_DIR, pagePath, parsePage, reservationPlaceholder, serializePage } from "./page.js";
import { bm25Search } from "./search.js";
import { withMemoryLock, type MemoryLockOptions } from "./lock.js";
import { readBoundedFile } from "./bounded-file.js";
import { MaintenanceLimitError } from "./maintenance.js";
import { ScanBudget, type ScanOptions } from "./scan.js";
import type { IndexEntry, MemoryStore, PageType, Scope, WikiPage } from "./types.js";

/**
 * File-backed LLM Wiki (PLAN §3.1). The wiki is plain markdown on disk: the agent writes it,
 * a human reads and edits it, git diffs it. Nothing here is a database.
 *
 * `index.md` is the catalog read first on every query, and it doubles as the reservation
 * ledger: a page is claimed with an atomic O_EXCL placeholder so two concurrent ingests
 * converge on one page instead of forking near-duplicate slugs.
 */

export const INDEX_FILE = "index.md";
export const LOG_FILE = "log.md";
const LOG_HEADER = "# Log\n\nAppend-only chronology of ingests, dreams, and corrections.\n";
/** Recover known initialization fragments; keep every non-header line, including custom notes. */
function recoverLogHeader(text: string): string {
  if (text.startsWith(LOG_HEADER)) return text;
  if (LOG_HEADER.startsWith(text)) return LOG_HEADER;
  let rest = text;
  if (rest.startsWith("# Log\n")) {
    rest = rest.slice("# Log\n".length).replace(/^\n/, "");
    const end = rest.indexOf("\n");
    const first = end === -1 ? rest : rest.slice(0, end);
    if (first !== "" && "Append-only chronology of ingests, dreams, and corrections.".startsWith(first)) {
      rest = end === -1 ? "" : rest.slice(end + 1);
    }
  }
  return LOG_HEADER + rest;
}
export const OVERVIEW_FILE = "overview.md";
const INDEX_HEADER = `# Index

Every page in this wiki, one line each. Read this first; open only what you need.

| slug | path | type | status | summary |
| --- | --- | --- | --- | --- |`;

export interface FileMemoryStoreOptions {
  root: string;
  scope?: Scope;
  now?: () => number;
  lockTimeoutMs?: number;
}

export type PageWrite = Omit<WikiPage, "updatedAt" | "version">;
export type MemoryWriteResult = ({ ok: true; version: string } | { ok: false; current: WikiPage | null }) & { warnings: string[] };
const versionOf = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex").slice(0, 32);

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
    // Older Windows dreams persisted native separators; normalize the identifier on read.
    path: path.includes("/") ? path : path.replace(/\\/g, "/"),
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
  private readonly lockTimeoutMs: number;

  constructor(opts: FileMemoryStoreOptions) {
    this.root = opts.root;
    this.scope = opts.scope ?? "project";
    this.now = opts.now ?? (() => Date.now());
    this.lockTimeoutMs = opts.lockTimeoutMs ?? 5000;
  }

  /**
   * index.md is a read-modify-write, so concurrent ingests would otherwise lose each other's
   * catalog rows outright — pages on disk with no index row are invisible to index-first
   * retrieval forever. Mutations run one at a time in this process and hold an O_EXCL lock
   * file across processes.
   */
  private async withMutationLock<T>(fn: () => Promise<T>, opts: MemoryLockOptions = {}): Promise<T> {
    return withMemoryLock(this.root, fn, { timeoutMs: this.lockTimeoutMs, ...opts });
  }

  /**
   * Resolve a wiki-relative path, refusing anything that escapes the wiki root. `memory_read`
   * takes a path straight from the model and declares no `paths()` (a wiki-relative path would
   * wrongly satisfy a cwdOnly rule), so confinement has to live here — otherwise enabling the
   * tool grants unconfined reads of any frontmatter-shaped file on the box.
   */
  private abs(rel: string): string {
    const root = resolve(this.root);
    const full = resolve(root, rel);
    const inside = relative(root, full);
    if (inside !== "" && (inside.startsWith("..") || isAbsolute(inside))) {
      throw new Error(`path escapes the wiki root: ${rel}`);
    }
    return full;
  }

  private today(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  /** Create the wiki skeleton if absent. Idempotent; never overwrites existing content. */
  async init(): Promise<void> {
    // mkdir/ensure(O_EXCL) never replace existing content. In particular, a stale write lock
    // must not prevent read-only CLI commands from opening and inspecting an existing wiki.
    await mkdir(this.root, { recursive: true });
    for (const dir of Object.values(PAGE_DIR)) await mkdir(this.abs(dir), { recursive: true });
    await this.ensure(INDEX_FILE, `${INDEX_HEADER}\n`);
    await this.ensure(LOG_FILE, LOG_HEADER);
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

  async index(opts: MemoryLockOptions = {}): Promise<IndexEntry[]> {
    let text: string;
    try {
      text = opts.maxFileBytes === undefined ? await readFile(this.abs(INDEX_FILE), "utf8")
        : (await readBoundedFile(this.abs(INDEX_FILE), opts.maxFileBytes, opts.signal)).toString("utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return text.split("\n").map(parseEntry).filter((e): e is IndexEntry => e !== null);
  }

  async writeIndex(entries: IndexEntry[]): Promise<void> {
    return this.withMutationLock(() => this.writeIndexUnlocked(entries));
  }

  private async writeIndexUnlocked(entries: IndexEntry[], signal?: AbortSignal, maxFileBytes?: number): Promise<void> {
    const sorted = [...entries].sort((a, b) =>
      a.type === b.type ? a.slug.localeCompare(b.slug) : a.type.localeCompare(b.type),
    );
    const contents = `${INDEX_HEADER}\n${sorted.map(serializeEntry).join("\n")}\n`;
    if (maxFileBytes !== undefined && Buffer.byteLength(contents) > maxFileBytes) throw new MaintenanceLimitError("maintenance index output limit exceeded");
    await this.atomicWrite(INDEX_FILE, contents, signal);
  }

  /** Insert or replace one index row, preserving everything else. */
  async upsertIndex(entry: IndexEntry, opts: MemoryLockOptions = {}): Promise<void> {
    await this.withMutationLock(() => this.upsertIndexUnlocked(entry, opts.signal, opts.maxFileBytes), opts);
  }

  private async upsertIndexUnlocked(entry: IndexEntry, signal?: AbortSignal, maxFileBytes?: number): Promise<void> {
    const entries = await this.index({ ...(signal === undefined ? {} : { signal }), ...(maxFileBytes === undefined ? {} : { maxFileBytes }) });
    const i = entries.findIndex((e) => e.slug === entry.slug && e.type === entry.type);
    if (i === -1) entries.push(entry);
    else entries[i] = entry;
    await this.writeIndexUnlocked(entries, signal, maxFileBytes);
  }

  async read(path: string, opts: MemoryLockOptions & { scanBudget?: ScanBudget } = {}): Promise<WikiPage | null> {
    const full = this.abs(path);
    let bytes: Buffer;
    let mtime: number;
    try {
      bytes = opts.scanBudget !== undefined ? await opts.scanBudget.read(full)
        : opts.maxFileBytes === undefined ? await readFile(full) : await readBoundedFile(full, opts.maxFileBytes, opts.signal);
      mtime = (await stat(full)).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const { frontmatter, body } = parsePage(bytes.toString("utf8"), path);
    return { path, frontmatter, body, updatedAt: mtime, version: versionOf(bytes) };
  }

  /** Trusted unconditional replacement. Use compareAndSwap/update for read-modify-write. */
  async write(path: string, page: PageWrite, opts: MemoryLockOptions = {}): Promise<void> {
    await this.withMutationLock(() => this.atomicWrite(path, serializePage(page.frontmatter, page.body), opts.signal), opts);
  }

  async compareAndSwap(path: string, page: PageWrite | ((current: WikiPage | null) => PageWrite), ifVersion: string | null, opts: MemoryLockOptions & { index?: IndexEntry } = {}): Promise<MemoryWriteResult> {
    const warnings: string[] = [];
    return this.withMutationLock(async () => {
      const current = await this.read(path);
      if ((current?.version ?? null) !== ifVersion) return { ok: false, current, warnings };
      const next = typeof page === "function" ? page(current) : page;
      const text = serializePage(next.frontmatter, next.body);
      await this.atomicWrite(path, text, opts.signal);
      // Once the page commits, finish its index bookkeeping even if cancellation arrives.
      // A filesystem failure is explicit partial success, not a claim that the page was unwritten.
      if (opts.index !== undefined) {
        try { await this.upsertIndexUnlocked(opts.index); }
        catch (error) { warnings.push(`page committed at ${path}; index update failed: ${String(error)}`); }
      }
      return { ok: true, version: versionOf(text), warnings };
    }, { ...opts, onReleaseError: error => {
      warnings.push(error.message);
      if (opts.onReleaseError !== undefined) opts.onReleaseError(error);
      else process.emitWarning(error.message, { code: "AGENTRIG_MEMORY_LOCK_RELEASE" });
    } });
  }

  /** Synchronous transform under the short mutation lock; never call providers here. */
  async update(path: string, transform: (current: WikiPage | null) => PageWrite, opts: MemoryLockOptions = {}): Promise<WikiPage> {
    return this.withMutationLock(async () => {
      const next = transform(await this.read(path, opts));
      const contents = serializePage(next.frontmatter, next.body);
      if (opts.maxFileBytes !== undefined && Buffer.byteLength(contents) > opts.maxFileBytes) throw new MaintenanceLimitError("maintenance page output limit exceeded");
      await this.atomicWrite(path, contents, opts.signal);
      // Reading the committed receipt is allowed after cancellation; do not claim no commit.
      return (await this.read(path, { ...(opts.maxFileBytes === undefined ? {} : { maxFileBytes: opts.maxFileBytes }) }))!;
    }, opts);
  }

  /**
   * Claim a slug by creating its page with O_EXCL. `exists` means another ingest got there
   * first and this one should update that page rather than fork a near-duplicate slug.
   * The LLM call that fills the page happens outside this — the lock is only the placeholder.
   */
  async reserve(slug: string, claimant: string, type: PageType = "entity", opts: MemoryLockOptions = {}): Promise<"created" | "exists"> {
    return this.withMutationLock(() => this.reserveUnlocked(slug, claimant, type, opts), opts);
  }

  private async reserveUnlocked(slug: string, claimant: string, type: PageType, opts: MemoryLockOptions): Promise<"created" | "exists"> {
    const rel = pagePath(type, slug);
    const full = this.abs(rel);
    await mkdir(dirname(full), { recursive: true });
    const placeholder = serializePage(
      { type, slug, aliases: [], sources: [], updated: this.today(), confidence: "low" },
      reservationPlaceholder(claimant),
    );
    if (opts.maxFileBytes !== undefined && Buffer.byteLength(placeholder) > opts.maxFileBytes) throw new MaintenanceLimitError("maintenance reservation output limit exceeded");
    opts.signal?.throwIfAborted();
    try {
      const handle = await open(full, "wx");
      try {
        await handle.writeFile(placeholder, "utf8");
      } finally {
        await handle.close();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        opts.signal?.throwIfAborted();
        const entries = await this.index(opts);
        const i = entries.findIndex((e) => e.slug === slug && e.type === type);
        if (i === -1) {
          // Re-adopt pages whose catalog row was lost in an earlier interrupted operation.
          entries.push({ slug, path: rel, type, status: "planned", summary: `(reserved by ${claimant})`, claimedBy: [claimant] });
        } else {
          entries[i] = { ...entries[i]!, claimedBy: [...new Set([...(entries[i]!.claimedBy ?? []), claimant])] };
        }
        await this.writeIndexUnlocked(entries, opts.signal, opts.maxFileBytes);
        return "exists";
      }
      throw err;
    }
    await this.upsertIndexUnlocked({
      slug,
      path: rel,
      type,
      status: "planned",
      summary: `(reserved by ${claimant})`,
      claimedBy: [claimant],
    }, undefined, opts.maxFileBytes);
    return "created";
  }

  async appendLog(entry: string, opts: MemoryLockOptions = {}): Promise<void> {
    // read-modify-atomicWrite rather than appendFile: appendFile follows a symlink, which let a
    // dream's log line write through a symlinked log.md into the wiki it was supposed to be
    // copying. Every other writer here already goes through atomicWrite.
    await this.withMutationLock(async () => {
      const line = entry.endsWith("\n") ? entry : `${entry}\n`;
      const existing = await (opts.maxFileBytes === undefined ? readFile(this.abs(LOG_FILE), "utf8")
        : readBoundedFile(this.abs(LOG_FILE), opts.maxFileBytes, opts.signal).then(bytes => bytes.toString("utf8"))).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return LOG_HEADER;
        throw err;
      });
      const repaired = recoverLogHeader(existing);
      const contents = repaired + (repaired.endsWith("\n") ? "" : "\n") + line;
      if (opts.maxFileBytes !== undefined && Buffer.byteLength(contents) > opts.maxFileBytes) throw new MaintenanceLimitError("maintenance log output limit exceeded");
      await this.atomicWrite(LOG_FILE, contents, opts.signal);
    }, opts);
  }

  /** Every page on disk, for search and lint. */
  async pages(opts?: ScanOptions): Promise<WikiPage[]> {
    const budget = opts === undefined ? undefined : new ScanBudget(opts);
    const read = async (path: string) => {
      if (budget === undefined) return this.read(path).catch(() => null);
      budget.check();
      return this.read(path, { scanBudget: budget });
    };
    const out: WikiPage[] = [];
    for (const dir of Object.values(PAGE_DIR)) {
      let names: string[];
      try {
        names = budget === undefined ? await readdir(this.abs(dir)) : await budget.names(this.abs(dir));
      } catch (error) {
        if (budget !== undefined && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".md")) continue;
        // Wiki identifiers use forward slashes on every host, like pagePath() and index rows.
        // Native Windows separators would make model consolidation targets miss these pages.
        const page = await read(`${dir}/${name}`);
        if (page !== null) out.push(page);
      }
    }
    const overview = await read(OVERVIEW_FILE);
    if (overview !== null) out.push(overview);
    budget?.check();
    return out;
  }

  async search(query: string, k = 8): Promise<Array<{ page: WikiPage; score: number; snippet: string }>> {
    return bm25Search(await this.pages(), query, k);
  }

  private async atomicWrite(rel: string, contents: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const full = this.abs(rel);
    await mkdir(dirname(full), { recursive: true });
    const tmp = `${full}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, contents, "utf8");
      signal?.throwIfAborted();
      await rename(tmp, full);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }
}
