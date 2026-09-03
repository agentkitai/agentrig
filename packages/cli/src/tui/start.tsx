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
import { withBracketedPaste } from "./bracketed-paste-mode.js";
import { SessionStore, liveChildren, summarizeSession } from "@agentkitai/agentrig-core";
import { buildAgent, type AgentBuildOptions } from "../agent-builder.js";
import { forkSessionAt, renderChildren, renderSessionTree } from "../sessions.js";
import { currentGitBranch } from "../git-branch.js";
import {
  parseSoft,
  parseTurnsRemaining,
  permissionWarning,
  supervisorOptions,
  type SupervisorFlags,
} from "../run.js";
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
  // Validate before a session starts. Parsing inside onSession would let an invalid threshold run
  // without supervision after the controller caught the attachment error.
  const supervisorSoft = parseSoft(opts.supervisorSoft ?? "0.8");
  const supervisorTurnsRemaining = parseTurnsRemaining(opts.supervisorTurnsRemaining ?? "15");
  const controller: TuiController = new TuiController({
    cwd: process.cwd(),
    model: opts.model,
    branch: () => currentGitBranch(process.cwd()),
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
                soft: supervisorSoft,
                turnsRemaining: supervisorTurnsRemaining,
                onEscalate: (question: string) => controller.askSupervisor(question),
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
      // in the frame, not on stderr: stderr is overwritten by the next render, and an invisible
      // retry is indistinguishable from the hangs this TUI has already been debugged for
      onNotice: (m) => controller.print(m, "system"),
    });
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }

  controller.attach(built.agent);
  controller.setSkills(built.skills);
  {
    // The same root the agent's own store writes to; a separate instance because the store is
    // per-agent and forks/trees are read-mostly operations over the directory.
    const sessions = new SessionStore({ root: opts.root });
    controller.setSessions({
      fork: (parent, atSeq) => forkSessionAt(sessions, parent, atSeq),
      tree: async (id) => renderSessionTree(await sessions.tree(id), id),
      // read-only: each child's own log is the source of truth, and nothing is copied into ours
      children: async (children, now, parent) =>
        renderChildren(await liveChildren(sessions, children, { parent }), now),
      spawned: async (id) =>
        summarizeSession(id, (await sessions.readPrefix(id)).events).children.map((c) => ({
          id: c.id,
          task: c.task,
          ...(c.reason === undefined ? {} : { reason: c.reason }),
        })),
    });
  }
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
  let stopForSigint = (): void => controller.abort();
  const onSigint = (): void => stopForSigint();
  process.on("SIGINT", onSigint);

  controller.print("agentrig — type a task, or /help for commands", "system");
  try {
    await withBracketedPaste(process.stdout, async () => {
      // exitOnCtrlC must be OFF: with it on, Ink unmounts on ctrl-C *and refuses to dispatch it*
      // to useInput, so the abort handler in the view could never run.
      const { unmount, waitUntilExit } = render(<App controller={controller} />, {
        exitOnCtrlC: false,
      });
      // An OS SIGINT is not the raw ctrl-c byte handled by App. Make it a real teardown so this
      // scope's finally disables bracketed paste; shutdown below then aborts any active session.
      stopForSigint = unmount;
      await waitUntilExit();
    });
  } finally {
    // The UI is gone but the session may still be running, or running its session_end hooks
    // (#88): keep answering SIGINT until shutdown has finished, so a ctrl-C here is a second
    // abort that skips the hooks rather than Node's default handler killing the process mid-hook
    // with no session.end written.
    stopForSigint = () => controller.abort();
    try {
      await controller.shutdown();
    } finally {
      process.removeListener("SIGINT", onSigint);
    }
    for (const server of built.mcp) await server.close().catch(() => {});
  }
}
