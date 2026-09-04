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
import { buildRoleProvider, type ProviderOptions } from "./provider.js";

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
}

export async function dreamCommand(opts: DreamOptions): Promise<void> {
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
  const wiki = new FileMemoryStore({ root: wikiRoot, scope });
  await wiki.init();

  // Promotion proposals need somewhere to propose *to*. Without a global wiki the report's
  // promotion section could never render, which made "promotion to global" look implemented
  // when nothing could reach it.
  let globalWiki: FileMemoryStore | undefined;
  if (opts.global !== undefined) {
    globalWiki = new FileMemoryStore({ root: join(opts.global, "wiki"), scope: "global" });
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
      provider = buildRoleProvider(opts, opts.providerOverride === true ? "main" : "memory");
    }
  } catch (err) {
    console.error(`${(err as Error).message}\n(run with --structural-only for the free, model-free pass)`);
    process.exitCode = 1;
    return;
  }

  const result = await runDream({
    wiki,
    raw: new FileRawStore({ root: opts.dir }),
    ...(globalWiki === undefined ? {} : { globalWiki }),
    ...(provider === undefined ? {} : { provider }),
    cwd: process.cwd(),
    ...(opts.structuralOnly === true ? { structuralOnly: true } : {}),
    ...(sinceCap === undefined ? {} : { maxSessions: sinceCap }),
    onPhase: (p) => console.error(`… ${p}`),
  });

  let applied = false;
  let backup: string | undefined;
  if (auto) {
    try {
      backup = await applyDream(wikiRoot, result.outputRoot, String(Date.now()));
      applied = true;
    } catch (err) {
      // applyDream's message names the directory the wiki is actually in when a restore failed;
      // it is the only thing that will tell the user, so it must not be swallowed here
      console.error(`\n${(err as Error).message}`);
      console.error(`the dreamt wiki is still at ${result.outputRoot}`);
      process.exitCode = 1;
      return;
    }
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

  // in review mode the copy IS the deliverable, so it is kept for inspection; once applied it
  // has been copied into place and the temp copy is redundant
  if (applied) await result.workspace.dispose().catch(() => {});
  if (!applied) {
    console.log(`\nto accept: agentrig dream --auto   |   to discard: rm -rf ${result.outputRoot}`);
  }

  process.exitCode = findingCount(result.report, result.structural) > 0 && !applied ? 1 : 0;
}
