import { z } from "zod";

/** The filesystem authority granted to one tool execution. */
export const SandboxMode = z.enum(["read-only", "workspace-write", "none"]);
export type SandboxMode = z.infer<typeof SandboxMode>;

/** Everything a provider needs to prepare one execution boundary. */
export interface SandboxPolicy {
  mode: SandboxMode;
  cwd: string;
}

/**
 * A deferred tool execution. Providers wrap this command with their OS/container boundary and
 * return another deferred command; core remains unaware of provider-specific process payloads.
 */
export type SandboxCommand<T> = () => Promise<T>;

/** OS sandbox seam. Permission approval happens separately, before this wrapper is prepared. */
export interface SandboxProvider {
  prepare<T>(cmd: SandboxCommand<T>, policy: SandboxPolicy): SandboxCommand<T>;
}

/**
 * Providers throw this only when their OS boundary denied an action. Ordinary tool failures keep
 * their existing tool.result behavior and must not be mislabeled as sandbox denials.
 */
export class SandboxDeniedError extends Error {
  override readonly name = "SandboxDeniedError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export interface SandboxConfig {
  provider: SandboxProvider;
  mode: SandboxMode;
}
