import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { z } from "zod";
import { searchableBody, tokenize } from "./search.js";
import { withMemoryLock, type MemoryLockOptions } from "./lock.js";
import { FileMemoryStore } from "./store.js";
import { readBoundedFile } from "./bounded-file.js";
import { MaintenanceLimitError } from "./maintenance.js";
import type { MemoryStore, Pin } from "./types.js";

/**
 * Pins (PLAN §3.6): human corrections that must survive regeneration.
 *
 * The sharp edge of "the LLM maintains everything" is that the next ingest rewrites a page and
 * silently reverts a fix a human made by hand. A pin records the *intent* — the claim — not a
 * text diff, which is what lets re-application survive rewording.
 */

export const PinSchema = z.object({
  page: z.string(),
  kind: z.enum(["correction", "addition", "deletion"]),
  claim: z.string().min(1),
  anchor: z.string(),
  provenance: z.literal("human"),
  created: z.string(),
  status: z.enum(["active", "conflict", "orphaned"]).default("active"),
});

const PINS_FILE = "pins.json";

export interface PinReadOptions extends MemoryLockOptions { scanBudget?: import("./scan.js").ScanBudget }

export async function readPins(wikiRoot: string, opts: PinReadOptions = {}): Promise<Pin[]> {
  let text: string;
  try {
    text = opts.scanBudget !== undefined ? (await opts.scanBudget.read(join(wikiRoot, PINS_FILE))).toString("utf8")
      : opts.maxFileBytes === undefined ? await readFile(join(wikiRoot, PINS_FILE), "utf8")
      : (await readBoundedFile(join(wikiRoot, PINS_FILE), opts.maxFileBytes, opts.signal)).toString("utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const parsed = z.array(PinSchema).safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`${join(wikiRoot, PINS_FILE)}: invalid pins file`);
  if (opts.scanBudget !== undefined && parsed.data.length > opts.scanBudget.limits.maxEntries) throw new MaintenanceLimitError("pin entry limit exceeded");
  return parsed.data;
}

/** Trusted unconditional replacement; use addPin/recheckStoredPins for read-modify-write. */
export async function writePins(wikiRoot: string, pins: Pin[], opts: MemoryLockOptions = {}): Promise<void> {
  await withMemoryLock(wikiRoot, () => writePinsUnlocked(wikiRoot, pins, opts.signal, opts.maxFileBytes), opts);
}

async function writePinsUnlocked(wikiRoot: string, pins: Pin[], signal?: AbortSignal, maxFileBytes?: number): Promise<void> {
  signal?.throwIfAborted();
  const text = `${JSON.stringify(z.array(PinSchema).parse(pins), null, 2)}\n`;
  if (maxFileBytes !== undefined && Buffer.byteLength(text) > maxFileBytes) throw new MaintenanceLimitError("maintenance pins output limit exceeded");
  const full = join(wikiRoot, PINS_FILE);
  await mkdir(dirname(full), { recursive: true });
  const tmp = `${full}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, text, "utf8");
    signal?.throwIfAborted();
    await rename(tmp, full);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function addPin(wikiRoot: string, pin: Pin, opts: MemoryLockOptions = {}): Promise<void> {
  await withMemoryLock(wikiRoot, async () => {
    const pins = await readPins(wikiRoot, opts);
    const i = pins.findIndex((p) => p.page === pin.page && p.claim === pin.claim);
    if (i === -1) pins.push(PinSchema.parse(pin));
    else pins[i] = PinSchema.parse(pin);
    await writePinsUnlocked(wikiRoot, pins, opts.signal, opts.maxFileBytes);
  }, opts);
}

export type PinStatus = "kept" | "conflict" | "orphaned";

export interface PinCheck {
  pin: Pin;
  status: PinStatus;
  reason: string;
  /** Exact checked page content (null for absence); unversioned checks cannot be persisted safely. */
  pageVersion?: string | null;
}

const NEGATIONS = new Set([
  "not", "no", "never", "without", "neither", "nor", "cannot", "cant", "isnt", "arent", "dont",
  "doesnt", "didnt", "wont", "shouldnt", "n't",
]);

function normalizeWord(w: string): string {
  return w.replace(/['']/g, "");
}

/**
 * Which of a text's content words fall inside a negation's scope. Scope is approximated by
 * clause: a negation applies to the words after it, up to the next clause break. Crude, but it
 * distinguishes "applies per request, not per batch" from "does not apply per request", which
 * counting negations cannot.
 *
 * A term negated anywhere counts as negated — this biases toward reporting a conflict, which is
 * the safe direction for a mechanism whose whole job is catching a reverted human correction.
 */
function polarity(text: string): Map<string, boolean> {
  const map = new Map<string, boolean>();
  const clauses = text.toLowerCase().split(/[,;.:!?\n]|\b(?:but|however|though|whereas)\b/);
  for (const clause of clauses) {
    let negated = false;
    for (const word of clause.split(/[^a-z0-9_'’+#.-]+/)) {
      const w = normalizeWord(word);
      if (w === "") continue;
      if (NEGATIONS.has(w)) {
        negated = true;
        continue;
      }
      for (const t of tokenize(w)) {
        if (negated || !map.has(t)) map.set(t, negated || (map.get(t) ?? false));
      }
    }
  }
  return map;
}

/**
 * Is the pinned claim still present in the page text?
 *
 * Deliberately fuzzy on wording — the pin stores an intent, so a reworded line should still
 * count. But NOT fuzzy on polarity: the search tokenizer drops "not"/"never" as stopwords, which
 * made a page asserting the exact opposite of the pin read as satisfied. Since the entire point
 * of a pin is to catch a regeneration that reverted a human's correction, a false "kept" is far
 * worse than a false "conflict" — so a polarity mismatch fails closed.
 */
export function claimSatisfied(claim: string, pageBody: string): boolean {
  pageBody = searchableBody(pageBody);
  const terms = new Set(tokenize(claim));
  if (terms.size === 0) return true;
  const bodyTerms = new Set(tokenize(pageBody));
  let hits = 0;
  for (const t of terms) if (bodyTerms.has(t)) hits += 1;
  // a short claim must match in full; only a longer one gets slack for one reworded word
  const required = terms.size <= 3 ? terms.size : terms.size - 1;
  if (hits < required) return false;

  const claimPolarity = polarity(claim);
  const bodyPolarity = polarity(pageBody);
  for (const t of terms) {
    const inClaim = claimPolarity.get(t);
    const inBody = bodyPolarity.get(t);
    if (inClaim === undefined || inBody === undefined) continue;
    if (inClaim !== inBody) return false; // the page negates what the claim asserts, or vice versa
  }
  return true;
}


/**
 * Re-check pins after a regeneration (PLAN §3.6):
 * - claim still satisfied → kept
 * - anchor section gone → orphaned (flag; the human decides where it belongs now)
 * - claim contradicted by the new text → conflict, surfaced rather than dropped
 *
 * A contradicted pin is never silently deleted. Losing a human correction quietly is the exact
 * failure this mechanism exists to prevent.
 */
export async function recheckPins(store: MemoryStore, pins: Pin[], opts: PinReadOptions = {}): Promise<PinCheck[]> {
  if (opts.scanBudget !== undefined && pins.length > opts.scanBudget.limits.maxEntries) throw new MaintenanceLimitError("pin entry limit exceeded");
  const out: PinCheck[] = [];
  for (const pin of pins) {
    opts.signal?.throwIfAborted();
    const page = store instanceof FileMemoryStore ? await store.read(pin.page, opts) : await store.read(pin.page);
    const snapshot = page === null ? { pageVersion: null } : page.version === undefined ? {} : { pageVersion: page.version };
    if (page === null) {
      out.push({ ...snapshot, pin, status: "orphaned", reason: `page ${pin.page} no longer exists` });
      continue;
    }
    const anchorPresent = pin.anchor === "" || searchableBody(page.body).includes(pin.anchor);
    if (claimSatisfied(pin.claim, page.body)) {
      out.push(
        anchorPresent
          ? { ...snapshot, pin, status: "kept", reason: "claim still present" }
          : { ...snapshot, pin, status: "orphaned", reason: `anchor ${JSON.stringify(pin.anchor)} is gone` },
      );
      continue;
    }
    out.push({
      ...snapshot,
      pin,
      status: "conflict",
      reason: anchorPresent
        ? "claim is no longer present in the page"
        : `claim missing and anchor ${JSON.stringify(pin.anchor)} is gone`,
    });
  }
  return out;
}

/**
 * Apply the re-check back to the stored pins so their status reflects the current wiki.
 * Merges by (page, claim) against the file rather than replacing it wholesale — a subset of
 * checks must never delete the pins it didn't cover.
 * Stale/unversioned checks and pins deleted or changed since inspection are skipped; callers
 * needing a fresh persisted status should use recheckStoredPins instead of retrying old checks.
 * Counts are per input check, not distinct pins or physical writes; already-current statuses
 * count as applied. Pass the inspected store to preserve custom read/scope semantics.
 * Lock options are independent of the store constructor; pass timeoutMs here explicitly.
 */
export async function applyPinChecks(wiki: string | MemoryStore, checks: PinCheck[], opts: PinReadOptions = {}): Promise<{ applied: number; skipped: number }> {
  if (opts.scanBudget !== undefined && checks.length > opts.scanBudget.limits.maxEntries) throw new MaintenanceLimitError("pin entry limit exceeded");
  const store = typeof wiki === "string" ? new FileMemoryStore({ root: wiki }) : wiki;
  const wikiRoot = store.root;
  return withMemoryLock(wikiRoot, async () => {
    const current = await readPins(wikiRoot, opts);
    const fresh: PinCheck[] = [];
    for (const check of checks) {
      opts.signal?.throwIfAborted();
      if (check.pageVersion === undefined) continue;
      const page = store instanceof FileMemoryStore ? await store.read(check.pin.page, opts) : await store.read(check.pin.page);
      if ((page?.version ?? null) === check.pageVersion) fresh.push(check);
    }
    const merged = mergeChecks(current, fresh);
    if (JSON.stringify(merged.pins) !== JSON.stringify(current)) await writePinsUnlocked(wikiRoot, merged.pins, opts.signal, opts.maxFileBytes);
    return { applied: merged.applied, skipped: checks.length - merged.applied };
  }, opts);
}

function mergeChecks(current: Pin[], checks: PinCheck[]): { pins: Pin[]; applied: number } {
  const statusOf: Record<PinStatus, Pin["status"]> = { kept: "active", conflict: "conflict", orphaned: "orphaned" };
  const merged = [...current];
  let applied = 0;
  for (const c of checks) {
    const updated = { ...c.pin, status: statusOf[c.status] };
    const i = current.findIndex((p) => p.page === c.pin.page && p.claim === c.pin.claim);
    // A stale check must not resurrect a deleted pin or overwrite a newer human correction.
    if (i !== -1 && JSON.stringify(PinSchema.parse(current[i])) === JSON.stringify(PinSchema.parse(c.pin))) {
      merged[i] = updated; applied++;
    }
  }
  return { pins: merged, applied };
}

/** Read current pins/pages and persist statuses under the same lock as page and pin writers.
 * Lock options are independent of the store constructor, as with applyPinChecks.
 */
export async function recheckStoredPins(store: MemoryStore, paths?: ReadonlySet<string>, opts: MemoryLockOptions = {}): Promise<PinCheck[]> {
  // An empty snapshot needs no mutation. Pins added after it belong to a later operation.
  opts.signal?.throwIfAborted();
  if ((await readPins(store.root, opts)).length === 0) return [];
  return withMemoryLock(store.root, async () => {
    const pins = await readPins(store.root, opts);
    const relevant = paths === undefined ? pins : pins.filter(pin => paths.has(pin.page));
    const checks = await recheckPins(store, relevant, opts);
    const merged = mergeChecks(pins, checks);
    if (opts.maxFileBytes !== undefined && Buffer.byteLength(JSON.stringify(merged.pins, null, 2)) + 1 > opts.maxFileBytes) throw new MaintenanceLimitError("maintenance pins output limit exceeded");
    if (JSON.stringify(merged.pins) !== JSON.stringify(pins)) await writePinsUnlocked(store.root, merged.pins, opts.signal);
    return checks;
  }, opts);
}
