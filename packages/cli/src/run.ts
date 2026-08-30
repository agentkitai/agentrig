import { createInterface } from "node:readline/promises";
import {
  createAgent,
  builtinTools,
  defaultRules,
  RulePolicy,
  SessionStore,
  PermissionClass,
  type AnyTool,
  type Budget,
  type Hook,
  type Decision,
  type ModelProvider,
  type PermissionRequest,
  type PermissionRule,
  type Pricing,
  type Session,
} from "@agentkitai/agentrig-core";
import { renderEvent } from "./render.js";
import { buildProvider, DEFAULT_ANTHROPIC_MODEL, type ProviderOptions } from "./provider.js";
import { buildAgent, parseBudget, type AgentBuildOptions } from "./agent-builder.js";
import {
  dreamOnSessionEnd,
  FileMemoryStore,
  FileRawStore,
  indexInjection,
  ingestOnSessionEnd,
  memoryTools,
} from "@agentkitai/agentrig-memory";
import { openBackend } from "./memory.js";
import { RubricGrader, supervise, TrajectoryReviewer } from "@agentkitai/agentrig-supervisor";
import { join } from "node:path";

export { DEFAULT_ANTHROPIC_MODEL };

/**
 * PLAN §3.1: session logs are a raw memory source, so they live under `raw/sessions/` where
 * ingest looks for them. They used to be written to `.agentrig/sessions`, which memory ingest
 * could never find — the run → ingest flow was broken out of the box.
 */
export const DEFAULT_SESSIONS_DIR = ".agentrig/raw/sessions";

export interface RunOptions extends AgentBuildOptions {
  root: string;
  json?: boolean;
  headless?: boolean;
  resume?: string;
  system?: string;
  allow?: string[];
  deny?: string[];
  maxTurns: string;
  maxTokens?: string;
  maxMinutes?: string;
  maxUsd?: string;
  priceIn?: string;
  priceOut?: string;
  maxTokensPerTurn: string;
  memory?: string;
  supervise?: boolean;
  supervisorNoAbort?: boolean;
  supervisorSoft: string;
  supervisorReview?: boolean;
  ingestOnEnd?: boolean;
  dreamOnEnd?: boolean;
  dreamEverySessions: string;
  dreamEveryHours: string;
  dreamStructuralOnly?: boolean;
}

const PATH_TOOLS = new Set(["read_file", "write_file", "edit_file", "glob", "grep"]);

/**
 * "--allow exec" is a class rule; "--allow bash" is a tool rule. Allow rules for path-capable
 * tools/classes are confined to the working directory unless suffixed ":anywhere"
 * (e.g. "--allow write:anywhere"). Deny rules always apply everywhere.
 */
export function toRules(values: string[] | undefined, decision: "allow" | "deny"): PermissionRule[] {
  return (values ?? []).map((v) => {
    const anywhere = v.endsWith(":anywhere");
    const name = anywhere ? v.slice(0, -":anywhere".length) : v;
    const parsed = PermissionClass.safeParse(name);
    const rule: PermissionRule = parsed.success ? { class: parsed.data, decision } : { tool: name, decision };
    if (decision === "allow" && !anywhere) {
      const confinable = parsed.success ? parsed.data === "read" || parsed.data === "write" : PATH_TOOLS.has(name);
      if (confinable) rule.cwdOnly = true;
    }
    return rule;
  });
}

export function defaultSystemPrompt(cwd: string): string {
  return [
    "You are AgentRig, an autonomous software engineering agent.",
    `Working directory: ${cwd}`,
    "Use the available tools to complete the task. Verify your work (run tests or re-read files) before finishing.",
    "When the task is complete, reply with a short summary and no tool calls.",
  ].join("\n");
}

export function positiveNumber(flag: string, value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${flag} must be a positive number, got "${value}"`);
  }
  return n;
}

/** Prompts on stderr so --json event output on stdout stays parseable. */
async function askInteractively(req: PermissionRequest): Promise<Exclude<Decision, "ask">> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const where = req.paths === undefined ? "" : ` on ${req.paths.join(", ")}`;
    const answer = await rl.question(`allow ${req.tool} [${req.class}]${where}? (y/N) `);
    return /^y(es)?$/i.test(answer.trim()) ? "allow" : "deny";
  } finally {
    rl.close();
  }
}

export async function runCommand(task: string, opts: RunOptions): Promise<void> {
  let dreamEverySessions: number;
  let dreamEveryHours: number;
  let supervisorSoft: number;
  try {
    supervisorSoft = positiveNumber("--supervisor-soft", opts.supervisorSoft);
    if (supervisorSoft > 1) {
      throw new Error(`--supervisor-soft is a fraction of the budget, got "${opts.supervisorSoft}"`);
    }
    dreamEverySessions = positiveNumber("--dream-every-sessions", opts.dreamEverySessions);
    dreamEveryHours = positiveNumber("--dream-every-hours", opts.dreamEveryHours);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }
  void dreamEverySessions;
  void dreamEveryHours;

  if (opts.memory === undefined && (opts.ingestOnEnd === true || opts.dreamOnEnd === true)) {
    console.error("--ingest-on-end/--dream-on-end need --memory; no session_end hook was registered");
  }

  const interactive = opts.headless !== true && process.stdin.isTTY === true;

  let built;
  try {
    built = await buildAgent(opts, {
      ...(interactive ? { onAsk: askInteractively } : {}),
      onHookError: (m) => console.error(m),
      onHookDone: (m) => console.error(m),
    });
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }
  const { agent, provider, memoryIndex } = built;

  const budget = parseBudget(opts);

  // on resume, omit cwd so the snapshot's cwd wins
  const session: Session = agent.run(
    task,
    opts.resume === undefined ? { cwd: process.cwd() } : { resume: opts.resume },
  );

  // PLAN §4.4: an out-of-band observer over the same event stream.
  const supervisor =
    opts.supervise !== true
      ? null
      : supervise(session, {
          budget: {
            soft: supervisorSoft,
            ...(budget.budget.maxTurns === undefined ? {} : { maxTurns: budget.budget.maxTurns }),
            ...(budget.budget.maxTokens === undefined ? {} : { maxTokens: budget.budget.maxTokens }),
            ...(budget.budget.maxUsd === undefined ? {} : { maxUsd: budget.budget.maxUsd }),
            ...(budget.budget.maxMinutes === undefined ? {} : { maxMinutes: budget.budget.maxMinutes }),
          },
          capabilities: { abort: opts.supervisorNoAbort !== true },
          task,
          ...(budget.pricing === undefined ? {} : { pricing: budget.pricing }),
          ...(memoryIndex === "" ? {} : { memoryIndex }),
          ...(opts.supervisorReview === true
            ? {
                reviewer: new TrajectoryReviewer({ provider }),
                grader: new RubricGrader({ provider }),
                attempts: async () => {
                  if (opts.memory === undefined) return [];
                  return (await new FileRawStore({ root: opts.memory }).readAttempts()).attempts;
                },
              }
            : {}),
          ...(interactive
            ? {
                onEscalate: (question: string) => {
                  console.error(`supervisor escalation: ${question}`);
                },
              }
            : {}),
          onError: (where, err) => console.error(`supervisor ${where}: ${err.message}`),
        });

  const onSigint = (): void => session.control.abort();
  process.on("SIGINT", onSigint);
  try {
    for await (const e of session.events) {
      if (opts.json === true) {
        console.log(JSON.stringify(e));
        // machine consumers read stdout; humans tailing stderr still deserve fatal errors
        if (e.type === "error" && e.fatal) console.error(`fatal: ${e.message}`);
      } else if (e.type !== "model.delta") {
        console.log(renderEvent(e));
      }
    }
    const summary = await session.done;
    if (summary.error !== undefined) console.error(summary.error);
    if (opts.json !== true) {
      console.log(
        `session ${summary.id}: ${summary.reason} after ${summary.turns} turn(s), ` +
          `${summary.usage.input} in / ${summary.usage.output} out tokens`,
      );
    }
    process.exitCode = summary.reason === "done" ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
    if (supervisor !== null) {
      const timedOut = Symbol("timeout");
      const raced = await Promise.race([
        supervisor.done,
        new Promise<symbol>((r) => setTimeout(() => r(timedOut), 2000).unref()),
      ]);
      if (raced === timedOut) supervisor.detach();
    }
  }
}
