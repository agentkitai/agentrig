import { render } from "ink";
import { join } from "node:path";
import {
  applyDream,
  FileMemoryStore,
  FileRawStore,
  findingCount,
  renderReport,
  runDream,
  unionRetrieve,
} from "@agentkitai/agentrig-memory";
import { App } from "./app.js";
import { TuiController } from "./controller.js";
import { buildAgent, type AgentBuildOptions } from "../agent-builder.js";
import { parseSoft, permissionWarning, supervisorOptions, type SupervisorFlags } from "../run.js";
import { parseBudget } from "../agent-builder.js";
import { supervise } from "@agentkitai/agentrig-supervisor";

export type TuiOptions = AgentBuildOptions & SupervisorFlags & { modelExplicit?: boolean };

/**
 * `agentrig` with no subcommand (PLAN §5). Thin by design: `buildAgent` assembles exactly the
 * agent `agentrig run` gets — same prompt, same permission rules, same session_end hooks, same
 * flag validation — so the two entry points cannot drift apart the way they did when this file
 * assembled its own.
 */
export async function startTui(opts: TuiOptions): Promise<void> {
  if (process.stdin.isTTY !== true) {
    console.error('the TUI needs a terminal; use `agentrig run "<task>" --headless` for scripts');
    process.exitCode = 1;
    return;
  }

  let built;
  const budget = parseBudget(opts);
  const controller: TuiController = new TuiController({
    cwd: process.cwd(),
    // assigned below; the controller is constructed first because it owns `onAsk`
    agent: { run: () => { throw new Error("agent not ready"); } },
    ...(opts.supervise === true
      ? {
          supervised: true,
          // The same `supervisorOptions` the `run` command builds, rather than a second copy:
          // this entry point had NO supervisor at all, so `--supervise` was accepted and ignored.
          onSession: (session) =>
            void supervise(
              session,
              supervisorOptions({
                opts,
                task: "",
                budget: budget.budget,
                ...(budget.pricing === undefined ? {} : { pricing: budget.pricing }),
                memoryIndex: "",
                provider: built!.provider,
                soft: parseSoft(opts.supervisorSoft ?? "0.8"),
                onEscalate: (question: string) => controller.print(`supervisor asks: ${question}`, "error"),
                onError: (where: string, err: Error) =>
                  controller.print(`supervisor ${where}: ${err.message}`, "error"),
              }),
            ),
        }
      : {}),
  });

  try {
    built = await buildAgent(opts, {
      onAsk: (req) => controller.ask(req),
      onHookError: (m) => controller.print(m, "error"),
      onHookDone: (m) => controller.print(m, "system"),
    });
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }

  controller.attach(built.agent);
  // in the frame rather than on stderr: stderr would be overwritten by the first render
  const warning = permissionWarning(opts, process.cwd());
  if (warning !== null) controller.print(warning, "error");
  if (built.memoryStore !== undefined) {
    const store = built.memoryStore;
    controller.setMemory(async (query) => {
      const hits =
        query === ""
          ? (await store.index()).map((e) => `${e.path} — ${e.summary}`)
          : unionRetrieve(await store.index(), await store.pages(), query, 8).map(
              (h) => `${h.page.path} — ${h.snippet}`,
            );
      return hits.length === 0 ? ["(the wiki is empty)"] : hits;
    });
  }
  if (opts.memory !== undefined) {
    const dir = opts.memory;
    controller.setDream(async (auto) => {
      const wiki = new FileMemoryStore({ root: join(dir, "wiki") });
      await wiki.init();
      const result = await runDream({
        wiki,
        raw: new FileRawStore({ root: dir }),
        provider: built!.provider,
        cwd: process.cwd(),
      });
      const findings = findingCount(result.report, result.structural);
      if (!auto) {
        return [
          renderReport(result.report, {
            structural: result.structural,
            promotionRejected: result.promotionRejected,
            outputRoot: result.outputRoot,
            applied: false,
          }),
          `to accept: agentrig dream --auto  |  to discard: rm -rf ${result.outputRoot}`,
        ];
      }
      const backup = await applyDream(join(dir, "wiki"), result.outputRoot, `${Date.now()}-tui`);
      await result.workspace.dispose().catch(() => {});
      return [`dream applied (${findings} finding(s)); previous wiki kept at ${backup}`];
    });
  }

  // `agentrig run` installs the same handler. Without it, ctrl-C tears down the UI while the
  // agent keeps running — still executing bash, still writing files, now invisibly.
  const onSigint = (): void => controller.abort();
  process.on("SIGINT", onSigint);

  controller.print("agentrig — type a task, or /help for commands", "system");
  try {
    // exitOnCtrlC must be OFF: with it on, Ink unmounts on ctrl-C *and refuses to dispatch it*
    // to useInput, so the abort handler in the view could never run.
    const { waitUntilExit } = render(<App controller={controller} />, { exitOnCtrlC: false });
    await waitUntilExit();
  } finally {
    process.removeListener("SIGINT", onSigint);
    // a session still running when the UI closes would keep billing with nothing watching it
    await controller.shutdown();
    for (const server of built.mcp) await server.close().catch(() => {});
  }
}
