import { ProviderSelectionInfoSchema, REASONING_EFFORTS, type ProviderSelection, type ProviderSelectionInfo, type ReasoningEffort } from "@agentkitai/agentrig-core";
import type { ProviderSet, ResolvedEntries } from "./provider.js";

export interface ProviderSelectionControl {
  current(): ProviderSelectionInfo;
  describe(): string[];
  /** Preparation never dispatches. Commit is separate so the controller can recheck its lifecycle. */
  prepare(kind: "model" | "effort", argument: string): () => ProviderSelectionInfo;
}
export function providerSelectionControl(providers: ProviderSet, table: ResolvedEntries, native: boolean) {
  let selected: ProviderSelection = { provider: providers.main, entry: table.roleNames.main,
    ...(table.entries[table.roleNames.main]?.reasoningEffort === undefined ? {} : { effort: table.entries[table.roleNames.main]!.reasoningEffort }) };
  const info = (value: ProviderSelection): ProviderSelectionInfo => ProviderSelectionInfoSchema.parse({ entry: value.entry,
    provider: value.provider.id, model: value.provider.model, ...(value.effort === undefined ? {} : { effort: value.effort }) });
  const control: ProviderSelectionControl = {
    current: () => info(selected),
    describe: () => [`Current provider: ${JSON.stringify(info(selected))}`,
      `Entries: ${providers.names.slice(0, 128).join(", ")}${providers.names.length > 128 ? " (further entries omitted)" : ""}`,
      `Roles: ${JSON.stringify(table.roleNames)}`, "Effort is an adapter setting; model/backend support is not verified."],
    prepare(kind, argument) {
      if (argument.length > 128 || /[\s\u0000-\u001f\u007f]/u.test(argument) || argument === "") throw new Error("expected one bounded configured entry or effort name");
      let entry = selected.entry, effort: ReasoningEffort | undefined;
      if (kind === "model") {
        const alias = Object.hasOwn(table.roleNames, argument) ? table.roleNames[argument as keyof typeof table.roleNames] : undefined;
        if (alias !== undefined && Object.hasOwn(table.entries, argument) && alias !== argument) throw new Error("ambiguous role and entry name");
        entry = alias ?? argument;
        if (!Object.hasOwn(table.entries, entry)) throw new Error("unknown configured provider entry");
        effort = table.entries[entry]!.reasoningEffort;
      } else {
        if (!REASONING_EFFORTS.includes(argument as ReasoningEffort)) throw new Error(`effort must be ${REASONING_EFFORTS.join(" | ")}`);
        effort = argument as ReasoningEffort;
      }
      const provider = providers.get(entry, kind === "effort" ? effort : undefined);
      if (native && provider.capabilities.nativeOutputSchema !== true) throw new Error("selected adapter does not support the opted-in native output mode");
      const next: ProviderSelection = { provider, entry, ...(effort === undefined ? {} : { effort }) };
      const metadata = info(next);
      return () => { selected = next; return metadata; };
    },
  };
  return { control, resolve: () => selected };
}
