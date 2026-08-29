import { createInterface } from "node:readline/promises";
import {
  createAgent,
  builtinTools,
  defaultRules,
  RulePolicy,
  SessionStore,
  PermissionClass,
  type Budget,
  type Decision,
  type ModelProvider,
  type PermissionRequest,
  type PermissionRule,
  type Pricing,
  type Session,
} from "@agentkitai/agentrig-core";
import { renderEvent } from "./render.js";
import { buildProvider, DEFAULT_ANTHROPIC_MODEL, type ProviderOptions } from "./provider.js";
import { FileMemoryStore, indexInjection } from "@agentkitai/agentrig-memory";
import { join } from "node:path";

export { DEFAULT_ANTHROPIC_MODEL };

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
  let provider: ModelProvider;
  try {
    provider = buildProvider(opts);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }

  let budget: Budget;
  let maxTokensPerTurn: number;
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
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }

  // index-first retrieval (PLAN §3.2): the wiki catalog rides in the system prompt, and the
  // agent opens only what it needs via memory_search / memory_read.
  let memoryIndex = "";
  if (opts.memory !== undefined) {
    memoryIndex = await indexInjection(new FileMemoryStore({ root: join(opts.memory, "wiki") })).catch(() => "");
  }

  const interactive = !opts.headless && process.stdin.isTTY === true;
  const agent = createAgent({
    provider,
    tools: builtinTools(),
    // deny rules first so an explicit deny always wins; `ask` prompts when interactive, else denies.
    permissions: new RulePolicy([...toRules(opts.deny, "deny"), ...toRules(opts.allow, "allow"), ...defaultRules]),
    // a function so a resumed session gets its snapshot's cwd, not this process's
    systemPrompt: (ctx) =>
      [opts.system ?? defaultSystemPrompt(ctx.cwd), memoryIndex].filter((s) => s !== "").join("\n\n"),
    store: new SessionStore({ root: opts.root }),
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
  }
}
