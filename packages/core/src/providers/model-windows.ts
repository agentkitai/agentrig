/** Exact model IDs only: do not infer a window from family names or substrings.
 * Source: owner contract, Window-aware context (2026-09-24), gpt-6-astra = 1M.
 * Unlisted IDs are unknown, not confirmed to have the adapter fallback window.
 */
const MODEL_CONTEXT_WINDOWS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  openai: { "gpt-6-astra": 1_000_000 },
  "openai-chatgpt": { "gpt-6-astra": 1_000_000 },
};

export function modelContextWindow(provider: string, model: string, fallback: number): number {
  const models = Object.hasOwn(MODEL_CONTEXT_WINDOWS, provider) ? MODEL_CONTEXT_WINDOWS[provider] : undefined;
  return models && Object.hasOwn(models, model) ? models[model]! : fallback;
}
