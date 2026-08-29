import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  FileMemoryStore,
  FileRawStore,
  applyDream,
  findingCount,
  renderReport,
  runDream,
} from "@agentkitai/agentrig-memory";
import { buildProvider, type ProviderOptions } from "./provider.js";

/**
 * `agentrig dream` — PLAN §3.7/§5. Thin: every decision lives in the memory package, this
 * chooses a mode and prints.
 */
export interface DreamOptions extends ProviderOptions {
  dir: string;
  auto?: boolean;
  review?: boolean;
  scope: string;
  since?: string;
  structuralOnly?: boolean;
  keep?: boolean;
  modelExplicit?: boolean;
}

export async function dreamCommand(opts: DreamOptions): Promise<void> {
  const scope = opts.scope === "global" ? "global" : "project";
  const wikiRoot = join(opts.dir, "wiki");
  const wiki = new FileMemoryStore({ root: wikiRoot, scope });
  await wiki.init();

  // `auto` is opt-in: PLAN §1.5 makes review the default because a dream is a bulk LLM rewrite
  // of the agent's memory, and the artifact has to be inspectable before it becomes the truth
  const auto = opts.auto === true && opts.review !== true;

  let provider;
  try {
    // a structural-only dream never calls the model, so it must not require a credential either
    provider = opts.structuralOnly === true ? undefined : buildProvider(opts);
  } catch (err) {
    console.error(`${(err as Error).message}\n(run with --structural-only for the free, model-free pass)`);
    process.exitCode = 1;
    return;
  }

  const result = await runDream({
    wiki,
    raw: new FileRawStore({ root: opts.dir }),
    // the provider is only reached when structuralOnly is false, which is exactly when it is set
    provider: provider as NonNullable<typeof provider>,
    cwd: process.cwd(),
    ...(opts.structuralOnly === true ? { structuralOnly: true } : {}),
    ...(opts.since === undefined ? {} : { maxSessions: Number(opts.since) }),
    onPhase: (p) => console.error(`… ${p}`),
  });

  let applied = false;
  let backup: string | undefined;
  if (auto) {
    backup = await applyDream(wikiRoot, result.outputRoot, String(Date.now()));
    applied = true;
  }

  console.log(
    renderReport(result.report, {
      structural: result.structural,
      promotionRejected: result.promotionRejected,
      outputRoot: result.outputRoot,
      applied,
    }),
  );
  if (backup !== undefined) console.log(`previous wiki kept at ${backup}`);

  if (applied || opts.keep !== true) {
    // in review mode the copy is the whole deliverable, so it is kept unless applied
    if (applied) await rm(result.outputRoot, { recursive: true, force: true }).catch(() => {});
  }
  if (!applied) {
    console.log(`\nto accept: agentrig dream --auto   |   to discard: rm -rf ${result.outputRoot}`);
  }

  process.exitCode = findingCount(result.report, result.structural) > 0 && !applied ? 1 : 0;
}
