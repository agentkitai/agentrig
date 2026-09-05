import { join } from "node:path";
import {
  FileMemoryStore,
  FileRawStore,
  formatAuxiliaryUsage,
  findingCount,
  renderReport,
  runDream,
  type ScanLimits,
  type MaintenanceLimits,
} from "@agentkitai/agentrig-memory";
import { buildRoleProvider, memoryRole, type ProviderOptions } from "./provider.js";
import { withMaintenanceSignal } from "./maintenance.js";

/**
 * `agentrig dream` — PLAN §3.7/§5. Thin: every decision lives in the memory package, this
 * chooses a mode and prints.
 */
export interface DreamOptions extends ProviderOptions {
  dir: string;
  auto?: boolean;
  review?: boolean;
  scope: string;
  global?: string;
  since?: string;
  structuralOnly?: boolean;
  modelExplicit?: boolean;
  lockTimeout?: string;
  dreamScanLimits?: Partial<ScanLimits>;
  dreamLimits?: Partial<MaintenanceLimits>;
  signal?: AbortSignal;
}

export async function dreamCommand(opts: DreamOptions): Promise<void> {
  return withMaintenanceSignal(signal => dreamWithSignal(opts, signal), opts.signal);
}

async function dreamWithSignal(opts: DreamOptions, signal: AbortSignal): Promise<void> {
  const lockTimeoutMs = opts.lockTimeout === undefined ? 5000 : Number(opts.lockTimeout);
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 0 || lockTimeoutMs > 2_147_483_647) {
    console.error("--lock-timeout must be an integer from 0 to 2147483647 milliseconds");
    process.exitCode = 1;
    return;
  }
  let sinceCap: number | undefined;
  if (opts.since !== undefined) {
    sinceCap = Number(opts.since);
    if (!Number.isInteger(sinceCap) || sinceCap <= 0) {
      // Number("abc") is NaN and slice(0, NaN) silently yields nothing, so an unvalidated
      // --since quietly turned the dream into a no-op
      console.error(`--since must be a positive integer, got "${opts.since}"`);
      process.exitCode = 1;
      return;
    }
  }

  const scope = opts.scope === "global" ? "global" : "project";
  const wikiRoot = join(opts.dir, "wiki");
  const wiki = new FileMemoryStore({ root: wikiRoot, scope, lockTimeoutMs });
  await wiki.init();

  // Promotion proposals need somewhere to propose *to*. Without a global wiki the report's
  // promotion section could never render, which made "promotion to global" look implemented
  // when nothing could reach it.
  let globalWiki: FileMemoryStore | undefined;
  if (opts.global !== undefined) {
    globalWiki = new FileMemoryStore({ root: join(opts.global, "wiki"), scope: "global", lockTimeoutMs });
    await globalWiki.init();
  }

  // `auto` is opt-in: PLAN §1.5 makes review the default because a dream is a bulk LLM rewrite
  // of the agent's memory, and the artifact has to be inspectable before it becomes the truth
  const auto = opts.auto === true && opts.review !== true;

  let provider;
  try {
    // a structural-only dream never calls the model, so it must not require a credential either
    if (opts.structuralOnly === true) {
      provider = undefined;
    } else {
      // typed provider flags pin main to the flat default entry; otherwise the memory role. Only
      // that one entry is constructed — a dream must not fail on a credential some other role needs.
      provider = buildRoleProvider(opts, memoryRole(opts));
    }
  } catch (err) {
    console.error(`${(err as Error).message}\n(run with --structural-only for the free, model-free pass)`);
    process.exitCode = 1;
    return;
  }

  const result = await runDream({
    wiki,
    signal,
    autoApply: auto,
    limits: opts.dreamLimits ?? {},
    onUsage: report => console.error(formatAuxiliaryUsage(report)),
    lockTimeoutMs,
    scanLimits: opts.dreamScanLimits ?? {},
    raw: new FileRawStore({ root: opts.dir }),
    ...(globalWiki === undefined ? {} : { globalWiki }),
    ...(provider === undefined ? {} : { provider }),
    cwd: process.cwd(),
    ...(opts.structuralOnly === true ? { structuralOnly: true } : {}),
    ...(sinceCap === undefined ? {} : { maxSessions: sinceCap }),
    onPhase: (p) => console.error(`… ${p}`),
    onError: error => console.error(`dream warning: ${error.message}`),
  });

  const applied = result.autoApply?.status === "applied";
  const backup = result.autoApply?.status === "applied" ? result.autoApply.backup : undefined;
  if (result.autoApply?.status === "refused") console.error(`auto-apply refused: ${result.autoApply.reason}; review artifact retained`);

  console.log(
    renderReport(result.report, {
      structural: result.structural,
      promotionRejected: result.promotionRejected,
      outputRoot: result.outputRoot,
      applied,
    }),
  );
  if (backup !== undefined) console.log(`previous wiki kept at ${backup}`);

  // in review mode the copy IS the deliverable, so it is kept for inspection; once applied it
  // has been copied into place and the temp copy is redundant
  if (applied) await result.workspace.dispose().catch(error => console.error(`dream cleanup failed; inspect ${result.outputRoot} and ${result.workspace.manifestPath}: ${String(error)}`));
  if (!applied) {
    console.log(result.report.scan?.complete === false
      ? "\nresolve the reported unreadable attempts before retrying; do not delete immutable history"
      : "\nto run and apply a fresh dream: agentrig dream --auto");
    console.log(`review artifact: ${result.outputRoot}\nmanifest: ${result.workspace.manifestPath}`);
    console.log("keep both together; after review, preview agentrig memory discard-dream <outputRoot>, then confirm its owner UUID (SDK: workspace.dispose())");
  }

  process.exitCode = !applied && (findingCount(result.report, result.structural) > 0 || result.consolidationError !== undefined) ? 1 : 0;
}
