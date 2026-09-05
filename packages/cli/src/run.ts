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
import { AssistantText, formatUsage, renderChatEvent, renderEvent } from "./render.js";
import { DEFAULT_ANTHROPIC_MODEL } from "./provider.js";
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
import {
  RubricGrader,
  supervise,
  TrajectoryReviewer,
  type SuperviseOptions,
} from "@agentkitai/agentrig-supervisor";
import { join } from "node:path";

export { DEFAULT_ANTHROPIC_MODEL };

/**
 * PLAN §3.1: session logs are a raw memory source, so they live under `raw/sessions/` where
 * ingest looks for them. They used to be written to `.agentrig/sessions`, which memory ingest
 * could never find — the run → ingest flow was broken out of the box.
 */
export const DEFAULT_SESSIONS_DIR = ".agentrig/raw/sessions";

export interface RunOptions extends AgentBuildOptions, SupervisorFlags {
  root: string;
  json?: boolean;
  /** Show the raw event trace instead of the conversation. `--json` is unaffected. */
  verbose?: boolean;
  headless?: boolean;
  resume?: string;
  /** Named config profile to overlay; may arrive from the subcommand flag or the root-level one. */
  profile?: string;
  system?: string;
  allow?: string[];
  driftScope?: string[];
  deny?: string[];
  maxTurns: string;
  maxTokens?: string;
  maxMinutes?: string;
  maxUsd?: string;
  priceIn?: string;
  priceOut?: string;
  priceCacheRead?: string;
  priceCacheWrite?: string;
  maxTokensPerTurn: string;
  memory?: string;
  /** Required here (the flags have defaults) while `SupervisorFlags` leaves them optional. */
  supervisorSoft: string;
  supervisorTurnsRemaining: string;
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

/**
 * What each abort does, for the person who pressed it (#88): the first stops the work, and the
 * session_end hooks (memory ingest, the dream trigger) still run for a session aborted mid-turn;
 * the second stops those too. The first promises nothing about the hooks, because a session that
 * had already finished its turn and was in its hooks is cut by the first abort and the caller
 * cannot tell that case apart. A third abort changes nothing and says nothing.
 */
export function abortNotice(nth: number, key: string): string | null {
  if (nth === 1) return `aborting… (${key} again to skip session_end hooks)`;
  if (nth === 2) return "skipping session_end hooks";
  return null;
}

/**
 * Whether this run skips the permission prompt entirely.
 *
 * Two spellings for one thing: `--dangerously-skip-permissions` is the name that says what it
 * does, `--yolo` is the name people actually type. Read through this helper rather than either
 * flag, so a caller cannot honour one and miss the other.
 */
export function skipsPermissions(opts: { dangerouslySkipPermissions?: boolean; yolo?: boolean }): boolean {
  return opts.dangerouslySkipPermissions === true || opts.yolo === true;
}

/**
 * The policy both entry points run under.
 *
 * Order is the whole design. `--deny` is first, so it still wins under `--yolo`: skipping the
 * prompt is not the same as discarding the rules you asked for, and `--yolo --deny write:anywhere`
 * has to mean something. Skipping only changes what happens to a request NOTHING matched — `ask`
 * normally, `allow` here — so it can never quietly overturn an earlier decision.
 *
 * Every request and its decision are still emitted to the session log, so a run that asked nothing
 * is still a run you can read back afterwards.
 */
export function buildPermissionPolicy(opts: {
  allow?: string[];
  deny?: string[];
  dangerouslySkipPermissions?: boolean;
  yolo?: boolean;
  extra?: PermissionRule[];
}): RulePolicy {
  return new RulePolicy(
    [...toRules(opts.deny, "deny"), ...toRules(opts.allow, "allow"), ...(opts.extra ?? []), ...defaultRules],
    skipsPermissions(opts) ? "allow" : "ask",
  );
}

/**
 * What to say before a run that will not ask. Returned rather than printed so the TUI can put it
 * in the frame and `run` can put it on stderr, and so a test can assert on it.
 */
export function permissionWarning(
  opts: {
    dangerouslySkipPermissions?: boolean;
    yolo?: boolean;
    deny?: string[];
    sandbox?: "read-only" | "workspace-write" | "none";
  },
  cwd: string,
): string | null {
  if (!skipsPermissions(opts)) return null;
  const denied = (opts.deny ?? []).length === 0 ? "" : ` (except --deny ${(opts.deny ?? []).join(", ")})`;
  const mode = opts.sandbox ?? "none";
  if (mode !== "none") {
    return (
      `permissions are OFF${denied}, but the ${mode} sandbox is ON for ${cwd}. ` +
      `Built-in writes and shell launches use the boundary; unsupported tools require separate ` +
      `outside-sandbox approval. Host hooks and MCP startup are refused in this mode. ` +
      `SDK code and session bookkeeping remain trusted host operations. The session log records every call.`
    );
  }
  // the cwd is named because "skip permissions" is abstract and "it may delete anything under
  // /Users/you/work" is not
  return (
    `permissions are OFF${denied}: every tool call is allowed without asking, including writing ` +
    `and deleting outside ${cwd} and running any shell command. --sandbox workspace-write confines ` +
    `supported tool effects; it does not isolate trusted SDK code. The session log still ` +
    `records every call.`
  );
}

/**
 * The supervisor's own flags, split out so BOTH entry points can carry them. `TuiOptions` did not
 * include these at all — the type was the first evidence that `--supervise` could not possibly
 * work there.
 */
export interface SupervisorFlags {
  supervise?: boolean;
  supervisorAbort?: boolean;
  supervisorNoAbort?: boolean;
  supervisorSoft?: string;
  supervisorTurnsRemaining?: string;
  supervisorReview?: boolean;
  driftScope?: string[];
  driftContract?: string[];
  memory?: string;
}

/** `--supervisor-soft` is a fraction of the budget, not a count. Shared so both parse it alike. */
export function parseSoft(value: string): number {
  const soft = positiveNumber("--supervisor-soft", value);
  if (soft > 1) throw new Error(`--supervisor-soft is a fraction of the budget, got ${JSON.stringify(value)}`);
  return soft;
}

/** The absolute turns-remaining warning is a count, so fractions would create ambiguous boundaries. */
export function parseTurnsRemaining(value: string): number {
  const turns = positiveNumber("--supervisor-turns-remaining", value);
  if (!Number.isInteger(turns)) {
    throw new Error(`--supervisor-turns-remaining must be an integer, got ${JSON.stringify(value)}`);
  }
  return turns;
}

export interface SupervisorWiring {
  opts: SupervisorFlags;
  task: string;
  budget: Budget;
  pricing?: Pricing;
  memoryIndex: string;
  provider: ModelProvider;
  /** The entry the trajectory reviewer and rubric grader run on (R3.5a). Defaults to `provider`. */
  reviewProvider?: ModelProvider;
  soft: number;
  turnsRemaining: number;
  onEscalate?: SuperviseOptions["onEscalate"];
  onError?: (where: string, err: Error) => void;
}

/**
 * Everything the supervisor is configured with, in one place.
 *
 * Exported and pure because it was previously inline in `runCommand` — where the only way to test
 * that a flag reached the supervisor was to run a whole session, so nothing did. `--drift-scope`
 * could be deleted from the wiring and every test still passed. It is also what lets the TUI
 * attach the same supervisor rather than a second, divergent one.
 */
export function supervisorOptions(w: SupervisorWiring): SuperviseOptions {
  const o = w.opts;
  const reviewProvider = w.reviewProvider ?? w.provider;
  return {
    budget: {
      soft: w.soft,
      turnsRemaining: w.turnsRemaining,
      ...(w.budget.maxTurns === undefined ? {} : { maxTurns: w.budget.maxTurns }),
      ...(w.budget.maxTokens === undefined ? {} : { maxTokens: w.budget.maxTokens }),
      ...(w.budget.maxUsd === undefined ? {} : { maxUsd: w.budget.maxUsd }),
      ...(w.budget.maxMinutes === undefined ? {} : { maxMinutes: w.budget.maxMinutes }),
    },
    capabilities: { abort: o.supervisorAbort === true },
    drift: {
      scope: o.driftScope ?? [],
      ...(o.driftContract === undefined ? {} : { contract: o.driftContract }),
    },
    task: w.task,
    ...(w.pricing === undefined ? {} : { pricing: w.pricing }),
    ...(w.provider.capabilities?.cacheReadDiscount === undefined
      ? {}
      : { cacheReadDiscount: w.provider.capabilities.cacheReadDiscount }),
    ...(w.provider.capabilities?.cacheWriteMultiplier === undefined
      ? {}
      : { cacheWriteMultiplier: w.provider.capabilities.cacheWriteMultiplier }),
    ...(w.memoryIndex === "" ? {} : { memoryIndex: w.memoryIndex }),
    ...(o.supervisorReview === true
      ? {
          reviewer: new TrajectoryReviewer({ provider: reviewProvider }),
          grader: new RubricGrader({ provider: reviewProvider }),
          attempts: async () => {
            if (o.memory === undefined) return [];
            return (await new FileRawStore({ root: o.memory }).readAttempts()).attempts;
          },
        }
      : {}),
    ...(w.onEscalate === undefined ? {} : { onEscalate: w.onEscalate }),
    ...(w.onError === undefined ? {} : { onError: w.onError }),
  };
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
    const who = req.origin === undefined ? "" : ` for ${req.origin}`;
    const answer = await rl.question(`allow ${req.tool} [${req.class}]${where}${who}? (y/N) `);
    return /^y(es)?$/i.test(answer.trim()) ? "allow" : "deny";
  } finally {
    rl.close();
  }
}

export async function runCommand(task: string, opts: RunOptions): Promise<void> {
  let dreamEverySessions: number;
  let dreamEveryHours: number;
  let supervisorSoft: number;
  let supervisorTurnsRemaining: number;
  try {
    supervisorSoft = parseSoft(opts.supervisorSoft);
    supervisorTurnsRemaining = parseTurnsRemaining(opts.supervisorTurnsRemaining);
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

  // said before the agent starts, not after: the point of the warning is to be readable while
  // there is still time to stop
  const warning = permissionWarning(opts, process.cwd());
  if (warning !== null) console.error(warning);

  const interactive = opts.headless !== true && process.stdin.isTTY === true;

  let built;
  try {
    built = await buildAgent(opts, {
      ...(interactive ? { onAsk: askInteractively } : {}),
      onHookError: (m) => console.error(m),
      onHookDone: (m) => console.error(m),
      onNotice: (m) => console.error(m),
    });
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }
  const { agent, provider, providers, memoryIndex } = built;

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
      : supervise(
          session,
          supervisorOptions({
            opts,
            task,
            budget: budget.budget,
            ...(budget.pricing === undefined ? {} : { pricing: budget.pricing }),
            memoryIndex,
            provider,
            reviewProvider: providers.supervisor,
            soft: supervisorSoft,
            turnsRemaining: supervisorTurnsRemaining,
            ...(interactive
              ? { onEscalate: (question: string) => console.error(`supervisor escalation: ${question}`) }
              : {}),
            onError: (where, err) => console.error(`supervisor ${where}: ${err.message}`),
          }),
        );

  let sigints = 0;
  const onSigint = (): void => {
    sigints += 1;
    const notice = abortNotice(sigints, "ctrl-C");
    if (notice !== null) console.error(notice);
    session.control.abort();
  };
  process.on("SIGINT", onSigint);
  try {
    const assistant = new AssistantText();
    for await (const e of session.events) {
      if (opts.json === true) {
        console.log(JSON.stringify(e));
        // machine consumers read stdout; humans tailing stderr still deserve fatal errors
        if (e.type === "error" && e.fatal) console.error(`fatal: ${e.message}`);
        continue;
      }
      // the model's reply, gathered from the per-token deltas and printed once per turn. Without
      // this the answer was never printed at all: the deltas were skipped and nothing else
      // carries the text.
      const reply = assistant.push(e);
      if (reply !== null) console.log(reply);
      if (e.type === "model.delta") continue;

      if (opts.verbose === true) {
        console.log(renderEvent(e));
        continue;
      }
      // a person asked a question; `turn.start` and `model.request` are not an answer
      const line = renderChatEvent(e);
      if (line !== null) console.log(line);
    }
    const summary = await session.done;
    if (summary.error !== undefined) console.error(summary.error);
    if (opts.json !== true) {
      console.log(
        `session ${summary.id}: ${summary.reason} after ${summary.turns} turn(s), ` +
          `${formatUsage(summary.usage)} tokens`,
      );
    }
    process.exitCode = summary.reason === "done" ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
    // a server left running would outlive the session that spawned it
    for (const server of built.mcp) await server.close().catch(() => {});
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
