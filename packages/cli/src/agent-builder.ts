import { join } from "node:path";
import {
  builtinTools,
  createAgent,
  defaultRules,
  RulePolicy,
  SessionStore,
  discoverSkills,
  skillsInjection,
  skillTool,
  subagentTool,
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
  /** Give the agent a `subagent` tool for context-isolated sub-tasks. */
  subagents?: boolean;
  subagentMaxTurns?: string;
  /** Directories to discover markdown skills in (repeatable). */
  skills?: string[];
}

const McpServerEntry = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

/**
 * Both spellings, because the ecosystem has two: Claude Code and Cursor use `mcpServers`, while
 * VS Code's `.vscode/mcp.json` uses `servers`. Accepting only one — with a `.default({})` on top —
 * meant pointing the flag at a working Claude Code config produced a silently tool-less session,
 * no error, no warning. Neither key present is now a hard failure naming both.
 */
const McpConfigFile = z.object({
  servers: z.record(McpServerEntry).optional(),
  mcpServers: z.record(McpServerEntry).optional(),
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
  const servers = parsed.data.mcpServers ?? parsed.data.servers;
  if (servers === undefined) {
    throw new Error(`${path} has no "mcpServers" (or "servers") key; nothing to connect to`);
  }
  // `exactOptionalPropertyTypes`: an absent key and an explicit `undefined` are different types,
  // so optional fields are spread in only when present
  return Object.entries(servers).map(([name, cfg]) => ({
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

  try {
    return await assemble();
  } catch (err) {
    // anything after connectServers can throw (a bad --dream-every-* flag, a provider error),
    // and a caller that never receives `built` can never close what was already started
    await Promise.all(mcp.map((c) => c.close().catch(() => {})));
    throw err;
  }

  async function assemble(): Promise<BuiltAgent> {
  // one policy object, shared by parent and children: a subagent that could do more than its
  // parent would be a permission bypass with extra steps
  const permissionPolicy = new RulePolicy([
    ...toRules(opts.deny, "deny"),
    ...toRules(opts.allow, "allow"),
    ...(memoryToolset.length === 0
      ? []
      : [
          { tool: "memory_search", decision: "allow" as const },
          { tool: "memory_read", decision: "allow" as const },
        ]),
    ...defaultRules,
  ]);

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

  // The subagent tool needs an agent config to build children from, and that config is the one
  // being built — so it is added after, closing over a factory rather than a value.
  // Skills (PLAN §6): the catalogue rides in the system prompt one line each, and the body is
  // fetched on demand — the same index-first shape as the wiki, for the same reason. Twenty
  // skills of a thousand words each would cost more context than the task.
  const skills = opts.skills === undefined || opts.skills.length === 0
    ? []
    : await discoverSkills({
        roots: opts.skills,
        onError: (err) => extras.onHookError?.(`skill discovery: ${err.message}`),
      });

  const tools: AnyTool[] = [...builtinTools(), ...memoryToolset, ...mcpTools];
  if (skills.length > 0) tools.push(skillTool(skills));
  if (opts.subagents === true) {
    tools.push(
      subagentTool({
        createAgent,
        maxTurns: positiveNumber("--subagent-max-turns", opts.subagentMaxTurns ?? "15"),
        // a child gets the parent's provider, tools and permissions, but NOT the ability to
        // spawn its own — depth 1, checked in the tool
        childConfig: () => ({
          provider,
          tools: [...builtinTools(), ...memoryToolset, ...mcpTools],
          permissions: permissionPolicy,
          systemPrompt: (ctx: { cwd: string }) =>
            [
              "You are a subagent. You have been given one self-contained task and none of the",
              "parent conversation. Do the task, then reply with the answer and no tool calls —",
              "your final message is all the parent receives.",
              `Working directory: ${ctx.cwd}`,
            ].join("\n"),
          store: new SessionStore({ root: opts.root }),
          maxTokensPerTurn,
        }),
      }),
    );
  }

  const agent = createAgent({
    provider,
    tools,
    // deny rules first so an explicit deny always wins
    permissions: permissionPolicy,
    // a function so a resumed session gets its snapshot's cwd, not this process's
    systemPrompt: (ctx) =>
      [opts.system ?? defaultSystemPrompt(ctx.cwd), skillsInjection(skills), memoryIndex]
        .filter((s) => s !== "")
        .join("\n\n"),
    store: new SessionStore({ root: opts.root }),
    ...(hooks.length === 0 ? {} : { hooks }),
    budget,
    ...(pricing === undefined ? {} : { pricing }),
    maxTokensPerTurn,
    ...(extras.onAsk === undefined ? {} : { onAsk: extras.onAsk }),
  });

  return { agent, provider, memoryIndex, mcp, ...(memoryStore === undefined ? {} : { memoryStore }) };
  }
}
