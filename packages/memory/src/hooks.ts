import { stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { AuxiliaryReport, Hook, HookContext, HookResult, ModelProvider } from "@agentkitai/agentrig-core";
import { FileMemoryStore } from "./store.js";
import { FileRawStore } from "./raw.js";
import { ingestSession, type IngestLimits } from "./ingest.js";
import { formatAuxiliaryUsage, maintenanceDiagnostic, type MaintenanceLimits } from "./maintenance.js";
import { lastDreamAt, runDream } from "./dream/dream.js";
import { findingCount } from "./dream/report.js";
import type { MemoryBackend } from "./backend.js";
import type { ScanLimits } from "./scan.js";

/**
 * The `session_end` integrations PLAN §3.2 and §3.7 both specify and which M3 and M5 each left
 * as a caveat: "triggered by the `session_end` hook" (ingest) and "`session_end` hook when ≥ N
 * sessions or ≥ T hours since the last dream".
 *
 * Both are deliberately **advisory**. A session that finished its work has finished it; a failed
 * ingest or a failed dream must not change that, and must not make the harness feel slower than
 * it is. So both report through `onError` and return `continue` regardless. Dream also forwards
 * non-fatal maintenance warnings through this diagnostic channel.
 */

export interface SessionEndIngestOptions {
  /** `.agentrig` directory. */
  dir: string;
  provider: ModelProvider;
  backend?: MemoryBackend;
  onError?: (err: Error) => void;
  onDone?: (summary: string) => void;
  onUsage?: (report: AuxiliaryReport) => void;
  onBackendError?: (operation: string, error: Error) => void;
  limits?: Partial<IngestLimits>;
  maxSpanChars?: number;
  maxTokens?: number;
}

/** Distils the session that just ended into the wiki. */
export function ingestOnSessionEnd(opts: SessionEndIngestOptions): Hook {
  return {
    point: "session_end",
    id: "memory:ingest",
    // ingest is a multi-call distillation over a whole transcript; the default 30s is too tight
    // Outer hook timeout includes cleanup headroom; it is not the model-work budget.
    timeoutMs: Math.min(2_147_483_647, Math.max(10 * 60_000, (opts.limits?.timeoutMs ?? 300_000) + 60_000)),
    handler: async (ctx: HookContext): Promise<HookResult> => {
      let auxiliary: AuxiliaryReport | undefined;
      try {
        // defence in depth: core validates session ids, but this hook builds a path from one and
        // must not depend on a caller upstream having done the right thing
        const sessionDir = resolve(join(opts.dir, "raw", "sessions"));
        const logPath = resolve(join(sessionDir, `${ctx.sessionId}.jsonl`));
        if (logPath !== sessionDir && !logPath.startsWith(sessionDir + sep)) {
          opts.onError?.(new Error(`refusing to ingest a session log outside ${sessionDir}: ${ctx.sessionId}`));
          return { action: "continue" };
        }
        // a session that never wrote a log (an immediate error) has nothing to distil
        const exists = await stat(logPath).then(
          () => true,
          () => false,
        );
        if (!exists) return { action: "continue" };

        if (ctx.signal.aborted) return { action: "continue" };
        const store = new FileMemoryStore({ root: join(opts.dir, "wiki") });
        const result = await ingestSession({
          store,
          provider: opts.provider,
          sessionId: ctx.sessionId,
          logPath,
          signal: ctx.signal,
          ...(opts.limits === undefined ? {} : { limits: opts.limits }),
          ...(opts.maxSpanChars === undefined ? {} : { maxSpanChars: opts.maxSpanChars }),
          ...(opts.maxTokens === undefined ? {} : { maxTokens: opts.maxTokens }),
          ...(opts.onBackendError === undefined ? {} : { onBackendError: opts.onBackendError }),
          onUsage: report => {
            auxiliary = report;
            opts.onUsage?.(report);
          },
          ...(opts.backend === undefined ? {} : { backend: opts.backend }),
        });
        opts.onDone?.(`ingested ${result.factCount} fact(s) into ${result.pagesWritten.length} page(s)` +
          (result.omissions.length === 0 ? "" : `; ${result.omissions.length} uninspected evidence omission(s), see source-page coverage`));
      } catch (err) {
        opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      } finally {
        try { if (auxiliary !== undefined) opts.onDone?.(formatAuxiliaryUsage(auxiliary)); } catch { /* accounting is diagnostic */ }
      }
      return { action: "continue" };
    },
  };
}

export interface DreamTriggerOptions {
  limits?: Partial<MaintenanceLimits>;
  onUsage?: (report: AuxiliaryReport) => void;
  scanLimits?: Partial<ScanLimits>;
  dir: string;
  provider?: ModelProvider;
  /** Sessions ingested since the last dream before one is due. PLAN §3.7's "≥ N sessions". */
  everySessions?: number;
  /** Hours since the last dream before one is due. PLAN §3.7's "≥ T hours". */
  everyHours?: number;
  /**
   * Whether a triggered dream applies itself. Default false, matching PLAN §1.5: review is the
   * default because a dream is a bulk rewrite of the agent's memory. An automatic dream that
   * applied itself would be the least reviewable thing in the system.
   */
  auto?: boolean;
  /**
   * Skip the model-backed consolidation, keeping the trigger free. The scheduled trigger is
   * unattended, so this is the safer setting for it — see the CLI's `--dream-structural-only`.
   */
  structuralOnly?: boolean;
  /** Wait for snapshot/apply mutation locks; not a full dream deadline. */
  lockTimeoutMs?: number;
  onError?: (err: Error) => void;
  onDone?: (summary: string) => void;
  now?: () => number;
}

/**
 * PLAN §3.7's scheduled trigger. Returns `continue` always — a dream is maintenance, and
 * maintenance must never be able to fail a session that succeeded.
 */
export function dreamOnSessionEnd(opts: DreamTriggerOptions): Hook {
  const everySessions = opts.everySessions ?? 10;
  const everyHours = opts.everyHours ?? 24;
  const now = opts.now ?? (() => Date.now());
  const done = (summary: string): void => {
    // Preserve synchronous error reporting; also observe async callback failures without waiting.
    const pending = opts.onDone?.(summary);
    void Promise.resolve(pending).catch(error => maintenanceDiagnostic(() => opts.onError?.(error instanceof Error ? error : new Error(String(error)))));
  };

  return {
    point: "session_end",
    id: "memory:dream",
    timeoutMs: Math.min(2_147_483_647, Math.max(15 * 60_000, (opts.limits?.timeoutMs ?? 300_000) + 60_000)),
    handler: async (ctx: HookContext): Promise<HookResult> => {
      try {
        ctx.signal.throwIfAborted();
        const wikiRoot = join(opts.dir, "wiki");
        const since = await lastDreamAt(wikiRoot, { signal: ctx.signal });
        const raw = new FileRawStore({ root: opts.dir });
        const sessionsSince = (await raw.sessions(since, { scanLimits: opts.scanLimits ?? {}, signal: ctx.signal })).length;
        // A wiki that has never been dreamt is NOT immediately overdue — treating it that way
        // made the first session end trigger a full dream regardless of the configured cadence.
        // The session count is the honest signal for a fresh wiki.
        const hoursSince = since === undefined ? 0 : (now() - since) / 3_600_000;

        if (sessionsSince < everySessions && hoursSince < everyHours) return { action: "continue" };

        const store = new FileMemoryStore({ root: wikiRoot, lockTimeoutMs: opts.lockTimeoutMs ?? 5000 });
        await store.init();
        const result = await runDream({
          wiki: store,
          signal: ctx.signal,
          autoApply: opts.auto === true,
          limits: opts.limits ?? {},
          ...(opts.onUsage === undefined ? {} : { onUsage: opts.onUsage }),
          raw,
          ...(opts.provider === undefined ? {} : { provider: opts.provider }),
          ...(opts.structuralOnly === true || opts.provider === undefined ? { structuralOnly: true } : {}),
          now,
          lockTimeoutMs: opts.lockTimeoutMs ?? 5000,
          scanLimits: opts.scanLimits ?? {},
          ...(opts.onError === undefined ? {} : { onError: opts.onError }),
        });

        const findings = findingCount(result.report, result.structural);
        const dispose = async (): Promise<boolean> => {
          try { await result.workspace.dispose(); return true; }
          catch (error) {
            const warning = new Error(`dream ${result.autoApply?.status === "applied" ? "was applied; " : ""}cleanup failed; inspect ${result.outputRoot}; manifest: ${result.workspace.manifestPath}; ${String(error)}`);
            maintenanceDiagnostic(() => opts.onError === undefined ? process.emitWarning(warning.message) : opts.onError(warning));
            return false;
          }
        };
        if (result.autoApply?.status === "refused") {
          // A persistent immutable-ledger fault must not retain a fresh wiki every cadence.
          // No usable consolidation ran; explicit review commands can retain an inspectable copy.
          const disposed = await dispose();
          const unreadable = result.report.scan?.unreadableAttempts ?? [];
          done(`dream ${result.autoApply.reason}; auto-apply disabled; temporary copy ${disposed ? "discarded" : "retained at " + result.outputRoot}; unreadable attempts: `
            + unreadable.slice(0, 20).join(", ")
            + (unreadable.length > 20 ? "; more entries omitted from this summary" : "")
            + "; run an explicit dream review to retain an artifact");
          return { action: "continue" };
        }
        if (result.autoApply?.status === "applied") {
          await dispose();
          done(`dream applied (${findings} finding(s)); previous wiki kept at ${result.autoApply.backup}`);
        } else if (findings === 0 && result.consolidationError === undefined) {
          // nothing to look at, so nothing to keep: a clean dream that left a full wiki copy in
          // /tmp on every trigger is how an unattended maintenance task fills a disk
          const disposed = await dispose();
          done("dream ran clean; nothing to review" + (disposed ? "" : `; cleanup pending at ${result.outputRoot}`));
        } else {
          done(
            `${result.report.scan?.complete === false ? "dream raw scan incomplete; auto-apply disabled; " : ""}dream found ${findings} thing(s) to review: inspect ${result.outputRoot} (manifest: ${result.workspace.manifestPath}); agentrig dream --review runs a fresh review`,
          );
        }
      } catch (err) {
        maintenanceDiagnostic(() => opts.onError?.(err instanceof Error ? err : new Error(String(err))));
      }
      return { action: "continue" };
    },
  };
}
