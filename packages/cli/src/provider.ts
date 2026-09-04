import {
  AnthropicProvider,
  OpenAICompatibleProvider,
  OpenAIChatGPTProvider,
  type ModelProvider,
  type ReasoningEffort,
  type StreamRetryInfo,
} from "@agentkitai/agentrig-core";
import { ROLES, type ProviderEntry, type Role, type Roles } from "./config.js";

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";

/** The provider flags shared by every command that talks to a model, plus the R3.5a config keys. */
export interface ProviderOptions {
  provider: string;
  model: string;
  baseUrl?: string;
  contextWindow?: number;
  reasoningEffort?: ReasoningEffort;
  /** Named entries from config; the flat keys above are the implicit `default` entry. */
  providers?: Record<string, ProviderEntry>;
  roles?: Roles;
  /** True when the model came from --model or AGENTRIG_MODEL rather than the built-in default. */
  modelExplicit?: boolean;
  /** True when --provider/--model/--base-url or AGENTRIG_MODEL overrode config: main is then `default`. */
  providerOverride?: boolean;
  /** True when the user actually typed --max-tokens-per-turn; the flag has a default otherwise. */
  maxTokensPerTurnExplicit?: boolean;
  /** Named config profile; consumed by loadRunConfig. */
  profile?: string;
}

export interface ProviderHooks {
  /** Where retry notices go — the TUI frame or stderr. Silent retries look like hangs. */
  onNotice?: (message: string) => void;
}

/** One phrasing for every provider, so the three adapters cannot drift. */
export function describeRetry(info: StreamRetryInfo): string {
  // `attempt` is the one that just FAILED — saying "retrying (attempt 1 of 4)" when attempt 1
  // is already spent misread as "this is the first try"
  return `provider error (${info.reason}) — attempt ${info.attempt} of ${info.maxAttempts} failed, retrying in ${Math.round(info.delayMs / 1000)}s`;
}

export interface ResolvedEntries {
  entries: Record<string, ProviderEntry>;
  roleNames: Record<Role, string>;
}

/**
 * Pure: which entry each role resolves to. `default` is always present and is the flat keys;
 * `roles[r] ?? roles.main ?? "default"`; typed provider flags pin main to `default` so today's
 * `agentrig run --model x` keeps meaning "run the main loop on x".
 */
export function resolveProviderEntries(opts: ProviderOptions): ResolvedEntries {
  const defaultEntry: ProviderEntry = {
    provider: opts.provider as ProviderEntry["provider"],
    model: opts.model,
    ...(opts.baseUrl === undefined ? {} : { baseUrl: opts.baseUrl }),
    ...(opts.contextWindow === undefined ? {} : { contextWindow: opts.contextWindow }),
    ...(opts.reasoningEffort === undefined ? {} : { reasoningEffort: opts.reasoningEffort }),
  };
  const entries: Record<string, ProviderEntry> = { ...(opts.providers ?? {}), default: defaultEntry };
  const configured = (role: Role): string => opts.roles?.[role] ?? opts.roles?.main ?? "default";
  const roleNames = {
    main: opts.providerOverride === true ? "default" : configured("main"),
    supervisor: configured("supervisor"),
    memory: configured("memory"),
    subagents: configured("subagents"),
  } satisfies Record<Role, string>;
  for (const role of ROLES) {
    const name = roleNames[role];
    if (!(name in entries)) {
      throw new Error(
        `role ${role} names unknown provider entry ${JSON.stringify(name)}; defined entries: ${Object.keys(entries).sort().join(", ")}`,
      );
    }
  }
  return { entries, roleNames };
}

/** Constructs one entry. `requireExplicitModel` guards only the flat default, whose model has a built-in fallback. */
function buildEntry(name: string, entry: ProviderEntry, opts: ProviderOptions, hooks: ProviderHooks): ModelProvider {
  const onRetry =
    hooks.onNotice === undefined
      ? {}
      : { onRetry: (info: StreamRetryInfo) => hooks.onNotice?.(describeRetry(info)) };
  const tuning = {
    ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
    ...(entry.reasoningEffort === undefined ? {} : { reasoningEffort: entry.reasoningEffort }),
  };
  const modelExplicit = name !== "default" || opts.modelExplicit === true;
  if (entry.provider === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    return new AnthropicProvider({ apiKey, model: entry.model, ...(entry.baseUrl === undefined ? {} : { baseUrl: entry.baseUrl }), ...tuning, ...onRetry });
  }
  if (entry.provider === "openai") {
    if (!modelExplicit) throw new Error("--model is required with --provider openai");
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey && entry.baseUrl === undefined) {
      throw new Error("OPENAI_API_KEY is not set (or pass --base-url for a local server)");
    }
    return new OpenAICompatibleProvider({
      model: entry.model,
      ...(apiKey ? { apiKey } : {}),
      ...(entry.baseUrl === undefined ? {} : { baseUrl: entry.baseUrl }),
      ...tuning,
      ...onRetry,
    });
  }
  if (entry.provider === "openai-chatgpt") {
    if (!modelExplicit) throw new Error("--model is required with --provider openai-chatgpt (e.g. gpt-5.6-sol)");
    // experimental subscription auth; tokens come from `agentrig login openai-chatgpt`
    console.error("Warning: --provider openai-chatgpt is experimental and uses an undocumented ChatGPT backend.");
    // the backend rejects `max_output_tokens` outright, so the flag cannot be honoured here.
    // Say so rather than accepting a number and quietly not sending it.
    if (opts.maxTokensPerTurnExplicit === true) {
      console.error("Warning: --max-tokens-per-turn is ignored by openai-chatgpt (the backend rejects the parameter).");
    }
    return new OpenAIChatGPTProvider({ model: entry.model, ...(entry.baseUrl === undefined ? {} : { baseUrl: entry.baseUrl }), ...tuning, ...onRetry });
  }
  throw new Error(`unknown provider "${String(entry.provider)}" (anthropic | openai | openai-chatgpt)`);
}

/** Every role's provider, built once per entry. Roles are constructed eagerly; `get` builds lazily. */
export interface ProviderSet {
  main: ModelProvider;
  supervisor: ModelProvider;
  memory: ModelProvider;
  subagents: ModelProvider;
  /** Which entry each role resolved to, by name. */
  roleNames: Record<Role, string>;
  /** Every entry name, named ones in config order and `default` last — the spawn tool's menu. */
  names: string[];
  /** An entry by name, constructed on first use; throws for a name that is not an entry. */
  get(name: string): ModelProvider;
}

export function buildProviders(opts: ProviderOptions, hooks: ProviderHooks = {}): ProviderSet {
  const { entries, roleNames } = resolveProviderEntries(opts);
  const built = new Map<string, ModelProvider>();
  const get = (name: string): ModelProvider => {
    const entry = entries[name];
    if (entry === undefined) {
      throw new Error(`unknown provider entry ${JSON.stringify(name)}; defined entries: ${Object.keys(entries).sort().join(", ")}`);
    }
    let provider = built.get(name);
    if (provider === undefined) {
      provider = buildEntry(name, entry, opts, hooks);
      built.set(name, provider);
    }
    return provider;
  };
  const forRole = (role: Role): ModelProvider => {
    try {
      return get(roleNames[role]);
    } catch (err) {
      throw new Error(`role ${role} (provider entry ${JSON.stringify(roleNames[role])}): ${(err as Error).message}`);
    }
  };
  // eager, in a fixed order, so a broken entry fails the run before any session starts
  const main = forRole("main");
  const supervisor = forRole("supervisor");
  const memory = forRole("memory");
  const subagents = forRole("subagents");
  const names = [...Object.keys(entries).filter((n) => n !== "default"), "default"];
  return { main, supervisor, memory, subagents, roleNames, names, get };
}

/** The flat default entry alone — what every command built before R3.5a. */
export function buildProvider(opts: ProviderOptions, hooks: ProviderHooks = {}): ModelProvider {
  // strip the named entries so a bad `roles` block cannot fail a command that only wants the default
  const { providers: _providers, roles: _roles, ...flat } = opts;
  const { entries } = resolveProviderEntries(flat);
  return buildEntry("default", entries.default!, opts, hooks);
}
