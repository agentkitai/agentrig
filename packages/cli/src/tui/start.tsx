import { render } from "ink";
import { createAgent, builtinTools, defaultRules, RulePolicy, SessionStore, type AnyTool } from "@agentkitai/agentrig-core";
import {
  FileMemoryStore,
  FileRawStore,
  indexInjection,
  memoryTools,
  runDream,
  findingCount,
  unionRetrieve,
} from "@agentkitai/agentrig-memory";
import { join } from "node:path";
import { App } from "./app.js";
import { TuiController } from "./controller.js";
import { buildProvider, type ProviderOptions } from "../provider.js";
import { openBackend } from "../memory.js";

export interface TuiOptions extends ProviderOptions {
  root: string;
  memory?: string;
  maxTurns: string;
  maxTokensPerTurn: string;
  modelExplicit?: boolean;
}

/**
 * `agentrig` with no subcommand (PLAN §5). Thin by design: it assembles the same agent
 * `agentrig run` does and hands it to the controller.
 */
export async function startTui(opts: TuiOptions): Promise<void> {
  if (process.stdin.isTTY !== true) {
    console.error("the TUI needs a terminal; use `agentrig run \"<task>\" --headless` for scripts");
    process.exitCode = 1;
    return;
  }

  let provider;
  try {
    provider = buildProvider(opts);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }

  let memoryIndex = "";
  let memoryToolset: AnyTool[] = [];
  let memoryStore: FileMemoryStore | undefined;
  if (opts.memory !== undefined) {
    memoryStore = new FileMemoryStore({ root: join(opts.memory, "wiki") });
    memoryIndex = await indexInjection(memoryStore).catch(() => "");
    const backend = openBackend();
    memoryToolset = memoryTools({
      store: memoryStore,
      raw: new FileRawStore({ root: opts.memory }),
      ...(backend === null ? {} : { backend }),
    });
  }

  const controller: TuiController = new TuiController({
    cwd: process.cwd(),
    agent: createAgent({
      provider,
      tools: [...builtinTools(), ...memoryToolset],
      permissions: new RulePolicy([
        ...(memoryToolset.length === 0
          ? []
          : [
              { tool: "memory_search", decision: "allow" as const },
              { tool: "memory_read", decision: "allow" as const },
            ]),
        ...defaultRules,
      ]),
      systemPrompt: (ctx) =>
        [
          "You are AgentRig, an autonomous software engineering agent.",
          `Working directory: ${ctx.cwd}`,
          "Use the available tools to complete the task. Verify your work before finishing.",
          memoryIndex,
        ]
          .filter((s) => s !== "")
          .join("\n"),
      store: new SessionStore({ root: opts.root }),
      budget: { maxTurns: Number(opts.maxTurns) },
      maxTokensPerTurn: Number(opts.maxTokensPerTurn),
      // the prompt is rendered by the TUI and resolved by a keypress
      onAsk: (req) => controller.ask(req),
    }),
    ...(memoryStore === undefined
      ? {}
      : {
          onMemory: async (query: string) => {
            const hits =
              query === ""
                ? (await memoryStore.index()).map((e) => `${e.path} — ${e.summary}`)
                : unionRetrieve(await memoryStore.index(), await memoryStore.pages(), query, 8).map(
                    (h) => `${h.page.path} — ${h.snippet}`,
                  );
            return hits.length === 0 ? ["(the wiki is empty)"] : hits;
          },
        }),
    ...(opts.memory === undefined
      ? {}
      : {
          onDream: async (auto: boolean) => {
            const wiki = new FileMemoryStore({ root: join(opts.memory!, "wiki") });
            await wiki.init();
            const result = await runDream({
              wiki,
              raw: new FileRawStore({ root: opts.memory! }),
              provider,
              cwd: process.cwd(),
            });
            const findings = findingCount(result.report, result.structural);
            if (!auto) {
              return [`dream found ${findings} thing(s); inspect ${result.outputRoot} or run agentrig dream --auto`];
            }
            const { applyDream } = await import("@agentkitai/agentrig-memory");
            const backup = await applyDream(join(opts.memory!, "wiki"), result.outputRoot, String(Date.now()));
            await result.workspace.dispose().catch(() => {});
            return [`dream applied (${findings} finding(s)); previous wiki kept at ${backup}`];
          },
        }),
  });

  controller.print("agentrig — type a task, or /help for commands", "system");
  const { waitUntilExit } = render(<App controller={controller} />);
  await waitUntilExit();
}
