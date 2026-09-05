import { rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { AuxiliaryReport } from "@agentkitai/agentrig-core";
import type { Attempt, DreamInput, DreamReport, DreamResult, Dreamer } from "../types.js";
import { FileMemoryStore, OVERVIEW_FILE } from "../store.js";
import { readPins, recheckPins, applyPinChecks } from "../pins.js";
import { applyDream, copyWiki, type DreamWorkspace } from "./copy.js";
import { structuralLint, type StructuralFindings } from "./lint.js";
import {
  consolidate,
  gatherFromAttempts,
  orient,
  rebuildIndex,
  type Consolidation,
  type Signal,
} from "./phases.js";
import { selectForPromotion, sessionEvidence, type PromotionRejection } from "./promote.js";
import { loadPromotionEvidence } from "./evidence.js";
import { applyConsolidation, type AppliedChanges } from "./apply.js";
import { SCHEMA_MD } from "../ingest.js";
import { withMemoryLock, type MemoryLockOptions } from "../lock.js";
import { readBoundedFile } from "../bounded-file.js";
import { ScanBudget, type ScanOptions } from "../scan.js";
import { DEFAULT_DREAM_LIMITS, MaintenanceRun, MaintenanceLimitError, maintenanceDiagnostic, positiveLimit, type MaintenanceLimits } from "../maintenance.js";

export const LAST_DREAM_FILE = ".last-dream";
const limit = z.number().int().positive().max(2_147_483_647);
export const DreamLimitsSchema = z.object({ timeoutMs: limit, callTimeoutMs: limit, maxCalls: limit,
  maxInputChars: limit, maxOutputChars: limit, maxModelEvents: limit } satisfies Record<keyof MaintenanceLimits, typeof limit>).partial().strict();

export interface DreamOptions extends Omit<DreamInput, "provider">, ScanOptions {
  limits?: Partial<MaintenanceLimits>;
  /** Runs guarded apply within the same deadline. Incomplete/failed consolidation is refused. */
  autoApply?: boolean;
  /** Delivered on success and failure; throwing cannot alter the operation's outcome. */
  onUsage?: (report: AuxiliaryReport) => void;
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
  /** Lock-acquisition wait only, not a bound on scan duration. Default 5 seconds. */
  lockTimeoutMs?: number;
  /** Root that fact-line file references are resolved against, for the stale-ref check. */
  cwd?: string;
  minSessionsToPromote?: number;
  now?: () => number;
  /** Skips the model-backed consolidation pass — the free, structural-only dream. */
  structuralOnly?: boolean;
  onPhase?: (phase: string) => void;
  /** Advisory warnings, including consolidation failure and skipped pin persistence; not fatal. */
  onError?: (err: Error) => void;
}

/** The report plus the structural findings, which `DreamReport` has no field for on its own. */
export interface FullDreamResult extends DreamResult {
  autoApply?: { status: "applied"; backup: string } | { status: "refused"; reason: string };
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

async function readOr(root: string, file: string, fallback = "", opts: ScanOptions = {}): Promise<string> {
  const budget = new ScanBudget(opts);
  return budget.read(join(root, file)).then(bytes => bytes.toString("utf8")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return fallback;
    throw error;
  });
}

/** Timestamp of the last dream, so "raw sources since last dream" means something. */
export async function lastDreamAt(wikiRoot: string, opts: MemoryLockOptions = {}): Promise<number | undefined> {
  const raw = await readBoundedFile(join(wikiRoot, LAST_DREAM_FILE), opts.maxFileBytes ?? 4096, opts.signal)
    .then(bytes => bytes.toString("utf8")).catch((error: NodeJS.ErrnoException) => {
      opts.signal?.throwIfAborted();
      if (error.code === "ENOENT") return "";
      throw error;
    });
  opts.signal?.throwIfAborted();
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export async function markDreamed(wikiRoot: string, at: number, opts: MemoryLockOptions = {}): Promise<void> {
  if (!Number.isFinite(at) || at < 0) throw new Error("invalid dream timestamp");
  await withMemoryLock(wikiRoot, async () => {
    const previous = await lastDreamAt(wikiRoot, opts);
    if (previous !== undefined && previous >= at) return;
    const path = join(wikiRoot, LAST_DREAM_FILE);
    const temp = path + "." + randomUUID() + ".tmp";
    try {
      opts.signal?.throwIfAborted();
      await writeFile(temp, `${at}\n`, { flag: "wx", mode: 0o600 });
      opts.signal?.throwIfAborted();
      await rename(temp, path);
    } finally { await rm(temp, { force: true }).catch(() => {}); }
  }, opts);
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
  DreamLimitsSchema.parse(opts.limits ?? {});
  const run = new MaintenanceRun("dream", { ...DEFAULT_DREAM_LIMITS, ...opts.limits }, opts.signal);
  const warning = (error: Error): void => {
    maintenanceDiagnostic(() => opts.onError === undefined ? process.emitWarning(error.message) : opts.onError(error));
  };
  const bounded = { ...opts, signal: run.signal, onError: warning };
  let workspace: DreamWorkspace | undefined; let result: FullDreamResult | undefined;
  let failure: unknown; let retain = false;
  run.localCommitState = "not-started";
  try {
    new ScanBudget(bounded); positiveLimit("maxSessions", opts.maxSessions ?? 100); run.check();
    const now = opts.now ?? (() => Date.now());
    const phase = (p: string): void => { run.check(); opts.onPhase?.(p); run.check(); };
    run.localCommitState = "may-be-partial";
    workspace = await copyWiki(opts.wiki.root, opts.outputRoot, { ...bounded, timeoutMs: opts.lockTimeoutMs ?? 5000 });
    result = await dreamInto(workspace, bounded, now, phase, run);
    run.check();
    if (opts.autoApply === true) {
      if (result.report.scan?.complete === false || result.consolidationError !== undefined) {
        result.autoApply = { status: "refused", reason: result.report.scan?.complete === false ? "raw scan incomplete" : "model consolidation failed" };
      } else {
        retain = true; phase("install");
        const backup = await applyDream(opts.wiki.root, workspace.outputRoot, `${now()}-${randomUUID()}`, {
          ...bounded, timeoutMs: opts.lockTimeoutMs ?? 5000,
        });
        // No abort check after a committed live swap: late cancellation cannot undo this result.
        result.autoApply = { status: "applied", backup };
      }
    }
    run.localCommitState = "completed";
    return result;
  } catch (err) {
    failure = err ?? new Error(String(err));
    if (workspace !== undefined) {
      if (retain) {
        const retained = new Error(String(err) + "; dream artifact retained at " + workspace.outputRoot
          + "; manifest: " + workspace.manifestPath, { cause: err });
        retained.name = err instanceof Error ? err.name : "Error";
        throw retained;
      }
      await workspace.dispose().catch(cleanup => warning(new Error("dream cleanup failed; inspect " + workspace!.outputRoot
        + "; manifest: " + workspace!.manifestPath + "; " + String(cleanup))));
    }
    throw err;
  } finally {
    const report = run.finish(failure ?? (result?.consolidationError === undefined ? undefined : new Error(result.consolidationError)));
    if (result !== undefined) result.auxiliary = report;
    maintenanceDiagnostic(() => opts.onUsage?.(structuredClone(report)));
  }
}

async function dreamInto(
  workspace: DreamWorkspace,
  opts: DreamOptions,
  now: () => number,
  phase: (p: string) => void,
  run: MaintenanceRun,
): Promise<FullDreamResult> {
  const scan = new ScanBudget(opts);
  const readOpts = { maxFileBytes: scan.limits.maxFileBytes, timeoutMs: opts.lockTimeoutMs ?? 5000, ...(opts.signal === undefined ? {} : { signal: opts.signal }) };
  // concretely a FileMemoryStore, not the MemoryStore interface: the dream needs `pages()` and
  // `writeIndex()`, which are implementation surface rather than part of the read/write contract
  const out = new FileMemoryStore({ root: workspace.outputRoot, scope: opts.wiki.scope, lockTimeoutMs: opts.lockTimeoutMs ?? 5000 });

  // ---- phase 1: orient
  phase("orient");
  const index = await out.index(readOpts);
  const schema = await readOr(workspace.outputRoot, "SCHEMA.md", SCHEMA_MD, opts);
  const overviewPage = await out.read(OVERVIEW_FILE, readOpts);
  const orientation = orient(index, schema, overviewPage?.body ?? "");

  // ---- phase 2: gather signal
  phase("gather");
  const since = await lastDreamAt(workspace.outputRoot, { ...readOpts, maxFileBytes: Math.min(4096, readOpts.maxFileBytes) });
  const maxSessions = opts.maxSessions ?? 100;
  const available = await opts.raw.sessions(since, opts);
  if (available.length > scan.limits.maxEntries) throw new MaintenanceLimitError("raw session entry limit exceeded");
  const sessions = available.slice(0, maxSessions);
  const ledger =
    "readAttempts" in opts.raw
      ? await (opts.raw as { readAttempts: (id?: string, limits?: { signal: AbortSignal; maxEntries: number; maxFileBytes: number; maxTotalBytes: number }) => Promise<{ attempts: Attempt[]; corrupt?: string[] }> })
        .readAttempts(undefined, { signal: opts.signal ?? new AbortController().signal,
          maxEntries: scan.limits.maxEntries, maxFileBytes: scan.limits.maxFileBytes, maxTotalBytes: scan.limits.maxTotalBytes })
      : { attempts: [] };
  const allAttempts = ledger.attempts;
  if (allAttempts.length > scan.limits.maxEntries) throw new MaintenanceLimitError("attempt ledger entry limit exceeded");
  const unreadableAttempts = ledger.corrupt ?? [];
  if (allAttempts.length + unreadableAttempts.length > scan.limits.maxEntries) throw new MaintenanceLimitError("attempt ledger entry limit exceeded");
  if (unreadableAttempts.length > 0) {
    const warning = new Error(`dream raw scan incomplete: ${unreadableAttempts.length} unreadable or corrupt attempt ledger entries; model consolidation and auto-apply are disabled`);
    if (opts.onError !== undefined) opts.onError(warning); else process.emitWarning(warning.message);
  }
  // `since` has to actually filter something. It previously reached only a log line: attempts —
  // the material signals are built from — were read unfiltered and uncapped, so `.last-dream`
  // and `--since` changed nothing about what the dream considered.
  const scoped = since === undefined ? allAttempts : allAttempts.filter((a) => a.ts > since);
  const attempts = scoped.slice(-maxSessions * 10);
  const signals = gatherFromAttempts(attempts);

  // ---- structural lint (free, no model)
  phase("lint");
  const pages = (await out.pages(opts)).filter((p) => p.path !== OVERVIEW_FILE);
  const structural = await structuralLint(pages, index, { ...opts });

  // ---- phase 3: consolidate (the only phase that costs tokens)
  phase("consolidate");
  let consolidationError: string | undefined;
  const consolidation: Consolidation =
    opts.structuralOnly === true || unreadableAttempts.length > 0 || pages.length === 0 || opts.provider === undefined
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
        }, run);

  // ---- apply: edit the dreamt pages. Without this the "corrected wiki" would be identical to
  // the input and the report would describe changes nobody made.
  phase("apply");
  const applied = await applyConsolidation(out, consolidation, {
    ...opts,
    timeoutMs: opts.lockTimeoutMs ?? 5000,
    today: new Date(now()).toISOString().slice(0, 10),
    structural,
  });

  // ---- phase 4: prune & index, then re-check pins against the dreamt text
  phase("prune");
  // re-read: applyConsolidation rewrote bodies and deleted merged-away pages, and the index has
  // to describe the wiki as it now stands rather than as it was found
  const finalPages = (await out.pages(opts)).filter((p) => p.path !== OVERVIEW_FILE);
  await out.writeIndex(rebuildIndex(finalPages, index), readOpts);
  const pinOpts = { ...readOpts, scanBudget: new ScanBudget(opts) };
  const pins = await readPins(workspace.outputRoot, pinOpts);
  const pinChecks = await recheckPins(out, pins, pinOpts);
  const persistedPins = await applyPinChecks(out, pinChecks, pinOpts);
  if (persistedPins.skipped > 0) opts.onError?.(new Error(`dream inspected pins but skipped ${persistedPins.skipped} status check(s): page/pin changed, pin removed, or check unversioned`));

  // ---- promotion proposals: validate final pages against immutable runtime observations.
  const evidenceIndex = await loadPromotionEvidence(opts.raw,
    finalPages.flatMap(page => sessionEvidence(page).map(ref => ref.slice("session:".length))),
    { scanLimits: scan.limits, ...(opts.signal === undefined ? {} : { signal: opts.signal }) });
  const { promote, rejected } = selectForPromotion(
    finalPages,
    { evidenceIndex, ...(opts.minSessionsToPromote === undefined ? {} : { minSessions: opts.minSessionsToPromote }) },
  );
  // with no global wiki attached there is nowhere to promote *to*, so propose nothing
  const promoted = opts.globalWiki === undefined ? [] : promote;

  // built from `applied`, never from `consolidation`: the report describes the artifact
  const mergedInto = new Map<string, string[]>();
  for (const m of applied.mergedPages) mergedInto.set(m.into, [...(mergedInto.get(m.into) ?? []), m.from]);

  const report: DreamReport = {
    scan: { complete: unreadableAttempts.length === 0, unreadableAttempts },
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
    pinPersistence: persistedPins,
  };

  await out.appendLog(
    `${new Date(now()).toISOString()} | dream | ${sessions.length} session(s) since last | ` +
      `${report.contradictions.length} contradiction(s), ${report.orphans.length} orphan(s), ` +
      `${report.missingPages.length} missing page(s)` + (unreadableAttempts.length === 0 ? "" : ` | incomplete raw scan: ${unreadableAttempts.length} omitted attempt(s)`),
    readOpts,
  );
  run.check();
  const stampOpts = { ...readOpts, maxFileBytes: Math.min(4096, readOpts.maxFileBytes) };
  await markDreamed(workspace.outputRoot, now(), stampOpts);
  // ALSO stamp the live wiki. The stamp answers "when was a dream last run", not "last
  // applied" — writing it only into the copy meant review mode never advanced it, so a
  // scheduled trigger stayed permanently due and re-dreamt on every single session end,
  // spending consolidate-phase tokens and leaking a wiki copy each time. This is the one
  // write a dream makes to its input, and it is metadata about the dream, not wiki content.
  run.check();
  await markDreamed(opts.wiki.root, now(), stampOpts).catch(error => {
    run.check();
    const warning = new Error("dream scheduling stamp was not updated; the next session may trigger another dream: " + String(error), { cause: error });
    if (opts.onError !== undefined) opts.onError(warning);
    else process.emitWarning(warning.message);
  });

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
  constructor(private readonly opts: Omit<DreamOptions, keyof DreamInput | "autoApply"> = {}) {}
  async dream(input: DreamInput): Promise<DreamResult> {
    const { outputRoot, report, auxiliary } = await runDream({ ...this.opts, ...input, autoApply: false });
    return { outputRoot, report, ...(auxiliary === undefined ? {} : { auxiliary }) };
  }
}
