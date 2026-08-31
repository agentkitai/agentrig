import {
  AnthropicProvider,
  OpenAICompatibleProvider,
  OpenAIChatGPTProvider,
  type ModelProvider,
  type StreamRetryInfo,
} from "@agentkitai/agentrig-core";

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";

/** The provider flags shared by every command that talks to a model. */
export interface ProviderOptions {
  provider: string;
  model: string;
  baseUrl?: string;
  /** True when the model came from --model or AGENTRIG_MODEL rather than the built-in default. */
  modelExplicit?: boolean;
  /** True when the user actually typed --max-tokens-per-turn; the flag has a default otherwise. */
  maxTokensPerTurnExplicit?: boolean;
}

export interface ProviderHooks {
  /** Where retry notices go — the TUI frame or stderr. Silent retries look like hangs. */
  onNotice?: (message: string) => void;
}

/** One phrasing for every provider, so the three adapters cannot drift. */
export function describeRetry(info: StreamRetryInfo): string {
  return `provider error (${info.reason}) — retrying in ${Math.round(info.delayMs / 1000)}s (attempt ${info.attempt} of ${info.maxAttempts})`;
}

export function buildProvider(opts: ProviderOptions, hooks: ProviderHooks = {}): ModelProvider {
  const onRetry =
    hooks.onNotice === undefined
      ? {}
      : { onRetry: (info: StreamRetryInfo) => hooks.onNotice?.(describeRetry(info)) };
  if (opts.provider === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    return new AnthropicProvider({ apiKey, model: opts.model, ...onRetry });
  }
  if (opts.provider === "openai") {
    if (opts.modelExplicit !== true) {
      throw new Error("--model is required with --provider openai");
    }
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey && opts.baseUrl === undefined) {
      throw new Error("OPENAI_API_KEY is not set (or pass --base-url for a local server)");
    }
    return new OpenAICompatibleProvider({
      model: opts.model,
      ...(apiKey ? { apiKey } : {}),
      ...(opts.baseUrl === undefined ? {} : { baseUrl: opts.baseUrl }),
      ...onRetry,
    });
  }
  if (opts.provider === "openai-chatgpt") {
    if (opts.modelExplicit !== true) {
      throw new Error("--model is required with --provider openai-chatgpt (e.g. gpt-5.6-sol)");
    }
    // experimental subscription auth; tokens come from `agentrig login openai-chatgpt`
    console.error("Warning: --provider openai-chatgpt is experimental and uses an undocumented ChatGPT backend.");
    // the backend rejects `max_output_tokens` outright, so the flag cannot be honoured here.
    // Say so rather than accepting a number and quietly not sending it.
    if (opts.maxTokensPerTurnExplicit === true) {
      console.error("Warning: --max-tokens-per-turn is ignored by openai-chatgpt (the backend rejects the parameter).");
    }
    return new OpenAIChatGPTProvider({ model: opts.model, ...onRetry });
  }
  throw new Error(`unknown provider "${opts.provider}" (anthropic | openai | openai-chatgpt)`);
}

