import { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";

/** The filesystem authority granted to one tool execution. */
export const SandboxMode = z.enum(["read-only", "workspace-write", "none"]);
export type SandboxMode = z.infer<typeof SandboxMode>;

/** Everything a provider needs to prepare one execution boundary. */
export interface SandboxPolicy {
  mode: SandboxMode;
  cwd: string;
  /** Network access is a separate grant and is denied by container/OS providers by default. */
  network?: boolean;
}

const executionPolicy = new AsyncLocalStorage<SandboxPolicy | undefined>();
/** Runtime policy established by the loop even when the provider is SDK-supplied. */
export function withSandboxPolicy<T>(policy: SandboxPolicy | undefined, command: () => T): T {
  return executionPolicy.run(policy, command);
}
export function currentSandboxPolicy(): SandboxPolicy | undefined {
  const policy = executionPolicy.getStore();
  return policy === undefined ? undefined : { ...policy };
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
 * An OS boundary denied an action, runtime policy forbids it, or a required enforcing execution
 * path is unavailable. Ordinary tool failures must not be mislabeled as sandbox denials.
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
  /** Grant network inside providers that otherwise deny it. */
  network?: boolean;
}
