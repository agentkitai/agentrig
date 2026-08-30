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
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { McpClient, connectServers, type McpServerConfig } from "@agentkitai/agentrig-core";
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
  /** Path to a JSON file of MCP servers (PLAN §6's MCP client row). */
  mcpConfig?: string;
}

/**
 * `{ "servers": { "<name>": { "command": "...", "args": [...], "env": {...} } } }` — the shape
 * Claude Code and Cursor use, so an existing config file works unchanged.
 */
const McpConfigFile = z.object({
  servers: z
    .record(
      z.object({
        command: z.string().min(1),
        args: z.array(z.string()).optional(),
        env: z.record(z.string()).optional(),
        cwd: z.string().optional(),
        timeoutMs: z.number().int().positive().optional(),
      }),
    )
    .default({}),
});

export async function readMcpConfig(path: string): Promise<McpServerConfig[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    throw new Error(`could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = McpConfigFile.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${path} is not a valid MCP config: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  }
  // `exactOptionalPropertyTypes`: an absent key and an explicit `undefined` are different types,
  // so optional fields are spread in only when present
  return Object.entries(parsed.data.servers).map(([name, cfg]) => ({
    name,
    command: cfg.command,
    ...(cfg.args === undefined ? {} : { args: cfg.args }),
    ...(cfg.env === undefined ? {} : { env: cfg.env }),
    ...(cfg.cwd === undefined ? {} : { cwd: cfg.cwd }),
    ...(cfg.timeoutMs === undefined ? {} : { timeoutMs: cfg.timeoutMs }),
  }));
}

export interface BuiltAgent {
  agent: Agent;
  provider: ModelProvider;
  memoryIndex: string;
  memoryStore?: FileMemoryStore;
  /** Connected MCP servers, so the caller can shut them down when the session ends. */
  mcp: McpClient[];
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

  // MCP servers (PLAN §6). A server that fails to start costs its own tools and nothing else —
  // one broken entry in a config file must not stop the agent from running.
  let mcpTools: AnyTool[] = [];
  let mcp: McpClient[] = [];
  if (opts.mcpConfig !== undefined) {
    const configs = await readMcpConfig(opts.mcpConfig);
    const connected = await connectServers({
      servers: configs.map((c) => new McpClient(c, { onError: (e) => extras.onHookError?.(`mcp: ${e.message}`) })),
      onError: (server, err) => extras.onHookError?.(`mcp ${server} unavailable (continuing): ${err.message}`),
    });
    mcpTools = connected.tools;
    mcp = connected.connected;
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
    tools: [...builtinTools(), ...memoryToolset, ...mcpTools],
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

  return { agent, provider, memoryIndex, mcp, ...(memoryStore === undefined ? {} : { memoryStore }) };
}
