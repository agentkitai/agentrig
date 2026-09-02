/**
 * Model-family fallbacks for OpenAI's published cache-read prices. Explicit Pricing cache rates
 * take precedence because providers can change prices and compatible endpoints set their own.
 */
export function openAiCacheReadDiscount(model: string): number | undefined {
  const normalized = model.toLowerCase();
  if (/^(?:gpt-5|codex)/.test(normalized)) return 0.1;
  if (/^(?:gpt-4\.1|o[134](?:-|$))/.test(normalized)) return 0.25;
  if (/^gpt-4o(?:-|$)/.test(normalized)) return 0.5;
  return undefined;
}
