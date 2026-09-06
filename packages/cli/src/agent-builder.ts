import { join, resolve } from "node:path";
import { inspectPackages } from "./packages.js";
import { homedir } from "node:os";
import {
  assertShellExists,
  Checkpointer,
  builtinTools,
  createAgent,
  defaultRules,
  DockerSandboxProvider,
  NoneSandboxProvider,
  SandboxMode as SandboxModeSchema,
  SeatbeltSandboxProvider,
  RulePolicy,
  SessionStore,
  discoverSkills,
  discoverExtensions,
  loadExtensions,
  type ExtensionCommand,
  skillsInjection,
  skillTool,
  subagentTool,
  type Agent,
  type AnyTool,
  type AuxiliaryReport,
  type Budget,
  type Hook,
  type ModelProvider,
  type PermissionRequest,
  type Decision,
  type Pricing,
  type PermissionPolicy,
  type PromptBlock,
  type SandboxConfig,
  type SandboxMode,
  type Skill,
  type SubagentOptions,
} from "@agentkitai/agentrig-core";
import {
  dreamOnSessionEnd,
  FileMemoryStore,
  FileRawStore,
  indexInjection,
  ingestOnSessionEnd,
  memoryTools,
  type IngestLimits,
  type ScanLimits,
  type MaintenanceLimits,
  formatAuxiliaryUsage,
} from "@agentkitai/agentrig-memory";
import { readFile, realpath, stat, open } from "node:fs/promises";
import { z } from "zod";
import { McpClient, RemoteMcpClient, RemoteMcpConfigSchema, McpOAuthProvider, McpCredentialStore,
  FileMcpPins, connectServers, type McpServerConfig, type RemoteMcpConfig, type McpConnection } from "@agentkitai/agentrig-core";
import { buildProviders, type ProviderOptions, type ProviderSet } from "./provider.js";
import { openBackend } from "./memory.js";
import { buildPermissionPolicy, defaultSystemPrompt, positiveNumber } from "./run.js";
import { RESERVED_COMMAND_NAMES } from "./tui/commands.js";
import { acquireOtel, validateOtel } from "./otel.js";

function promptBlocks(options: {
  system: string;
  systemOrigin: string;
  skills: string;
  skillsOrigin: string;
  memory?: string;
}): PromptBlock[] {
  const blocks: PromptBlock[] = [{
    content: options.system,
    source: "system_prompt",
    origin: options.systemOrigin,
    authority: "instruction",
    reason: "base agent instructions",
  }];
  if (options.skills !== "") {
    blocks.push({
      content: options.skills,
      source: "skills_catalogue",
      origin: options.skillsOrigin,
      authority: "instruction",
      reason: "catalogue of skills available on demand",
    });
  }
  if (options.memory !== undefined && options.memory !== "") {
    blocks.push({
      content: options.memory,
      source: "memory_index",
      origin: "memory:wiki-index",
      authority: "data",
      reason: "compact index of durable project memory",
    });
  }
  return blocks;
}

/** Select the concrete OS boundary while keeping approval policy as an independent axis. */
export function buildSandbox(
  value: string,
  platform: NodeJS.Platform = process.platform,
  network = false,
): SandboxConfig {
  if (typeof network !== "boolean") throw new Error("sandbox network policy must be a boolean");
  const parsed = SandboxModeSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `invalid --sandbox mode ${JSON.stringify(value)}; expected read-only, workspace-write, or none`,
    );
  }
  const mode: SandboxMode = parsed.data;
  const grant = network ? { network: true } : {};
  if (mode === "none") return { mode, provider: new NoneSandboxProvider(), ...grant };
  if (platform === "linux") return { mode, provider: new DockerSandboxProvider(), ...grant };
  if (platform === "darwin") return { mode, provider: new SeatbeltSandboxProvider(), ...grant };
  throw new Error(
    `--sandbox ${mode} is not supported on ${platform}; use --sandbox none on this platform`,
  );
}

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
  /** Explicit CLI activation only; never loaded from config or environment. */
  otelEndpoint?: string;
  /** Runtime-only heartbeat profile; never accepted from project config fields. */
  heartbeat?: "empty" | "checklist";
  extension?: string[];
  /** Build cwd supplied by CLI config resolution, not provider credentials or session state. */
  extensionCwd?: string;
  extensionDiscovery?: boolean;
  root: string;
  memory?: string;
  system?: string;
  allow?: string[];
  allowCommand?: string[][];
  deny?: string[];
  /** Allow everything nothing else matched, rather than asking. `--deny` still wins. */
  dangerouslySkipPermissions?: boolean;
  /** The same thing, spelled the way people type it. */
  yolo?: boolean;
  /** OS execution boundary, independent of permission approvals. Defaults to none. */
  sandbox?: SandboxMode;
  /** Explicit network policy for the sandbox, independent of --allow/--yolo. */
  sandboxNetwork?: boolean;
  /** Opt-in raw checkpoints and terminal ownership receipts; requires stopped external writers. */
  checkpoints?: boolean;
  diagnostics?: import("@agentkitai/agentrig-core").DiagnosticsConfig;
  maxTurns: string;
  maxTokens?: string;
  maxMinutes?: string;
  maxUsd?: string;
  priceIn?: string;
  priceOut?: string;
  priceCacheRead?: string;
  priceCacheWrite?: string;
  maxTokensPerTurn: string;
  ingestOnEnd?: boolean;
  ingestLimits?: Partial<IngestLimits>;
  ingestSpanChars?: string;
  dreamOnEnd?: boolean;
  dreamEverySessions?: string;
  dreamEveryHours?: string;
  dreamStructuralOnly?: boolean;
  dreamScanLimits?: Partial<ScanLimits>;
  dreamLimits?: Partial<MaintenanceLimits>;
  /** Path to a JSON file of MCP servers (PLAN §6's MCP client row). */
  mcpConfig?: string;
  /** Give the agent a `subagent` tool for context-isolated sub-tasks. */
  subagents?: boolean;
  subagentMaxTurns?: string;
  /** How many subagents one session may run. The backstop when tokens are not metered. */
  subagentMaxChildren?: string;
  /** Directories to discover markdown skills in (repeatable). */
  skills?: string[];
  /**
   * Whether config resolution appends the conventional `.agentrig/skills` directories (trusted
   * project root, then home) after the explicit ones. Consumed by `loadRunConfig`, which folds
   * the discovered dirs into `skills` — by the time an agent is built, `skills` is final.
   */
  skillDiscovery?: boolean;
  /** Opt-in generated roots, resolved by loadRunConfig. A label confers no authority. */
  generatedSkills?: boolean;
  /** Trusted-project installed bundles; no registry or implicit prompt injection. Default on. */
  packages?: boolean;
  /** Internal config-resolution insertion point before home/generated roots. */
  packageSkillIndex?: number;
  /** Which shell the `bash` tool runs commands in (PLAN §9 F2). Defaults per platform. */
  shell?: string;
  /** Canonical root approved by the CLI trust boundary; absent means no project context. */
  trustedProjectRoot?: string;
  /** Inject the mechanical repository map. Defaults on; config or `--no-repo-map` may disable it. */
  repoMap?: boolean;
}

const McpServerEntry = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
});
const McpEntry = z.union([McpServerEntry.strict(), RemoteMcpConfigSchema.omit({ name: true })]);

/**
 * Both spellings, because the ecosystem has two: Claude Code and Cursor use `mcpServers`, while
 * VS Code's `.vscode/mcp.json` uses `servers`. Accepting only one — with a `.default({})` on top —
 * meant pointing the flag at a working Claude Code config produced a silently tool-less session,
 * no error, no warning. Neither key present is now a hard failure naming both.
 */
const McpConfigFile = z.object({
  servers: z.record(McpEntry).optional(),
  mcpServers: z.record(McpEntry).optional(),
});

export function parseMcpConfigText(path: string, text: string): Array<McpServerConfig | RemoteMcpConfig> {
  if (Buffer.byteLength(text) > 1_048_576) throw new Error("MCP config exceeds 1 MiB");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // MCP env blocks can contain credentials. JSON parser context must never reach diagnostics.
    throw new Error(`${path} is not a valid MCP config: malformed JSON`);
  }
  const parsed = McpConfigFile.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${path} is not a valid MCP config: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  }
  const servers = parsed.data.mcpServers ?? parsed.data.servers;
  if (servers === undefined) {
    throw new Error(`${path} has no "mcpServers" (or "servers") key; nothing to connect to`);
  }
  if (Object.keys(servers).length > 16) throw new Error("MCP config exceeds 16 servers");
  // `exactOptionalPropertyTypes`: an absent key and an explicit `undefined` are different types,
  // so optional fields are spread in only when present
  return Object.entries(servers).map(([name, cfg]) => "url" in cfg ? RemoteMcpConfigSchema.parse({ name, ...cfg }) : ({
    name,
    command: cfg.command,
    ...(cfg.args === undefined ? {} : { args: cfg.args }),
    ...(cfg.env === undefined ? {} : { env: cfg.env }),
    ...(cfg.cwd === undefined ? {} : { cwd: cfg.cwd }),
    ...(cfg.timeoutMs === undefined ? {} : { timeoutMs: cfg.timeoutMs }),
  }));
}

export async function readMcpConfig(path: string): Promise<Array<McpServerConfig | RemoteMcpConfig>> {
  let text: string;
  try {
    const before = await stat(path);
    if (!before.isFile() || before.size > 1_048_576) throw new Error("MCP config must be a regular file within 1 MiB");
    const handle = await open(path, "r");
    try {
      const actual = await handle.stat();
      if (!actual.isFile() || actual.ino !== before.ino || actual.dev !== before.dev) throw new Error("MCP config changed during read");
      const buffer = Buffer.alloc(1_048_577); let offset = 0;
      while (offset < buffer.length) { const read = await handle.read(buffer, offset, buffer.length - offset, null); if (!read.bytesRead) break; offset += read.bytesRead; }
      if (offset > 1_048_576) throw new Error("MCP config exceeds 1 MiB");
      text = buffer.subarray(0, offset).toString("utf8");
    } finally { await handle.close(); }
  } catch (err) {
    throw new Error(`could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return parseMcpConfigText(path, text);
  } catch (error) {
    if (error instanceof Error && error.message.endsWith("malformed JSON")) {
      throw new Error(`could not read ${path}: malformed JSON`);
    }
    throw error;
  }
}

export interface BuiltAgent {
  closeTelemetry?(): Promise<void>;
  /** Same actual policy used by the runtime; read-only operator surfaces must not bypass denies. */
  permissions?: PermissionPolicy;
  agent: Agent;
  provider: ModelProvider;
  /** Every role's provider (R3.5a); `provider` is `providers.main`. */
  providers: ProviderSet;
  /** The tools the agent was given. Exposed so the wiring can be asserted rather than assumed. */
  tools: AnyTool[];
  /** The discovered skill catalogue, so the TUI can serve /skills and /<skill-name> (issue #62). */
  skills: Skill[];
  commands?: Array<ExtensionCommand & { extension: string }>;
  memoryIndex: string;
  memoryStore?: FileMemoryStore;
  /** Connected MCP servers, so the caller can shut them down when the session ends. */
  mcp: McpConnection[];
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
  if (
    opts.priceIn !== undefined
    || opts.priceOut !== undefined
    || opts.priceCacheRead !== undefined
    || opts.priceCacheWrite !== undefined
  ) {
    if (opts.priceIn === undefined || opts.priceOut === undefined) {
      throw new Error("--price-in and --price-out must be given together");
    }
    pricing = {
      inputUsdPerMTok: positiveNumber("--price-in", opts.priceIn),
      outputUsdPerMTok: positiveNumber("--price-out", opts.priceOut),
      ...(opts.priceCacheRead === undefined
        ? {}
        : { cacheReadUsdPerMTok: positiveNumber("--price-cache-read", opts.priceCacheRead) }),
      ...(opts.priceCacheWrite === undefined
        ? {}
        : { cacheWriteUsdPerMTok: positiveNumber("--price-cache-write", opts.priceCacheWrite) }),
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
  signal?: AbortSignal;
  /** Trusted host user-state override, never model/project credential material. */
  mcpCredentialRoot?: string;
  onQuestion?: import("@agentkitai/agentrig-core").QuestionHandler;
  permissionGrants?: import("@agentkitai/agentrig-core").PermissionGrantRegistry;
  /** Trusted host override for isolated state; never loaded from project config. */
  mcpPinRoot?: string;
  /** Trusted ACP adapter: exact-matched subset only; scope still comes from mcpConfig. */
  mcpServers?: McpServerConfig[];
  mcpExistingPinsOnly?: boolean;
  onAsk?: import("@agentkitai/agentrig-core").AgentConfig["onAsk"];
  /** Before Ink/controller startup. Must not enqueue a prompt into an unmounted UI. */
  onStartupAsk?: import("@agentkitai/agentrig-core").AgentConfig["onAsk"];
  extraHooks?: Hook[];
  onHookError?: (message: string) => void;
  onHookDone?: (message: string) => void;
  /** Runtime reporting only; not installed from project config or model content. */
  onIngestUsage?: (report: AuxiliaryReport | undefined, final: boolean) => void;
  /** Provider-retry notices ("overloaded — retrying in 2s"); silence is what made retries look like hangs. */
  onNotice?: (message: string) => void;
}


export interface SubagentWiring {
  opts: AgentBuildOptions;
  extras: AgentExtras;
  budget: Budget;
  pricing?: Pricing;
  providers: ProviderSet;
  permissionPolicy: PermissionPolicy;
  sandbox?: SandboxConfig;
  skills: Skill[];
  maxTokensPerTurn: number;
  /** The tools a child inherits, minus skills — rebuilt per child so nothing is shared by accident. */
  childTools: () => AnyTool[];
}

/**
 * How a child is bounded and what it inherits. Exported because this is the whole of the
 * subagent wiring, and every property worth having is a property of this object: a child that
 * can spawn is a fork bomb, a child with no budget is unbounded spend, and a child whose asks
 * are answered by nobody is a `--subagents` that cannot write a file.
 */
export function subagentOptions(w: SubagentWiring): SubagentOptions {
  // A child is a separate session with a separate meter, so the parent's budget cannot bind it.
  // The bound is stated here instead: all of one session's children together may not spend more
  // than the parent's own budget, so each child gets a SHARE of it. Giving each child the whole
  // allowance would let one spawn spend it, and — since the pool reserves a child's cap when it
  // starts — would make the first subagent the only one.
  const maxChildren = positiveNumber("--subagent-max-children", w.opts.subagentMaxChildren ?? "8");
  const childBudget: Omit<Budget, "maxTurns"> = {};
  if (w.budget.maxTokens !== undefined) {
    childBudget.maxTokens = Math.max(1, Math.floor(w.budget.maxTokens / maxChildren));
  }
  if (w.budget.maxUsd !== undefined) childBudget.maxUsd = w.budget.maxUsd / maxChildren;
  // wall clock, not an amount to divide: a child may take as long as the parent has left
  if (w.budget.maxMinutes !== undefined) childBudget.maxMinutes = w.budget.maxMinutes;

  return {
    createAgent,
    maxTurns: positiveNumber("--subagent-max-turns", w.opts.subagentMaxTurns ?? "15"),
    childBudget,
    ...(w.pricing === undefined ? {} : { pricing: w.pricing }),
    maxChildren,
    ...(w.budget.maxTokens === undefined ? {} : { maxChildTokens: w.budget.maxTokens }),
    ...(w.budget.maxUsd === undefined ? {} : { maxChildUsd: w.budget.maxUsd }),
    // a child gets the SUBAGENTS role's provider by default, or the entry the parent named at
    // spawn time; it never silently inherits the parent's own entry (R3.5a). Tools and permissions
    // are the parent's, but NOT the ability to spawn — `subagentTool` builds that at depth + 1.
    ...(w.opts.providers !== undefined && Object.keys(w.opts.providers).length > 0
      ? { providerChoices: { names: w.providers.names, default: w.providers.roleNames.subagents, main: w.providers.roleNames.main } }
      : {}),
    childConfig: (choice) => ({
      provider: choice?.provider === undefined ? w.providers.subagents : w.providers.get(choice.provider),
      // skills too: a subagent doing a task the project has instructions for should be able to
      // load them, and the catalogue costs one line each
      tools: [...w.childTools(), ...(w.skills.length > 0 ? [skillTool(w.skills)] : [])],
      permissions: w.permissionPolicy,
      ...(w.extras.permissionGrants === undefined ? {} : { permissionGrants: w.extras.permissionGrants }),
      ...(w.sandbox === undefined ? {} : { sandbox: w.sandbox }),
      // Explicit base policy stays shared; the actual subagent derives a filtered live grant
      // view and forwards it as same-call context to this asker. A child that could do MORE than its parent
      // is a permission bypass; a child that can do LESS is the failure this originally had —
      // `onAsk` defaults to deny, so an interactive parent got a subagent that could not write a
      // file, was never prompted about it, and could not say why. `origin` is set on the config
      // rather than wrapped around `onAsk`, so the emitted `permission.request` carries it too:
      // the prompt, the log and `sessions show` then agree on who asked.
      origin: "subagent",
      ...(w.opts.trustedProjectRoot === undefined ? {} : { trustedProjectRoot: w.opts.trustedProjectRoot }),
      repoMap: w.opts.repoMap === false ? false : {},
      ...(w.extras.onAsk === undefined ? {} : { onAsk: w.extras.onAsk }),
      ...(w.extras.onQuestion === undefined ? {} : { onQuestion: w.extras.onQuestion }),
      systemPrompt: (ctx: { cwd: string }) => promptBlocks({
        system: [
          "You are a subagent. You have been given one self-contained task and none of the",
          "parent conversation. Do the task, then reply with the answer and no tool calls —",
          "your final message is all the parent receives.",
          `Working directory: ${ctx.cwd}`,
        ].join("\n"),
        systemOrigin: "cli:subagent-default",
        skills: skillsInjection(w.skills),
        skillsOrigin: (w.opts.skills ?? []).join(",") || "skills:discovered",
      }),
      store: new SessionStore({ root: w.opts.root }),
      maxTokensPerTurn: w.maxTokensPerTurn,
    }),
  };
}

/** Assembles the agent. Throws on a bad flag or a missing credential; callers report and exit. */
export function heartbeatBuildOptions<T extends AgentBuildOptions>(opts: T): T {
  if (opts.heartbeat === undefined) return opts;
  const safe = { ...opts };
  // Heartbeat uses the built-in shell default, not a custom configured shell profile.
  delete safe.memory; delete safe.mcpConfig; delete safe.shell;
  const main = opts.providerOverride === true ? "default" : opts.roles?.main ?? "default";
  return Object.assign(safe, { extension: [], extensionDiscovery: false, skills: [], skillDiscovery: false,
    generatedSkills: false, packages: false, subagents: false, checkpoints: false, diagnostics: [],
    ingestOnEnd: false, dreamOnEnd: false, repoMap: false,
    roles: { main, supervisor: main, memory: main, subagents: main },
    ...(opts.heartbeat === "empty" ? { maxTurns: "1" } : {}), maxTokens: "10000", maxMinutes: "5" });
}

export async function buildAgent(opts: AgentBuildOptions, extras: AgentExtras = {}): Promise<BuiltAgent> {
  validateOtel(opts);
  if (opts.mcpConfig !== undefined && opts.sandbox !== undefined && opts.sandbox !== "none" && opts.sandboxNetwork !== true)
    throw new Error("MCP servers start in the host process outside the tool sandbox; remote HTTP requires explicit --sandbox-network and network permission; stdio requires --sandbox none");
  opts = heartbeatBuildOptions(opts);
  const installed = opts.packages === false || opts.trustedProjectRoot === undefined
    ? { packages: [], errors: [] } : await inspectPackages(opts.trustedProjectRoot);
  for (const error of installed.errors) (extras.onNotice ?? console.error)(`package discovery: ${error}`);
  const extensionCandidates = [
    ...(opts.extension ?? []).map(path => ({ path, precedence: 0 })),
    ...(opts.extensionDiscovery !== false && opts.trustedProjectRoot !== undefined ? await discoverExtensions(opts.trustedProjectRoot) : []),
    ...(opts.extensionDiscovery === false ? [] : installed.packages.flatMap(pkg => pkg.extensions.map(path => ({ path, precedence: 2 })))),
  ];
  if (extensionCandidates.length > 0 && opts.sandbox !== undefined && opts.sandbox !== "none") {
    throw new Error("extensions execute ambient host code outside the sandbox; remove extensions or explicitly select --sandbox none (YOLO does not override this)");
  }
  const { budget, pricing, maxTokensPerTurn } = parseBudget(opts);
  const providers = buildProviders(opts, extras.onNotice === undefined ? {} : { onNotice: extras.onNotice });
  const provider = providers.main;

  let memoryIndex = "";
  let memoryToolset: AnyTool[] = [];
  let memoryStore: FileMemoryStore | undefined;
  if (opts.memory !== undefined) {
    memoryStore = new FileMemoryStore({ root: join(opts.memory, "wiki") });
    memoryIndex = await indexInjection(memoryStore).catch(() => "");
    let backend = openBackend({ onError: (op, err) => extras.onHookError?.(`lore ${op} failed (continuing): ${err.message}`) });
    if (backend !== null && opts.sandbox !== undefined && opts.sandbox !== "none") {
      backend = null;
      extras.onNotice?.("sandbox: Lore recall is disabled; local memory read/search remain available");
    }
    memoryToolset = memoryTools({
      store: memoryStore,
      raw: new FileRawStore({ root: opts.memory }),
      ...(backend === null ? {} : { backend }),
    });
  }

  // MCP servers (PLAN §6). A server that fails to start costs its own tools and nothing else —
  // one broken entry in a config file must not stop the agent from running.
  let mcpTools: AnyTool[] = [];
  let mcp: McpConnection[] = [];
  let mcpSkills: Skill[] = [];
  if (opts.mcpConfig !== undefined) {
    const configs = extras.mcpServers ?? await readMcpConfig(opts.mcpConfig);
    if (opts.sandbox !== undefined && opts.sandbox !== "none" && configs.some(c => !("url" in c)))
      throw new Error("MCP servers start in the host process outside the tool sandbox; remove --mcp-config or explicitly select --sandbox none");
    const startupPolicy = buildPermissionPolicy(opts);
    const servers: McpConnection[] = [];
    for (const c of configs) {
      if (!("url" in c)) { servers.push(new McpClient(c, { onError: e => extras.onHookError?.(`mcp: ${e.message}`) })); continue; }
      const oauth = c.oauth ? new McpOAuthProvider(c, new McpCredentialStore(extras.mcpCredentialRoot ?? join(homedir(), ".agentrig", "mcp-auth"), new URL(c.url).href)) : undefined;
      servers.push(new RemoteMcpClient(c, {
        ...(extras.signal ? { signal: extras.signal } : {}), ...(oauth ? { oauth } : {}),
        authorizeStart: async () => {
          extras.signal?.throwIfAborted();
          if (opts.sandbox !== undefined && opts.sandbox !== "none" && opts.sandboxNetwork !== true)
            throw new Error("MCP trusted host fetch requires explicit sandbox network policy");
          const req = { tool: `mcp_connect_${c.name}`, class: "net" as const, cwd: process.cwd(),
            input: { endpoint: c.url, issuers: c.oauth?.issuers ?? [], endpointOrigins: c.oauth?.endpointOrigins ?? [], operation: "MCP discovery and catalog (not tool execution)" } };
          extras.onNotice?.(`MCP startup network endpoint: ${c.url}; OAuth issuers: ${JSON.stringify(c.oauth?.issuers ?? [])}`);
          const base = await startupPolicy.decide(req);
          const decision = base === "ask" ? await extras.onStartupAsk?.(req) ?? "deny" : base;
          extras.onNotice?.(`MCP ${JSON.stringify(c.name)} startup net: ${decision}; trusted host HTTP, not OS-contained`);
          return decision === "allow";
        },
      }));
    }
    const connected = await connectServers({
      servers,
      pins: new FileMcpPins(extras.mcpPinRoot ?? join(homedir(), ".agentrig", "mcp-pins"), await realpath(opts.mcpConfig)),
      ...(extras.mcpExistingPinsOnly === undefined ? {} : { requireExistingPins: extras.mcpExistingPinsOnly }),
      onDefinitionNotice: (message) => extras.onNotice?.(message),
      onDefinitionChange: async (change, ctx) => {
        // A separate user decision, never the ordinary allow/yolo policy. Server prose is data.
        return await extras.onAsk?.({
          tool: "mcp_definition_change",
          origin: "mcp-definition-change",
          class: "exec",
          cwd: ctx.cwd,
          input: { action: "Approve these changed MCP definitions? This does not approve tool execution or certify safety.", ...change },
        }) === "allow";
      },
      onError: (server, err) => extras.onHookError?.(`mcp ${server} unavailable (continuing): ${err.message}`),
    });
    mcpTools = connected.tools;
    mcp = connected.connected;
    mcpSkills = connected.skills;
  }

  try {
    extras.signal?.throwIfAborted();
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
  const sandbox = buildSandbox(opts.sandbox ?? "none", process.platform, opts.sandboxNetwork ?? false);
  const permissionPolicy = buildPermissionPolicy({
    ...(opts.allow === undefined ? {} : { allow: opts.allow }),
    ...(opts.allowCommand === undefined ? {} : { allowCommand: opts.allowCommand }),
    ...(opts.deny === undefined ? {} : { deny: opts.deny }),
    ...(opts.dangerouslySkipPermissions === undefined
      ? {}
      : { dangerouslySkipPermissions: opts.dangerouslySkipPermissions }),
    ...(opts.yolo === undefined ? {} : { yolo: opts.yolo }),
    extra:
      memoryToolset.length === 0
        ? []
        : [
            { tool: "memory_search", decision: "allow" as const },
            { tool: "memory_read", decision: "allow" as const },
          ],
  });

  const hooks: Hook[] = opts.heartbeat === undefined ? [...(extras.extraHooks ?? [])] : [];
  if (opts.checkpoints === true) hooks.push(new Checkpointer());
  if (opts.memory !== undefined && opts.ingestOnEnd === true) {
    const backend = openBackend({ tolerate: false, onError: (op, err) => extras.onHookError?.(`lore ${op} failed (continuing): ${err.message}`) });
    hooks.push(
      ingestOnSessionEnd({
        dir: opts.memory,
        sessionDir: opts.root,
        provider: providers.memory,
        ...(opts.ingestLimits === undefined ? {} : { limits: opts.ingestLimits }),
        ...(opts.ingestSpanChars === undefined ? {} : { maxSpanChars: Number(opts.ingestSpanChars) }),
        ...(backend === null ? {} : { backend }),
        onError: (err) => extras.onHookError?.(`memory ingest failed (session still succeeded): ${err.message}`),
        onBackendError: (op, err) => extras.onHookError?.(`memory ingest: lore ${op} failed (continuing): ${err.message}`),
        onDone: (summary) => extras.onHookDone?.(`memory: ${summary}`),
        onUsage: report => extras.onIngestUsage?.(report, false),
        onSettled: report => extras.onIngestUsage?.(report, true),
      }),
    );
  }
  if (opts.memory !== undefined && opts.dreamOnEnd === true) {
    hooks.push(
      dreamOnSessionEnd({
        dir: opts.memory,
        provider: providers.memory,
        everySessions: positiveNumber("--dream-every-sessions", opts.dreamEverySessions ?? "10"),
        everyHours: positiveNumber("--dream-every-hours", opts.dreamEveryHours ?? "24"),
        ...(opts.dreamStructuralOnly === true ? { structuralOnly: true } : {}),
        ...(opts.dreamScanLimits === undefined ? {} : { scanLimits: opts.dreamScanLimits }),
        ...(opts.dreamLimits === undefined ? {} : { limits: opts.dreamLimits }),
        onUsage: report => extras.onHookDone?.(formatAuxiliaryUsage(report)),
        onError: (err) => extras.onHookError?.(`dream warning or failure (session still succeeded): ${err.message}`),
        onDone: (summary) => extras.onHookDone?.(`dream: ${summary}`),
      }),
    );
  }

  // The subagent tool needs an agent config to build children from, and that config is the one
  // being built — so it is added after, closing over a factory rather than a value.
  // Skills (PLAN §6): the catalogue rides in the system prompt one line each, and the body is
  // fetched on demand — the same index-first shape as the wiki, for the same reason. Twenty
  // skills of a thousand words each would cost more context than the task.
  const baseRoots = opts.skills ?? [];
  const insertion = Math.max(0, Math.min(opts.packageSkillIndex ?? baseRoots.length, baseRoots.length));
  const packageRoots = opts.skillDiscovery === false || baseRoots.length === 0 ? []
    : installed.packages.flatMap(pkg => pkg.skills).filter(path => !baseRoots.some(root => resolve(root) === resolve(path)));
  const skillRoots = [...baseRoots.slice(0, insertion), ...packageRoots, ...baseRoots.slice(insertion)];
  // Resolve every priority before the loader deduplicates aliases. Otherwise a removed
  // explicit/project alias shifts home onto the package group's priority and rejects its winner.
  const rootPrecedence = new Map<string, number>();
  for (const [index, path] of skillRoots.entries()) {
    const key = resolve(path);
    if (!rootPrecedence.has(key)) rootPrecedence.set(key, packageRoots.includes(path) ? insertion : index);
  }
  const skills = skillRoots.length === 0
    ? []
    : await discoverSkills({
        roots: skillRoots,
        rootPrecedence,
        onError: (err) => extras.onHookError?.(`skill discovery: ${err.message}`),
      });
  if (mcpSkills.some(remote => skills.some(local => local.name.toLowerCase() === remote.name.toLowerCase())))
    throw new Error("MCP prompt skill conflicts with a local skill; refusing ambiguous activation");
  skills.push(...mcpSkills);

  // validated once, here, rather than failing on every bash call with an ENOENT that names
  // neither the flag nor the file
  const shell = opts.shell === undefined ? undefined : assertShellExists(opts.shell);
  const builtins = (): AnyTool[] => builtinTools({ ...(shell === undefined ? {} : { shell }),
    ...(opts.heartbeat === undefined ? {} : { questions: false }),
    ...(opts.diagnostics === undefined ? {} : { diagnostics: opts.diagnostics }) });

  let telemetry: ReturnType<typeof acquireOtel>;
  const observeSession = (session: import("@agentkitai/agentrig-core").Session) => telemetry?.observe(session);
  const tools: AnyTool[] = opts.heartbeat === "empty" ? [] : [...builtins(), ...memoryToolset, ...mcpTools];
  if (skills.length > 0) tools.push(skillTool(skills));
  if (opts.subagents === true) {
    tools.push(
      subagentTool(
        (() => { const options = subagentOptions({
          opts,
          extras,
          budget,
          ...(pricing === undefined ? {} : { pricing }),
          providers,
          permissionPolicy,
          sandbox,
          skills,
          maxTokensPerTurn,
          childTools: () => [...builtins(), ...memoryToolset, ...mcpTools],
        }); return { ...options, childConfig: choice => ({ ...options.childConfig(choice), observeSession }) }; })(),
      ),
    );
  }

  const extensions = await loadExtensions({ candidates: extensionCandidates,
    session: { cwd: opts.extensionCwd ?? process.cwd(), provider: { id: provider.id, model: provider.model } },
    builtinToolNames: new Set(tools.map(tool => tool.name)), reservedCommandNames: RESERVED_COMMAND_NAMES,
    onNotice: extras.onNotice ?? (message => console.error(message)),
  });
  hooks.push(...extensions.loaded.flatMap(extension => extension.hooks));
  tools.push(...extensions.loaded.flatMap(extension => extension.tools));
  const commands = extensions.loaded.flatMap(extension => extension.commands.map(command => ({ ...command, extension: extension.name })));
  for (const command of commands) if (skills.some(skill => skill.name.toLowerCase() === command.name)) {
    (extras.onNotice ?? console.error)(`extension command /${command.name} shadows the skill slash command; skill tool remains available`);
  }
  const agent = createAgent({
    ...(opts.otelEndpoint === undefined ? {} : { observeSession }),
    extensions,
    provider,
    tools,
    ...(opts.trustedProjectRoot === undefined ? {} : { trustedProjectRoot: opts.trustedProjectRoot }),
    repoMap: opts.repoMap === false ? false : {},
    // deny rules first so an explicit deny always wins
    permissions: permissionPolicy,
    ...(extras.permissionGrants === undefined ? {} : { permissionGrants: extras.permissionGrants }),
    sandbox,
    // a function so a resumed session gets its snapshot's cwd, not this process's
    systemPrompt: (ctx) => promptBlocks({
      system: opts.system ?? defaultSystemPrompt(ctx.cwd),
      systemOrigin: opts.system === undefined ? "cli:default-system" : "cli:--system",
      skills: skillsInjection(skills),
      skillsOrigin: (opts.skills ?? []).join(",") || "skills:discovered",
      memory: memoryIndex,
    }),
    store: new SessionStore({ root: opts.root }),
    ...(hooks.length === 0 ? {} : { hooks }),
    budget,
    ...(pricing === undefined ? {} : { pricing }),
    maxTokensPerTurn,
    ...(extras.onAsk === undefined ? {} : { onAsk: extras.onAsk }),
    ...(extras.onQuestion === undefined ? {} : { onQuestion: extras.onQuestion }),
  });

  telemetry = acquireOtel(opts, extras.onNotice ?? console.error);
  return { agent, ...(telemetry === undefined ? {} : { closeTelemetry: telemetry.close }), permissions: permissionPolicy, provider, providers, tools, skills, commands, memoryIndex, mcp, ...(memoryStore === undefined ? {} : { memoryStore }) };
  }
}
