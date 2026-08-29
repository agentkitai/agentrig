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

/**
 * Is the pinned claim still present in the page text? Deliberately fuzzy: the claim is an
 * intent, so a reworded-but-equivalent line should still count. Content words must all appear;
 * exact phrasing need not.
 */
export function claimSatisfied(claim: string, pageBody: string): boolean {
  const claimTerms = new Set(tokenize(claim));
  if (claimTerms.size === 0) return true;
  const bodyTerms = new Set(tokenize(pageBody));
  let hits = 0;
  for (const t of claimTerms) if (bodyTerms.has(t)) hits += 1;
  // every content word present, allowing one to have been dropped in a rewording
  return hits >= Math.max(1, claimTerms.size - 1);
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

/** Apply the re-check back to the stored pins so their status reflects the current wiki. */
export async function applyPinChecks(wikiRoot: string, checks: PinCheck[]): Promise<void> {
  const statusOf: Record<PinStatus, Pin["status"]> = { kept: "active", conflict: "conflict", orphaned: "orphaned" };
  await writePins(
    wikiRoot,
    checks.map((c) => ({ ...c.pin, status: statusOf[c.status] })),
  );
}
