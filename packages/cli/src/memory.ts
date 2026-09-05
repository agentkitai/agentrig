import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  FileMemoryStore,
  FileRawStore,
  LoreBackend,
  SCHEMA_MD,
  findingCount,
  formatAuxiliaryUsage,
  ingestSession,
  loreConfigFromEnv,
  loadPromotionEvidence,
  selectForPromotion,
  sessionEvidence,
  renderPromotionProposal,
  renderReport,
  runDream,
  resetDreamStamp,
  tolerant,
  unionRetrieve,
  withBackendRecall,
  type MemoryBackend,
  type IngestLimits,
  type MaintenanceLimits,
  type ScanLimits,
} from "@agentkitai/agentrig-memory";
import { buildRoleProvider, memoryRole, type ProviderOptions } from "./provider.js";
import { withMaintenanceSignal } from "./maintenance.js";

/**
 * `agentrig memory …` — thin wrappers over the memory package. Anything with logic in it
 * belongs in the package, not here.
 */

export interface MemoryOptions {
  dir: string;
}

export async function memoryResetDreamStamp(opts: MemoryOptions & { confirm?: boolean }): Promise<void> {
  const wiki = layout(opts.dir).wiki;
  if (opts.confirm !== true) {
    console.log(`Reset only ${join(wiki, ".last-dream")}, preserving a named sibling backup. Stop running/scheduled dreams first; rerun with --confirm. Nothing changed.`);
    return;
  }
  await withMaintenanceSignal(async signal => {
    const result = await resetDreamStamp(wiki, { signal });
    console.log(result.status === "absent" ? "No dream scheduling stamp; nothing changed."
      : `Dream scheduling stamp reset; the next scheduled dream is due. Previous stamp preserved at ${result.backup}`);
  });
}

/** `.agentrig` layout (PLAN §3.1): raw/ beside wiki/ beside SCHEMA.md. */
export function layout(dir: string) {
  return { root: dir, wiki: join(dir, "wiki"), schema: join(dir, "SCHEMA.md") };
}

/**
 * The optional Lore backend (PLAN §3.8), or null when unconfigured — the no-infra default.
 * Always wrapped so a backend failure is reported and then ignored.
 */
export function openBackend(opts: { tolerate?: boolean } = {}): MemoryBackend | null {
  if (loreConfigFromEnv() === null) return null;
  try {
    const backend = new LoreBackend();
    return opts.tolerate === false ? backend : tolerant(backend, backendError);
  } catch (err) {
    // a misconfigured OPTIONAL backend must not take down the harness
    console.error(`lore backend disabled (${(err as Error).message}); continuing without it`);
    return null;
  }
}

export function backendError(op: string, err: Error): void {
  console.error(`lore ${op} failed (continuing): ${err.message}`);
}

/** Project name for backend scoping and provenance — the repo, not the memory directory. */
export function projectName(): string {
  return basename(resolve(process.cwd())) || "default";
}

async function openStore(dir: string): Promise<FileMemoryStore> {
  const store = new FileMemoryStore({ root: layout(dir).wiki });
  await store.init();
  return store;
}

export async function memoryInit(opts: MemoryOptions): Promise<void> {
  const { root, wiki, schema } = layout(opts.dir);
  await mkdir(join(root, "raw", "sessions"), { recursive: true });
  await mkdir(join(root, "raw", "attempts"), { recursive: true });
  await mkdir(join(root, "raw", "docs"), { recursive: true });
  await openStore(opts.dir);
  await writeFile(schema, SCHEMA_MD, { encoding: "utf8", flag: "wx" }).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "EEXIST") throw err;
  });
  console.log(`memory ready at ${root}\n  wiki:   ${wiki}\n  schema: ${schema}`);
}

export async function memoryLs(opts: MemoryOptions): Promise<void> {
  const entries = await (await openStore(opts.dir)).index();
  if (entries.length === 0) {
    console.log("wiki is empty");
    return;
  }
  for (const e of entries) console.log(`${e.status === "planned" ? "…" : " "} ${e.path}\t${e.summary}`);
}

export async function memoryShow(path: string, opts: MemoryOptions): Promise<void> {
  let page;
  try {
    page = await (await openStore(opts.dir)).read(path);
  } catch (err) {
    // a file that isn't a wiki page (or a path outside the wiki) is a user error, not a crash
    console.error(`not a wiki page: ${path} — ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  if (page === null) {
    console.error(`no such page: ${path}`);
    process.exitCode = 1;
    return;
  }
  console.log(`--- ${page.path} ---`);
  console.log(page.body);
}

export async function memorySearch(query: string, opts: MemoryOptions & { k?: string }): Promise<void> {
  let k = 8;
  if (opts.k !== undefined) {
    k = Number(opts.k);
    if (!Number.isFinite(k) || k <= 0) {
      // Number("abc") is NaN, and slice(0, NaN) silently returns nothing
      console.error(`-k must be a positive number, got "${opts.k}"`);
      process.exitCode = 1;
      return;
    }
  }
  const store = await openStore(opts.dir);
  const local = unionRetrieve(await store.index(), await store.pages(), query, k);
  const backend = openBackend();
  const hits = withBackendRecall(local, backend === null ? [] : await backend.recall(query, k), backend?.id ?? "backend", k);
  if (hits.length === 0) {
    console.log(`no matches for ${JSON.stringify(query)}`);
    return;
  }
  for (const h of hits) {
    if (h.via === "backend") console.log(`${h.ref} [backend]\n  ${h.text}`);
    else console.log(`${h.page.path} [${h.via}]\n  ${h.snippet}`);
  }
}

export type MemoryIngestOptions = MemoryOptions & ProviderOptions & {
  ingestLimits?: Partial<IngestLimits>;
  ingestSpanChars?: string;
};

export async function memoryIngest(sessionId: string, opts: MemoryIngestOptions): Promise<void> {
  const { root } = layout(opts.dir);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
    console.error("invalid ingest session id: use the ID, not a filename or path");
    process.exitCode = 1;
    return;
  }
  const store = new FileMemoryStore({ root: layout(opts.dir).wiki });
  const raw = new FileRawStore({ root });
  const logPath = join(root, "raw", "sessions", `${sessionId}.jsonl`);
  const exists = await stat(logPath).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
  if (!exists) {
    console.error(`no session log for ${sessionId} under ${root}/raw/sessions`);
    process.exitCode = 1;
    return;
  }
  let provider;
  try {
    // typed provider flags pin main to the flat default entry; otherwise the memory role. Only that
    // one entry is constructed — an ingest must not fail on a credential some other role needs.
    provider = buildRoleProvider(opts, memoryRole(opts));
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }
  const backend = openBackend({ tolerate: false });
  const result = await ingestSession({
    store,
    provider,
    sessionId,
    logPath,
    attemptsFrom: raw,
    onCorruptAttempt: path => console.error(`warning: unreadable attempt file, skipped: ${path}`),
    project: projectName(),
    ...(opts.ingestLimits === undefined ? {} : { limits: opts.ingestLimits }),
    ...(opts.ingestSpanChars === undefined ? {} : { maxSpanChars: Number(opts.ingestSpanChars) }),
    onBackendError: backendError,
    onUsage: report => console.error(formatAuxiliaryUsage(report)),
    ...(backend === null ? {} : { backend, checkBackendConflicts: true }),
  });
  for (const omission of result.omissions) {
    console.error(`uninspected evidence: event ${omission.eventIndex}, ${omission.field}: ${omission.reason}`);
  }
  if (result.skipped) {
    console.log(`session ${sessionId} already ingested and unchanged; nothing to do`);
    return;
  }
  const nothing = result.coverage.filter((c) => c.outcome === "nothing-durable").length;
  console.log(
    `ingested session ${sessionId}: ${result.factCount} facts across ${result.pagesWritten.length} pages` +
      `\n  coverage: ${result.coverage.length} spans (${nothing} with nothing durable)` +
      (result.supersededPrevious ? "\n  superseded an earlier capture of this session" : ""),
  );
  for (const p of result.pagesWritten) console.log(`  ${p}`);
  if (result.backendConflicts.length > 0) {
    console.error(`\n${result.backendConflicts.length} contradiction(s) reported by the backend:`);
    for (const c of result.backendConflicts) console.error(`  "${c.fact}" vs existing "${c.existing}"`);
  }
  if (result.pinConflicts.length > 0) {
    console.error(`\n${result.pinConflicts.length} pinned human correction(s) no longer hold:`);
    for (const c of result.pinConflicts) console.error(`  ${c.page}: ${c.claim} — ${c.reason}`);
    process.exitCode = 1;
  }
}

/** Preview checked witnesses; an explicit confirmation is required before shared-scope writes. */
export async function memoryPromote(path: string, opts: MemoryOptions & { confirm?: boolean }): Promise<void> {
  let page;
  try {
    page = await (await openStore(opts.dir)).read(path);
  } catch (err) {
    console.error(`not a wiki page: ${path} — ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  if (page === null) {
    console.error(`no such page: ${path}`);
    process.exitCode = 1;
    return;
  }
  const evidenceIndex = await loadPromotionEvidence(new FileRawStore({ root: opts.dir }),
    sessionEvidence(page).map(ref => ref.slice("session:".length)));
  const checked = selectForPromotion([page], { evidenceIndex });
  const proposal = checked.promote[0];
  if (proposal === undefined) {
    for (const rejected of checked.rejected) {
      console.error(`not eligible: ${rejected.reason}`);
      for (const claim of rejected.claims ?? []) if (!claim.eligible) console.error(`  ${claim.claim}: ${claim.reason}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(renderPromotionProposal(proposal));
  if (opts.confirm !== true) {
    console.log("Review these excerpts and the claim's meaning; rerun with --confirm to request shared-scope promotion. Nothing was published.");
    return;
  }
  if (loreConfigFromEnv() === null) {
    console.error("no memory backend configured (set LORE_API_URL and LORE_API_KEY)");
    process.exitCode = 1;
    return;
  }
  try {
    // An explicit publication must not report success after tolerant() swallowed a transport error.
    const backend = new LoreBackend();
    await backend.promote({ ...page, body: proposal.publicationBody,
      frontmatter: { ...page.frontmatter, sources: proposal.publicationSources } });
    console.log(`promoted ${page.path} to ${backend.id} shared scope`);
  } catch (err) {
    console.error(`promotion failed; the backend may have accepted a partial update: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

/** `lint` = a dry-run dream report. M3 ships the pin re-check; M5 adds the rest. */
export interface MemoryLintOptions extends MemoryOptions { dreamLimits?: Partial<MaintenanceLimits>; dreamScanLimits?: Partial<ScanLimits>; signal?: AbortSignal }
export async function memoryLint(opts: MemoryLintOptions): Promise<void> {
  return withMaintenanceSignal(signal => lintWithSignal(opts, signal), opts.signal);
}

async function lintWithSignal(opts: MemoryLintOptions, signal: AbortSignal): Promise<void> {
  const { wiki } = layout(opts.dir);
  const store = await openStore(opts.dir);

  // PLAN §5: `lint` is a dry-run dream report with no output store. It is the structural-only
  // pass, so it costs nothing and can run on every session end.
  // no provider at all: structural-only needs no model, so `lint` must not need a credential
  const result = await runDream({
    wiki: store,
    signal,
    limits: opts.dreamLimits ?? {}, scanLimits: opts.dreamScanLimits ?? {},
    onUsage: report => console.error(formatAuxiliaryUsage(report)),
    raw: new FileRawStore({ root: opts.dir }),
    structuralOnly: true,
    cwd: process.cwd(),
  });

  try {
    console.log(renderReport(result.report, {
      structural: result.structural,
      promotionRejected: result.promotionRejected,
    }));
  } finally {
    // a dry run leaves nothing behind, even if rendering threw
    await result.workspace.dispose().catch(error => console.error(`dream cleanup failed; inspect ${result.outputRoot} and ${result.workspace.manifestPath}: ${String(error)}`));
  }
  void wiki;

  const findings = findingCount(result.report, result.structural);
  if (findings > 0) {
    console.log(`${findings} finding(s). \`agentrig dream\` writes a corrected wiki you can review.`);
    process.exitCode = 1;
  }
}
