import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DreamInput, DreamReport, DreamResult, Dreamer } from "../types.js";
import { FileMemoryStore, OVERVIEW_FILE } from "../store.js";
import { readPins, recheckPins, applyPinChecks } from "../pins.js";
import { copyWiki, type DreamWorkspace } from "./copy.js";
import { structuralLint, type StructuralFindings } from "./lint.js";
import {
  consolidate,
  gatherFromAttempts,
  orient,
  rebuildIndex,
  type Consolidation,
  type Signal,
} from "./phases.js";
import { selectForPromotion, type PromotionRejection } from "./promote.js";
import { SCHEMA_MD } from "../ingest.js";

export const LAST_DREAM_FILE = ".last-dream";

export interface DreamOptions extends DreamInput {
  /** Where the new wiki goes. Defaults to a fresh temp directory the caller disposes. */
  outputRoot?: string;
  /** Cap on raw sessions scanned, per PLAN §3.7. */
  maxSessions?: number;
  /** Root that fact-line file references are resolved against, for the stale-ref check. */
  cwd?: string;
  minSessionsToPromote?: number;
  now?: () => number;
  /** Skips the model-backed consolidation pass — the free, structural-only dream. */
  structuralOnly?: boolean;
  onPhase?: (phase: string) => void;
  /** The consolidation pass failing is reported, not thrown — the rest of the dream still runs. */
  onError?: (err: Error) => void;
}

/** The report plus the structural findings, which `DreamReport` has no field for on its own. */
export interface FullDreamResult extends DreamResult {
  /** Set when the model-backed pass failed; the structural findings are still complete. */
  consolidationError?: string;
  structural: StructuralFindings;
  signals: Signal[];
  promotionRejected: PromotionRejection[];
  workspace: DreamWorkspace;
}

async function readOr(root: string, file: string, fallback = ""): Promise<string> {
  return readFile(join(root, file), "utf8").catch(() => fallback);
}

/** Timestamp of the last dream, so "raw sources since last dream" means something. */
export async function lastDreamAt(wikiRoot: string): Promise<number | undefined> {
  const raw = await readOr(wikiRoot, LAST_DREAM_FILE);
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export async function markDreamed(wikiRoot: string, at: number): Promise<void> {
  await writeFile(join(wikiRoot, LAST_DREAM_FILE), `${at}\n`, "utf8");
}

/**
 * PLAN §3.7's dream: orient → gather signal → consolidate → prune & index.
 *
 * The input wiki is never touched. Everything below operates on a copy, and the caller decides
 * whether to apply it (`auto`) or just read the report (`review`, the default) — which is the
 * point: a dream is a bulk LLM rewrite of the agent's memory, and the reviewable artifact has to
 * be the *result*, not a plan to produce one.
 */
export async function runDream(opts: DreamOptions): Promise<FullDreamResult> {
  const now = opts.now ?? (() => Date.now());
  const phase = (p: string): void => opts.onPhase?.(p);
  const workspace = await copyWiki(opts.wiki.root, opts.outputRoot);
  // concretely a FileMemoryStore, not the MemoryStore interface: the dream needs `pages()` and
  // `writeIndex()`, which are implementation surface rather than part of the read/write contract
  const out = new FileMemoryStore({ root: workspace.outputRoot, scope: opts.wiki.scope });

  // ---- phase 1: orient
  phase("orient");
  const index = await out.index();
  const schema = await readOr(workspace.outputRoot, "SCHEMA.md", SCHEMA_MD);
  const overviewPage = await out.read(OVERVIEW_FILE).catch(() => null);
  const orientation = orient(index, schema, overviewPage?.body ?? "");

  // ---- phase 2: gather signal
  phase("gather");
  const since = await lastDreamAt(opts.wiki.root);
  const maxSessions = opts.maxSessions ?? 100;
  const sessions = (await opts.raw.sessions(since)).slice(0, maxSessions);
  const attempts = "readAttempts" in opts.raw
    ? (await (opts.raw as { readAttempts: () => Promise<{ attempts: never[] }> }).readAttempts()).attempts
    : [];
  const signals = gatherFromAttempts(attempts);

  // ---- structural lint (free, no model)
  phase("lint");
  const pages = (await out.pages()).filter((p) => p.path !== OVERVIEW_FILE);
  const structural = await structuralLint(pages, index, opts.cwd === undefined ? {} : { cwd: opts.cwd });

  // ---- phase 3: consolidate (the only phase that costs tokens)
  phase("consolidate");
  let consolidationError: string | undefined;
  const consolidation: Consolidation =
    opts.structuralOnly === true || pages.length === 0
      ? { contradictions: [], superseded: [], merged: [], removed: [] }
      : await consolidate({
          provider: opts.provider,
          pages,
          signals,
          orientation,
          onError: (err) => {
            consolidationError = err.message;
            opts.onError?.(err);
          },
        });

  // ---- phase 4: prune & index, then re-check pins against the dreamt text
  phase("prune");
  await out.writeIndex(rebuildIndex(pages, index));
  const pins = await readPins(workspace.outputRoot);
  const pinChecks = await recheckPins(out, pins);
  await applyPinChecks(workspace.outputRoot, pinChecks);

  // ---- promotion proposals (structurally gated: never from a single session)
  const { promote, rejected } = selectForPromotion(
    pages,
    opts.minSessionsToPromote === undefined ? {} : { minSessions: opts.minSessionsToPromote },
  );
  // with no global wiki attached there is nowhere to promote *to*, so propose nothing
  const promoted = opts.globalWiki === undefined ? [] : promote;

  const report: DreamReport = {
    contradictions: consolidation.contradictions,
    superseded: consolidation.superseded,
    orphans: structural.orphans,
    missingPages: structural.missingPages,
    merged: consolidation.merged,
    removed: consolidation.removed,
    promoted,
    pinsAffected: pinChecks.map((c) => ({ pin: `${c.pin.page}: ${c.pin.claim}`, status: c.status })),
  };

  await out.appendLog(
    `${new Date(now()).toISOString()} | dream | ${sessions.length} session(s) since last | ` +
      `${report.contradictions.length} contradiction(s), ${report.orphans.length} orphan(s), ` +
      `${report.missingPages.length} missing page(s)`,
  );
  await markDreamed(workspace.outputRoot, now());

  return {
    outputRoot: workspace.outputRoot,
    report,
    ...(consolidationError === undefined ? {} : { consolidationError }),
    structural,
    signals,
    promotionRejected: rejected,
    workspace,
  };
}

/** The `Dreamer` interface from PLAN §3.7, for callers that only want the narrow contract. */
export class WikiDreamer implements Dreamer {
  constructor(private readonly opts: Omit<DreamOptions, keyof DreamInput> = {}) {}
  async dream(input: DreamInput): Promise<DreamResult> {
    const { outputRoot, report } = await runDream({ ...this.opts, ...input });
    return { outputRoot, report };
  }
}
