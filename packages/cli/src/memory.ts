import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FileMemoryStore,
  FileRawStore,
  SCHEMA_MD,
  ingestSession,
  readPins,
  recheckPins,
  unionRetrieve,
} from "@agentkitai/agentrig-memory";
import { buildProvider, type ProviderOptions } from "./provider.js";

/**
 * `agentrig memory …` — thin wrappers over the memory package. Anything with logic in it
 * belongs in the package, not here.
 */

export interface MemoryOptions {
  dir: string;
}

/** `.agentrig` layout (PLAN §3.1): raw/ beside wiki/ beside SCHEMA.md. */
export function layout(dir: string) {
  return { root: dir, wiki: join(dir, "wiki"), schema: join(dir, "SCHEMA.md") };
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
  const page = await (await openStore(opts.dir)).read(path);
  if (page === null) {
    console.error(`no such page: ${path}`);
    process.exitCode = 1;
    return;
  }
  console.log(`--- ${page.path} ---`);
  console.log(page.body);
}

export async function memorySearch(query: string, opts: MemoryOptions & { k?: string }): Promise<void> {
  const store = await openStore(opts.dir);
  const hits = unionRetrieve(await store.index(), await store.pages(), query, opts.k === undefined ? 8 : Number(opts.k));
  if (hits.length === 0) {
    console.log(`no matches for ${JSON.stringify(query)}`);
    return;
  }
  for (const h of hits) console.log(`${h.page.path} [${h.via}]\n  ${h.snippet}`);
}

export type MemoryIngestOptions = MemoryOptions & ProviderOptions;

export async function memoryIngest(sessionId: string, opts: MemoryIngestOptions): Promise<void> {
  const { root } = layout(opts.dir);
  const store = await openStore(opts.dir);
  const raw = new FileRawStore({ root });
  const sessions = await raw.sessions();
  const session = sessions.find((s) => s.id === sessionId);
  if (session === undefined) {
    console.error(`no session log for ${sessionId} under ${root}/raw/sessions`);
    process.exitCode = 1;
    return;
  }
  let provider;
  try {
    provider = buildProvider(opts);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }
  const result = await ingestSession({
    store,
    provider,
    sessionId,
    logPath: session.path,
    attempts: await raw.attempts(sessionId),
  });
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
}

/** `lint` = a dry-run dream report. M3 ships the pin re-check; M5 adds the rest. */
export async function memoryLint(opts: MemoryOptions): Promise<void> {
  const { wiki } = layout(opts.dir);
  const store = await openStore(opts.dir);
  const pins = await readPins(wiki);
  const checks = await recheckPins(store, pins);
  const planned = (await store.index()).filter((e) => e.status === "planned");

  console.log(`pins: ${checks.length}`);
  for (const c of checks) console.log(`  [${c.status}] ${c.pin.page} — ${c.reason}`);
  if (planned.length > 0) {
    console.log(`\nreserved but never filled: ${planned.length}`);
    for (const p of planned) console.log(`  ${p.path} (claimed by ${(p.claimedBy ?? []).join(", ")})`);
  }
  const conflicts = checks.filter((c) => c.status === "conflict").length;
  if (conflicts > 0) {
    console.log(`\n${conflicts} pin(s) contradicted by the current wiki — review before regenerating.`);
    process.exitCode = 1;
  }
  console.log("\n(full dream lint — contradictions, superseded claims, orphans — lands in M5)");
}
