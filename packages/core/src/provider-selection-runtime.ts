import type { AgentConfig } from "./agent.js";
import { assertSpendMeter } from "./spend-ledger.js";
import { ProviderSelectionInfoSchema, type ProviderSelectionInfo } from "./provider-selection.js";

/** Trusted host construction only. Sample once; a run/maintenance call keeps its concrete adapter. */
export function resolveAgentProvider(config: AgentConfig): { config: AgentConfig; selection?: ProviderSelectionInfo } {
  if (config.providerSelection === undefined) return { config };
  const chosen = config.providerSelection();
  const selection = Object.freeze(ProviderSelectionInfoSchema.parse({ entry: chosen.entry, provider: chosen.provider.id,
    model: chosen.provider.model, ...(chosen.effort === undefined ? {} : { effort: chosen.effort }) }));
  if (config.spend?.capMicros !== undefined) assertSpendMeter(chosen.provider, config.spend.ledger, config.spend.capMicros);
  if (config.outputContract?.mode === "native" && chosen.provider.capabilities.nativeOutputSchema !== true)
    throw new Error("Native output requires an explicitly opted-in supported adapter");
  const { providerSelection: _resolver, ...rest } = config;
  return { config: { ...rest, provider: chosen.provider }, selection };
}
