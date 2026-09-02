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
  /** The line of stderr that reads as a boundary denial under `policy`, or undefined. */
  denied(stderr: string, policy: SandboxPolicy): string | undefined;
};

/** How much of the child's own words the denial reason may carry. */
const DENIAL_EXCERPT_CHARS = 200;

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

/**
 * Convert only backend-shaped process failures into the denial understood by the agent loop.
 *
 * No provider can authenticate a child's stderr: a command can print "Read-only file system" and
 * exit 1 on purpose. So classification is narrowed to messages the ACTIVE policy would actually
 * produce (a network denial is not one under `network: true`), generic EPERM text is never
 * enough, and the reason carries its provenance so an escalation prompt (R2c) shows the human
 * that the words came from the command, not from the sandbox.
 */
export function throwIfSandboxDenied(stderr: string): void {
  const active = activeSandbox.getStore();
  if (active === undefined) return;
  const line = active.denied(stderr, active.policy);
  if (line === undefined) return;
  const excerpt = line.trim().slice(0, DENIAL_EXCERPT_CHARS);
  throw new SandboxDeniedError(`reported by the command's own stderr (unauthenticated): ${excerpt}`);
}

/**
 * First line of `stderr` matching any of `patterns` and not `unless`, for a bounded,
 * provenance-labelled reason. `unless` lets a provider drop a denial its policy could not have
 * produced (a network denial under a network grant).
 */
function firstDenialLine(stderr: string, patterns: readonly RegExp[], unless?: RegExp): string | undefined {
  for (const line of stderr.split(/\r?\n/u)) {
    if (!patterns.some((p) => p.test(line))) continue;
    if (unless !== undefined && unless.test(line)) continue;
    return line;
  }
  return undefined;
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

  protected abstract denied(stderr: string, policy: SandboxPolicy): string | undefined;

  prepare<T>(cmd: SandboxCommand<T>, policy: SandboxPolicy): SandboxCommand<T> {
    if (policy.mode === "none") return cmd;
    const normalized = { ...policy, cwd: resolve(policy.cwd) };
    return () => activeSandbox.run({
      policy: normalized,
      wrap: (command, args, executionPolicy) => this.wrap(command, args, executionPolicy),
      denied: (stderr, executionPolicy) => this.denied(stderr, executionPolicy),
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

  protected denied(stderr: string, policy: SandboxPolicy): string | undefined {
    // "operation not permitted" is deliberately absent: it is every EPERM a command can hit,
    // sandbox or not, and would turn ordinary failures (and forged ones) into denials.
    const patterns = [/read-only file system/iu];
    if (policy.network !== true) patterns.push(/network is unreachable/iu);
    return firstDenialLine(stderr, patterns);
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

  protected denied(stderr: string, policy: SandboxPolicy): string | undefined {
    // a network denial cannot come from a profile that allows network: under a grant such a
    // line is the command's own words, not the sandbox's
    return firstDenialLine(
      stderr,
      [/sandbox(?:-exec)?:?.*deny/iu],
      policy.network === true ? /network/iu : undefined,
    );
  }
}
