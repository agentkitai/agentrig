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

export interface RunOptions extends ProviderOptions {
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
function toRules(values: string[] | undefined, decision: "allow" | "deny"): PermissionRule[] {
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

function defaultSystemPrompt(cwd: string): string {
  return [
    "You are AgentRig, an autonomous software engineering agent.",
    `Working directory: ${cwd}`,
    "Use the available tools to complete the task. Verify your work (run tests or re-read files) before finishing.",
    "When the task is complete, reply with a short summary and no tool calls.",
  ].join("\n");
}

function positiveNumber(flag: string, value: string): number {
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
  let budget: Budget;
  let maxTokensPerTurn: number;
  let supervisorSoft: number;
  let dreamEverySessions: number;
  let dreamEveryHours: number;
  let pricing: Pricing | undefined;
  try {
    budget = { maxTurns: positiveNumber("--max-turns", opts.maxTurns) };
    if (opts.maxTokens !== undefined) budget.maxTokens = positiveNumber("--max-tokens", opts.maxTokens);
    if (opts.maxMinutes !== undefined) budget.maxMinutes = positiveNumber("--max-minutes", opts.maxMinutes);
    if (opts.priceIn !== undefined || opts.priceOut !== undefined) {
      if (opts.priceIn === undefined || opts.priceOut === undefined) {
        throw new Error("--price-in and --price-out must be given together");
      }
      pricing = {
        inputUsdPerMTok: positiveNumber("--price-in", opts.priceIn),
        outputUsdPerMTok: positiveNumber("--price-out", opts.priceOut),
      };
    }
    if (opts.maxUsd !== undefined) {
      if (pricing === undefined) {
        throw new Error("--max-usd requires --price-in and --price-out (USD per million tokens)");
      }
      budget.maxUsd = positiveNumber("--max-usd", opts.maxUsd);
    }
    maxTokensPerTurn = positiveNumber("--max-tokens-per-turn", opts.maxTokensPerTurn);
    supervisorSoft = positiveNumber("--supervisor-soft", opts.supervisorSoft);
    dreamEverySessions = positiveNumber("--dream-every-sessions", opts.dreamEverySessions);
    dreamEveryHours = positiveNumber("--dream-every-hours", opts.dreamEveryHours);
    if (supervisorSoft > 1) throw new Error(`--supervisor-soft is a fraction of the budget, got "${opts.supervisorSoft}"`);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }

  // Flags are validated *before* the provider is built: they are cheap, local checks, and a
  // typo'd budget flag should say so rather than being masked by a missing-credential error
  // from a provider the run was never going to reach.
  let provider: ModelProvider;
  try {
    provider = buildProvider(opts);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }

  // index-first retrieval (PLAN §3.2): the wiki catalog rides in the system prompt, and the
  // agent opens only what it needs via memory_search / memory_read.
  let memoryIndex = "";
  let memoryToolset: AnyTool[] = [];
  if (opts.memory !== undefined) {
    const memoryStore = new FileMemoryStore({ root: join(opts.memory, "wiki") });
    memoryIndex = await indexInjection(memoryStore).catch(() => "");
    // the injected index tells the model to call memory_read/memory_search, so the tools have
    // to actually be registered — otherwise it is advertising tools that do not exist
    const backend = openBackend();
    memoryToolset = memoryTools({
      store: memoryStore,
      raw: new FileRawStore({ root: opts.memory }),
      ...(backend === null ? {} : { backend }),
    });
  }

  // PLAN §2.7/§3.2/§3.7: the session_end hooks are what make a session compound into the wiki
  // rather than evaporate. Opt-in because ingest costs tokens; the dream trigger defaults to
  // review mode because §1.5 makes an unreviewed bulk rewrite of memory the wrong default.
  const hooks: Hook[] = [];
  if (opts.memory === undefined && (opts.ingestOnEnd === true || opts.dreamOnEnd === true)) {
    console.error("--ingest-on-end/--dream-on-end need --memory; no session_end hook was registered");
  }
  if (opts.memory !== undefined && opts.ingestOnEnd === true) {
    const backend = openBackend();
    hooks.push(
      ingestOnSessionEnd({
        dir: opts.memory,
        provider,
        ...(backend === null ? {} : { backend }),
        onError: (err) => console.error(`memory ingest failed (session still succeeded): ${err.message}`),
        onDone: (summary) => console.error(`memory: ${summary}`),
      }),
    );
  }
  if (opts.memory !== undefined && opts.dreamOnEnd === true) {
    hooks.push(
      dreamOnSessionEnd({
        dir: opts.memory,
        provider,
        everySessions: dreamEverySessions,
        everyHours: dreamEveryHours,
        ...(opts.dreamStructuralOnly === true ? { structuralOnly: true } : {}),
        onError: (err) => console.error(`dream failed (session still succeeded): ${err.message}`),
        onDone: (summary) => console.error(`dream: ${summary}`),
      }),
    );
  }

  const interactive = !opts.headless && process.stdin.isTTY === true;
  const agent = createAgent({
    provider,
    tools: [...builtinTools(), ...memoryToolset],
    // deny rules first so an explicit deny always wins; `ask` prompts when interactive, else denies.
    permissions: new RulePolicy([
      ...toRules(opts.deny, "deny"),
      ...toRules(opts.allow, "allow"),
      // memory reads are confined to the wiki root by the store itself, not by cwd, so they
      // cannot be expressed as a cwdOnly rule; allow them by tool name instead
      ...(memoryToolset.length === 0
        ? []
        : [
            { tool: "memory_search", decision: "allow" as const },
            { tool: "memory_read", decision: "allow" as const },
          ]),
      ...defaultRules,
    ]),
    // a function so a resumed session gets its snapshot's cwd, not this process's
    systemPrompt: (ctx) =>
      [opts.system ?? defaultSystemPrompt(ctx.cwd), memoryIndex].filter((s) => s !== "").join("\n\n"),
    store: new SessionStore({ root: opts.root }),
    ...(hooks.length === 0 ? {} : { hooks }),
    budget,
    ...(pricing === undefined ? {} : { pricing }),
    maxTokensPerTurn,
    ...(interactive ? { onAsk: askInteractively } : {}),
  });

  // on resume, omit cwd so the snapshot's cwd wins
  const session: Session = agent.run(
    task,
    opts.resume === undefined ? { cwd: process.cwd() } : { resume: opts.resume },
  );
  // PLAN §4.4: an out-of-band observer over the same event stream. It reads its own cursor over
  // core's replayed buffer, so attaching it never slows the loop down.
  const supervisor =
    opts.supervise !== true
      ? null
      : supervise(session, {
          budget: {
            soft: supervisorSoft,
            ...(budget.maxTurns === undefined ? {} : { maxTurns: budget.maxTurns }),
            ...(budget.maxTokens === undefined ? {} : { maxTokens: budget.maxTokens }),
            ...(budget.maxUsd === undefined ? {} : { maxUsd: budget.maxUsd }),
            ...(budget.maxMinutes === undefined ? {} : { maxMinutes: budget.maxMinutes }),
          },
          capabilities: { abort: opts.supervisorNoAbort !== true },
          task,
          // PLAN §4.3: the LLM-backed rungs cost tokens, so they are opt-in. Without them the
          // ladder is still the free M4 one — detectors and guidance — rather than nothing.
          ...(opts.supervisorReview === true
            ? {
                reviewer: new TrajectoryReviewer({ provider }),
                // the wiki digest the agent itself is working from, so the reviewer diagnoses
                // against what the agent knows rather than guessing at it
                ...(memoryIndex === "" ? {} : { memoryIndex }),
                grader: new RubricGrader({ provider }),
                attempts: async () => {
                  if (opts.memory === undefined) return [];
                  return (await new FileRawStore({ root: opts.memory }).readAttempts()).attempts;
                },
              }
            : {}),
          ...(pricing === undefined ? {} : { pricing }),
          // there is no human in a headless run, so `escalate` stays unavailable and the ladder
          // goes guidance → abort; interactively the question is put on stderr
          ...(interactive
            ? {
                onEscalate: (question: string) => {
                  console.error(`supervisor escalation: ${question}`);
                },
              }
            : {}),
          onError: (where, err) => console.error(`supervisor ${where}: ${err.message}`),
        });

  const onSigint = () => session.control.abort();
  process.on("SIGINT", onSigint);
  try {
    for await (const e of session.events) {
      if (opts.json) {
        console.log(JSON.stringify(e));
        // machine consumers read stdout; humans tailing stderr still deserve fatal errors
        if (e.type === "error" && e.fatal) console.error(`fatal: ${e.message}`);
      } else if (e.type !== "model.delta") {
        console.log(renderEvent(e));
      }
    }
    const summary = await session.done;
    if (summary.error !== undefined) console.error(summary.error);
    if (!opts.json) {
      console.log(
        `session ${summary.id}: ${summary.reason} after ${summary.turns} turn(s), ` +
          `${summary.usage.input} in / ${summary.usage.output} out tokens`,
      );
    }
    process.exitCode = summary.reason === "done" ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
    // Let the observer drain what it has not seen yet — but bounded. If the render loop above
    // exited early (EPIPE under `| head`, a throw in renderEvent) the session may still be
    // running, and an unbounded join would hold the process for its whole remaining lifetime.
    if (supervisor !== null) {
      // On the normal path the stream has closed and this resolves immediately. detach() comes
      // *after* the race, not before: detaching first would cut short the tail of events the
      // observer still had buffered.
      const timedOut = Symbol("timeout");
      const raced = await Promise.race([
        supervisor.done,
        new Promise<symbol>((r) => setTimeout(() => r(timedOut), 2000).unref()),
      ]);
      if (raced === timedOut) supervisor.detach();
    }
  }
}
