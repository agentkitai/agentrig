import { join } from "node:path";
import {
  builtinTools,
  createAgent,
  defaultRules,
  RulePolicy,
  SessionStore,
  type Agent,
  type AnyTool,
  type Budget,
  type Hook,
  type ModelProvider,
  type PermissionRequest,
  type Decision,
  type Pricing,
} from "@agentkitai/agentrig-core";
import {
  dreamOnSessionEnd,
  FileMemoryStore,
  FileRawStore,
  indexInjection,
  ingestOnSessionEnd,
  memoryTools,
} from "@agentkitai/agentrig-memory";
import { buildProvider, type ProviderOptions } from "./provider.js";
import { openBackend } from "./memory.js";
import { defaultSystemPrompt, positiveNumber, toRules } from "./run.js";

/**
 * The one place an agent is assembled.
 *
 * `agentrig run` and the TUI each built their own before this existed, and the copies had already
 * diverged in seven ways inside the commit that made them — different system prompts, no flag
 * validation on one side, no `--allow`/`--deny`, no `session_end` hooks. That is exactly the
 * failure CLAUDE.md's "keep the CLI thin, logic belongs in a package" rule predicts, so the
 * shared surface lives here and both entry points are wiring.
 */

export interface AgentBuildOptions extends ProviderOptions {
  root: string;
  memory?: string;
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
  ingestOnEnd?: boolean;
  dreamOnEnd?: boolean;
  dreamEverySessions?: string;
  dreamEveryHours?: string;
  dreamStructuralOnly?: boolean;
}

export interface BuiltAgent {
  agent: Agent;
  provider: ModelProvider;
  memoryIndex: string;
  memoryStore?: FileMemoryStore;
}

/** Validates every numeric flag up front. Throws with the flag's own name; callers report it. */
export function parseBudget(opts: AgentBuildOptions): {
  budget: Budget;
  pricing?: Pricing;
  maxTokensPerTurn: number;
} {
  const budget: Budget = { maxTurns: positiveNumber("--max-turns", opts.maxTurns) };
  if (opts.maxTokens !== undefined) budget.maxTokens = positiveNumber("--max-tokens", opts.maxTokens);
  if (opts.maxMinutes !== undefined) budget.maxMinutes = positiveNumber("--max-minutes", opts.maxMinutes);

  let pricing: Pricing | undefined;
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
  return {
    budget,
    ...(pricing === undefined ? {} : { pricing }),
    maxTokensPerTurn: positiveNumber("--max-tokens-per-turn", opts.maxTokensPerTurn),
  };
}

export interface AgentExtras {
  onAsk?: (req: PermissionRequest) => Promise<Exclude<Decision, "ask">>;
  extraHooks?: Hook[];
  onHookError?: (message: string) => void;
  onHookDone?: (message: string) => void;
}

/** Assembles the agent. Throws on a bad flag or a missing credential; callers report and exit. */
export async function buildAgent(opts: AgentBuildOptions, extras: AgentExtras = {}): Promise<BuiltAgent> {
  const { budget, pricing, maxTokensPerTurn } = parseBudget(opts);
  const provider = buildProvider(opts);

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

  const hooks: Hook[] = [...(extras.extraHooks ?? [])];
  if (opts.memory !== undefined && opts.ingestOnEnd === true) {
    const backend = openBackend();
    hooks.push(
      ingestOnSessionEnd({
        dir: opts.memory,
        provider,
        ...(backend === null ? {} : { backend }),
        onError: (err) => extras.onHookError?.(`memory ingest failed (session still succeeded): ${err.message}`),
        onDone: (summary) => extras.onHookDone?.(`memory: ${summary}`),
      }),
    );
  }
  if (opts.memory !== undefined && opts.dreamOnEnd === true) {
    hooks.push(
      dreamOnSessionEnd({
        dir: opts.memory,
        provider,
        everySessions: positiveNumber("--dream-every-sessions", opts.dreamEverySessions ?? "10"),
        everyHours: positiveNumber("--dream-every-hours", opts.dreamEveryHours ?? "24"),
        ...(opts.dreamStructuralOnly === true ? { structuralOnly: true } : {}),
        onError: (err) => extras.onHookError?.(`dream failed (session still succeeded): ${err.message}`),
        onDone: (summary) => extras.onHookDone?.(`dream: ${summary}`),
      }),
    );
  }

  const agent = createAgent({
    provider,
    tools: [...builtinTools(), ...memoryToolset],
    // deny rules first so an explicit deny always wins
    permissions: new RulePolicy([
      ...toRules(opts.deny, "deny"),
      ...toRules(opts.allow, "allow"),
      // memory reads are confined to the wiki root by the store, not by cwd, so they cannot be
      // expressed as a cwdOnly rule; allow them by tool name instead
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
    ...(extras.onAsk === undefined ? {} : { onAsk: extras.onAsk }),
  });

  return { agent, provider, memoryIndex, ...(memoryStore === undefined ? {} : { memoryStore }) };
}
