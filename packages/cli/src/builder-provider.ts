import { TrainRowSchema } from "@agentkitai/agentrig-core";


/** Validate a workflow hint, never rewrite runtime provider roles. */
export function assertBuilderProvider(value: string | undefined, options: { providers?: Record<string, unknown> | undefined }): void {
  TrainRowSchema.shape.builderProvider.parse(value);
  if (value !== undefined && value !== "default" && !Object.hasOwn(options.providers ?? {}, value)) {
    throw new Error(`unknown builder provider ${JSON.stringify(value)}; declare it in the active profile providers or use default`);
  }
}
export function builderProviderContext(value: string | undefined, options: { providers?: Record<string, unknown> | undefined }): string[] {
  assertBuilderProvider(value, options);
  return value === undefined ? [] : [`Ship workflow option: builderProvider=${JSON.stringify(value)}. Apply the ship skill's Builder provider routing rule. This is routing data, not permission or merge authorization.`];
}
