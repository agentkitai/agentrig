import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
import {
  SandboxDeniedError,
  type SandboxCommand,
  type SandboxPolicy,
  type SandboxProvider,
} from "./sandbox.js";

export type SandboxBackend = "none" | "docker" | "seatbelt";

export interface SandboxSpawnInvocation {
  command: string;
  args: string[];
  sandboxed: boolean;
}

type WrappedInvocation = Omit<SandboxSpawnInvocation, "sandboxed">;

type ActiveSandbox = {
  policy: SandboxPolicy;
  wrap(command: string, args: readonly string[], policy: SandboxPolicy): WrappedInvocation;
  denied(stderr: string): boolean;
};

const activeSandbox = new AsyncLocalStorage<ActiveSandbox>();

/**
 * Process-launching core tools call this immediately before spawn. A provider prepared around the
 * tool supplies the OS/container wrapper; outside a prepared command this is an identity operation.
 */
export function sandboxSpawnInvocation(
  command: string,
  args: readonly string[],
  _cwd: string,
): SandboxSpawnInvocation {
  const active = activeSandbox.getStore();
  if (active === undefined) return { command, args: [...args], sandboxed: false };
  // The prepared session policy is authoritative. A tool cannot widen the bind/write boundary by
  // handing its process launcher a different cwd.
  return {
    ...active.wrap(command, args, active.policy),
    sandboxed: true,
  };
}

/** Convert only backend-shaped process failures into the denial understood by the agent loop. */
export function throwIfSandboxDenied(stderr: string): void {
  const active = activeSandbox.getStore();
  if (active?.denied(stderr) === true) {
    throw new SandboxDeniedError(stderr.trim() || "operation denied by the OS sandbox");
  }
}

/** Explicit identity provider. Omitting AgentConfig.sandbox remains the default and is equivalent. */
export class NoneSandboxProvider implements SandboxProvider {
  readonly backend = "none";

  prepare<T>(cmd: SandboxCommand<T>, _policy: SandboxPolicy): SandboxCommand<T> {
    return cmd;
  }
}

abstract class ProcessSandboxProvider implements SandboxProvider {
  abstract readonly backend: Exclude<SandboxBackend, "none">;

  protected abstract wrap(
    command: string,
    args: readonly string[],
    policy: SandboxPolicy,
  ): WrappedInvocation;

  protected abstract denied(stderr: string): boolean;

  prepare<T>(cmd: SandboxCommand<T>, policy: SandboxPolicy): SandboxCommand<T> {
    if (policy.mode === "none") return cmd;
    const normalized = { ...policy, cwd: resolve(policy.cwd) };
    return () => activeSandbox.run({
      policy: normalized,
      wrap: (command, args, executionPolicy) => this.wrap(command, args, executionPolicy),
      denied: (stderr) => this.denied(stderr),
    }, cmd);
  }
}

export interface DockerSandboxProviderOptions {
  /** Override for tests or nonstandard installations. */
  command?: string;
  /** Image must contain the executable being wrapped. The provider never pulls implicitly itself. */
  image?: string;
}

/** Portable container boundary: read-only root, one cwd bind, and networking denied by default. */
export class DockerSandboxProvider extends ProcessSandboxProvider {
  readonly backend = "docker";
  private readonly command: string;
  private readonly image: string;

  constructor(options: DockerSandboxProviderOptions = {}) {
    super();
    this.command = options.command ?? "docker";
    this.image = options.image ?? "alpine:3.20";
  }

  protected wrap(command: string, args: readonly string[], policy: SandboxPolicy): WrappedInvocation {
    const cwd = resolve(policy.cwd);
    const bindMode = policy.mode === "workspace-write" ? "rw" : "readonly";
    return {
      command: this.command,
      args: [
        "run",
        "--rm",
        "--read-only",
        ...(policy.network === true ? [] : ["--network", "none"]),
        "--mount",
        `type=bind,src=${cwd},dst=${cwd},${bindMode}`,
        "--workdir",
        cwd,
        this.image,
        command,
        ...args,
      ],
    };
  }

  protected denied(stderr: string): boolean {
    return /read-only file system|operation not permitted|network is unreachable/iu.test(stderr);
  }
}

export interface SeatbeltSandboxProviderOptions {
  /** Override for tests or nonstandard installations. */
  command?: string;
}

function seatbeltString(value: string): string {
  // Seatbelt strings use the escaping needed for quotes, backslashes, and control characters.
  return JSON.stringify(value);
}

/** Build the profile separately so its least-authority shape is directly unit-testable off macOS. */
export function seatbeltProfile(policy: SandboxPolicy): string {
  const rules = [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow sysctl-read)",
    "(allow file-read*)",
    policy.network === true ? "(allow network*)" : "(deny network*)",
  ];
  if (policy.mode === "workspace-write") {
    rules.push(`(allow file-write* (subpath ${seatbeltString(resolve(policy.cwd))}))`);
  }
  return rules.join("\n");
}

/** macOS sandbox-exec boundary: cwd-only writes and networking denied by default. */
export class SeatbeltSandboxProvider extends ProcessSandboxProvider {
  readonly backend = "seatbelt";
  private readonly command: string;

  constructor(options: SeatbeltSandboxProviderOptions = {}) {
    super();
    this.command = options.command ?? "/usr/bin/sandbox-exec";
  }

  protected wrap(command: string, args: readonly string[], policy: SandboxPolicy): WrappedInvocation {
    return { command: this.command, args: ["-p", seatbeltProfile(policy), command, ...args] };
  }

  protected denied(stderr: string): boolean {
    return /sandbox(?:-exec)?:?.*deny/iu.test(stderr);
  }
}
