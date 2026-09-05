import { join } from "node:path";
import type { ModelProvider } from "@agentkitai/agentrig-core";
import { applyDream, FileMemoryStore, FileRawStore, findingCount, renderReport, runDream,
  type ScanLimits } from "@agentkitai/agentrig-memory";

/** The interactive /dream callback, kept independently testable without mounting Ink. */
export function interactiveDream(opts: { dir: string; provider: ModelProvider; cwd: string; scanLimits?: Partial<ScanLimits> }) {
  return async (auto: boolean): Promise<string[]> => {
    const wiki = new FileMemoryStore({ root: join(opts.dir, "wiki") }); await wiki.init();
    const scanLimits = opts.scanLimits ?? {};
    const result = await runDream({ wiki, raw: new FileRawStore({ root: opts.dir }),
      provider: opts.provider, cwd: opts.cwd, scanLimits });
    const findings = findingCount(result.report, result.structural);
    if (!auto || result.report.scan?.complete === false) {
      return [renderReport(result.report, { structural: result.structural, promotionRejected: result.promotionRejected,
        outputRoot: result.outputRoot, applied: false }),
      ...(auto ? ["auto-apply refused: raw scan incomplete"] : []),
      `review artifact: ${result.outputRoot}; manifest: ${result.workspace.manifestPath}`,
      "keep both together; discard through workspace.dispose() only after review",
      ...(result.report.scan?.complete === false ? ["resolve the reported unreadable attempts before retrying; do not delete immutable history"]
        : ["agentrig dream --auto runs and applies a fresh dream, not this saved artifact"])];
    }
    let backup: string;
    try { backup = await applyDream(wiki.root, result.outputRoot, `${Date.now()}-tui`, { scanLimits }); }
    catch (error) { throw new Error(String(error) + "; dream artifact retained at " + result.outputRoot
      + "; manifest: " + result.workspace.manifestPath, { cause: error }); }
    await result.workspace.dispose().catch(() => {});
    return [`dream applied (${findings} finding(s)); previous wiki kept at ${backup}`];
  };
}
