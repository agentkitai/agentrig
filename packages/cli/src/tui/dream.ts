import { join } from "node:path";
import type { AuxiliaryReport, ModelProvider } from "@agentkitai/agentrig-core";
import { FileMemoryStore, FileRawStore, findingCount, renderReport, runDream,
  type MaintenanceLimits, type ScanLimits } from "@agentkitai/agentrig-memory";

/** The interactive /dream callback, kept independently testable without mounting Ink. */
export function interactiveDream(opts: { dir: string; provider: ModelProvider; cwd: string; scanLimits?: Partial<ScanLimits>;
  limits?: Partial<MaintenanceLimits>; onUsage?: (report: AuxiliaryReport) => void; onError?: (error: Error) => void }) {
  return async (auto: boolean, signal?: AbortSignal): Promise<string[]> => {
    const wiki = new FileMemoryStore({ root: join(opts.dir, "wiki") }); await wiki.init();
    const scanLimits = opts.scanLimits ?? {};
    const result = await runDream({ wiki, raw: new FileRawStore({ root: opts.dir }),
      provider: opts.provider, cwd: opts.cwd, scanLimits, autoApply: auto, limits: opts.limits ?? {},
      ...(signal === undefined ? {} : { signal }), ...(opts.onUsage === undefined ? {} : { onUsage: opts.onUsage }),
      ...(opts.onError === undefined ? {} : { onError: opts.onError }) });
    const findings = findingCount(result.report, result.structural);
    if (result.autoApply?.status !== "applied") {
      return [renderReport(result.report, { structural: result.structural, promotionRejected: result.promotionRejected,
        outputRoot: result.outputRoot, applied: false }),
      ...(result.autoApply?.status === "refused" ? [`auto-apply refused: ${result.autoApply.reason}`] : []),
      `review artifact: ${result.outputRoot}; manifest: ${result.workspace.manifestPath}`,
      "keep both together; after review, preview agentrig memory discard-dream <outputRoot>, then confirm its owner UUID (SDK: workspace.dispose())",
      ...(result.report.scan?.complete === false ? ["resolve the reported unreadable attempts before retrying; do not delete immutable history"]
        : ["agentrig dream --auto runs and applies a fresh dream, not this saved artifact"])];
    }
    const lines = [`dream applied (${findings} finding(s)); previous wiki kept at ${result.autoApply.backup}`];
    await result.workspace.dispose().catch(error => lines.push(`dream cleanup failed; inspect ${result.outputRoot} and ${result.workspace.manifestPath}: ${String(error)}`));
    return lines;
  };
}
