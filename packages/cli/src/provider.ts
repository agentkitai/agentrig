import {
  AnthropicProvider,
  OpenAICompatibleProvider,
  OpenAIChatGPTProvider,
  type ModelProvider,
} from "@agentkitai/agentrig-core";

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";

/** The provider flags shared by every command that talks to a model. */
export interface ProviderOptions {
  provider: string;
  model: string;
  baseUrl?: string;
  /** True when the model came from --model or AGENTRIG_MODEL rather than the built-in default. */
  modelExplicit?: boolean;
}

export function buildProvider(opts: ProviderOptions): ModelProvider {
  if (opts.provider === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    return new AnthropicProvider({ apiKey, model: opts.model });
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
    });
  }
  if (opts.provider === "openai-chatgpt") {
    if (opts.modelExplicit !== true) {
      throw new Error("--model is required with --provider openai-chatgpt (e.g. gpt-5.6-sol)");
    }
    // experimental subscription auth; tokens come from `agentrig login openai-chatgpt`
    console.error("Warning: --provider openai-chatgpt is experimental and uses an undocumented ChatGPT backend.");
    return new OpenAIChatGPTProvider({ model: opts.model });
  }
  throw new Error(`unknown provider "${opts.provider}" (anthropic | openai | openai-chatgpt)`);
}

