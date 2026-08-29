import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { z } from "zod";
import { tokenize } from "./search.js";
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

export async function readPins(wikiRoot: string): Promise<Pin[]> {
  let text: string;
  try {
    text = await readFile(join(wikiRoot, PINS_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const parsed = z.array(PinSchema).safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`${join(wikiRoot, PINS_FILE)}: invalid pins file`);
  return parsed.data;
}

export async function writePins(wikiRoot: string, pins: Pin[]): Promise<void> {
  const full = join(wikiRoot, PINS_FILE);
  await mkdir(dirname(full), { recursive: true });
  const tmp = `${full}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(z.array(PinSchema).parse(pins), null, 2)}\n`, "utf8");
    await rename(tmp, full);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function addPin(wikiRoot: string, pin: Pin): Promise<void> {
  const pins = await readPins(wikiRoot);
  const i = pins.findIndex((p) => p.page === pin.page && p.claim === pin.claim);
  if (i === -1) pins.push(PinSchema.parse(pin));
  else pins[i] = PinSchema.parse(pin);
  await writePins(wikiRoot, pins);
}

export type PinStatus = "kept" | "conflict" | "orphaned";

export interface PinCheck {
  pin: Pin;
  status: PinStatus;
  reason: string;
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
export async function recheckPins(store: MemoryStore, pins: Pin[]): Promise<PinCheck[]> {
  const out: PinCheck[] = [];
  for (const pin of pins) {
    const page = await store.read(pin.page).catch(() => null);
    if (page === null) {
      out.push({ pin, status: "orphaned", reason: `page ${pin.page} no longer exists` });
      continue;
    }
    const anchorPresent = pin.anchor === "" || page.body.includes(pin.anchor);
    if (claimSatisfied(pin.claim, page.body)) {
      out.push(
        anchorPresent
          ? { pin, status: "kept", reason: "claim still present" }
          : { pin, status: "orphaned", reason: `anchor ${JSON.stringify(pin.anchor)} is gone` },
      );
      continue;
    }
    out.push({
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
 */
export async function applyPinChecks(wikiRoot: string, checks: PinCheck[]): Promise<void> {
  const statusOf: Record<PinStatus, Pin["status"]> = { kept: "active", conflict: "conflict", orphaned: "orphaned" };
  const current = await readPins(wikiRoot);
  const merged = [...current];
  for (const c of checks) {
    const updated = { ...c.pin, status: statusOf[c.status] };
    const i = merged.findIndex((p) => p.page === c.pin.page && p.claim === c.pin.claim);
    if (i === -1) merged.push(updated);
    else merged[i] = updated;
  }
  await writePins(wikiRoot, merged);
}
