import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Attempt, DreamInput, DreamReport, DreamResult, Dreamer } from "../types.js";
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
import { applyConsolidation, type AppliedChanges } from "./apply.js";
import { SCHEMA_MD } from "../ingest.js";

export const LAST_DREAM_FILE = ".last-dream";

export interface DreamOptions extends Omit<DreamInput, "provider"> {
  /**
   * Optional: a structural-only dream never reaches a model. Typed optional rather than passed
   * as `undefined as never` so that anyone later adding a model call to `orient` or `prune`
   * gets a type error instead of a runtime TypeError.
   */
  provider?: DreamInput["provider"];
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
  /** What was actually written to the output wiki — the report is built from this, not from
   *  what the model proposed, so it can never claim a change that did not land. */
  applied: AppliedChanges;
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
  try {
    return await dreamInto(workspace, opts, now, phase);
  } catch (err) {
    // `memory lint` runs on every session end, so leaking a full wiki copy per failure (a
    // malformed pins.json is enough) would quietly fill the disk
    await workspace.dispose().catch(() => {});
    throw err;
  }
}

async function dreamInto(
  workspace: DreamWorkspace,
  opts: DreamOptions,
  now: () => number,
  phase: (p: string) => void,
): Promise<FullDreamResult> {
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
  const allAttempts: Attempt[] =
    "readAttempts" in opts.raw
      ? (await (opts.raw as { readAttempts: () => Promise<{ attempts: Attempt[] }> }).readAttempts()).attempts
      : [];
  // `since` has to actually filter something. It previously reached only a log line: attempts —
  // the material signals are built from — were read unfiltered and uncapped, so `.last-dream`
  // and `--since` changed nothing about what the dream considered.
  const scoped = since === undefined ? allAttempts : allAttempts.filter((a) => a.ts > since);
  const attempts = scoped.slice(-maxSessions * 10);
  const signals = gatherFromAttempts(attempts);

  // ---- structural lint (free, no model)
  phase("lint");
  const pages = (await out.pages()).filter((p) => p.path !== OVERVIEW_FILE);
  const structural = await structuralLint(pages, index, opts.cwd === undefined ? {} : { cwd: opts.cwd });

  // ---- phase 3: consolidate (the only phase that costs tokens)
  phase("consolidate");
  let consolidationError: string | undefined;
  const consolidation: Consolidation =
    opts.structuralOnly === true || pages.length === 0 || opts.provider === undefined
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

  // ---- apply: edit the dreamt pages. Without this the "corrected wiki" would be identical to
  // the input and the report would describe changes nobody made.
  phase("apply");
  const applied = await applyConsolidation(out, consolidation, {
    today: new Date(now()).toISOString().slice(0, 10),
    structural,
  });

  // ---- phase 4: prune & index, then re-check pins against the dreamt text
  phase("prune");
  // re-read: applyConsolidation rewrote bodies and deleted merged-away pages, and the index has
  // to describe the wiki as it now stands rather than as it was found
  const finalPages = (await out.pages()).filter((p) => p.path !== OVERVIEW_FILE);
  await out.writeIndex(rebuildIndex(finalPages, index));
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

  // built from `applied`, never from `consolidation`: the report describes the artifact
  const mergedInto = new Map<string, string[]>();
  for (const m of applied.mergedPages) mergedInto.set(m.into, [...(mergedInto.get(m.into) ?? []), m.from]);

  const report: DreamReport = {
    contradictions: consolidation.contradictions,
    superseded: applied.supersededMarked.map((s) => {
      const found = consolidation.superseded.find((x) => x.page === s.page && x.old === s.old);
      return { page: s.page, old: s.old, new: found?.new ?? "", source: found?.source ?? "" };
    }),
    orphans: structural.orphans,
    missingPages: structural.missingPages,
    merged: [...mergedInto.entries()].map(([to, from]) => ({ from: [...from, to], to })),
    removed: applied.removedLines.map((r) => {
      const found = consolidation.removed.find((x) => x.page === r.page);
      return { page: r.page, line: r.line, reason: found?.reason ?? "" };
    }),
    promoted,
    pinsAffected: pinChecks.map((c) => ({ pin: `${c.pin.page}: ${c.pin.claim}`, status: c.status })),
  };

  await out.appendLog(
    `${new Date(now()).toISOString()} | dream | ${sessions.length} session(s) since last | ` +
      `${report.contradictions.length} contradiction(s), ${report.orphans.length} orphan(s), ` +
      `${report.missingPages.length} missing page(s)`,
  );
  await markDreamed(workspace.outputRoot, now());
  // ALSO stamp the live wiki. The stamp answers "when was a dream last run", not "last
  // applied" — writing it only into the copy meant review mode never advanced it, so a
  // scheduled trigger stayed permanently due and re-dreamt on every single session end,
  // spending consolidate-phase tokens and leaking a wiki copy each time. This is the one
  // write a dream makes to its input, and it is metadata about the dream, not wiki content.
  await markDreamed(opts.wiki.root, now()).catch(() => {});

  return {
    outputRoot: workspace.outputRoot,
    report,
    ...(consolidationError === undefined ? {} : { consolidationError }),
    applied,
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
