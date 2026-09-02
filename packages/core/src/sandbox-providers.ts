import { execFile } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  SandboxDeniedError,
  type SandboxCommand,
  type SandboxPolicy,
  type SandboxProvider,
} from "./sandbox.js";

const execFileAsync = promisify(execFile);

export type SandboxBackend = "seatbelt" | "bubblewrap" | "none";

export interface SandboxProbeResult {
  backend: SandboxBackend;
  available: boolean;
  detail: string;
}

/** Injected by tests; production probes execute the same harmless command the backend will wrap. */
export type SandboxProbeRunner = (command: string, args: readonly string[]) => Promise<void>;

export interface SandboxProviderOptions {
  command?: string;
  probeRunner?: SandboxProbeRunner;
}

export interface SandboxSpawnInvocation {
  command: string;
  args: string[];
  sandboxed: boolean;
}

type WrappedInvocation = Omit<SandboxSpawnInvocation, "sandboxed">;

interface ActiveSandbox {
  wrap(command: string, args: readonly string[], policy: SandboxPolicy): WrappedInvocation;
  denied(stderr: string): boolean;
  policy: SandboxPolicy;
}

const activeSandbox = new AsyncLocalStorage<ActiveSandbox>();

/**
 * Returns the process invocation for the active sandbox boundary. Process-launching core tools use
 * this immediately before spawn; outside a prepared command it is an identity operation.
 */
export function sandboxSpawnInvocation(
  command: string,
  args: readonly string[],
  cwd: string,
): SandboxSpawnInvocation {
  const active = activeSandbox.getStore();
  if (active === undefined) return { command, args: [...args], sandboxed: false };
  return { ...active.wrap(command, args, { ...active.policy, cwd }), sandboxed: true };
}

/** Convert a backend-shaped process denial into the provider-classified error consumed by Agent. */
export function throwIfSandboxDenied(stderr: string): void {
  const active = activeSandbox.getStore();
  if (active?.denied(stderr) === true) {
    throw new SandboxDeniedError(stderr.trim() || "operation denied by the OS sandbox");
  }
}

export class SandboxUnavailableError extends Error {
  override readonly name = "SandboxUnavailableError";
  readonly backend: Exclude<SandboxBackend, "none">;

  constructor(backend: Exclude<SandboxBackend, "none">, message: string, options?: ErrorOptions) {
    super(message, options);
    this.backend = backend;
  }
}

async function defaultProbeRunner(command: string, args: readonly string[]): Promise<void> {
  await execFileAsync(command, [...args], { timeout: 5_000, windowsHide: true });
}

function seatbeltString(value: string): string {
  // Seatbelt string literals accept the JSON escaping rules needed here. In particular, a project
  // path containing a quote or newline must remain data rather than becoming profile syntax.
  return JSON.stringify(value);
}

/** Build the macOS profile separately so its least-authority shape is directly testable. */
export function seatbeltProfile(policy: SandboxPolicy): string {
  const rules = [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow sysctl-read)",
    "(allow file-read*)",
    "(deny network*)",
  ];
  if (policy.mode === "workspace-write") {
    rules.push(`(allow file-write* (subpath ${seatbeltString(resolve(policy.cwd))}))`);
  }
  return rules.join("\n");
}

const SEATBELT_FIX =
  "sandbox-exec is unavailable or cannot create a sandbox — repair/update macOS, or use the none provider (unsandboxed fallback)";
const BUBBLEWRAP_FIX =
  "bwrap is unavailable or cannot create user namespaces — install bubblewrap (for example: apt install bubblewrap), or use the none provider (unsandboxed fallback)";

abstract class ProbedSandboxProvider implements SandboxProvider {
  abstract readonly backend: Exclude<SandboxBackend, "none">;
  protected abstract readonly command: string;
  protected abstract probeArgs(): readonly string[];
  protected abstract unavailableMessage(): string;
  protected abstract wrap(command: string, args: readonly string[], policy: SandboxPolicy): WrappedInvocation;
  protected abstract denied(stderr: string): boolean;

  private readonly runProbe: SandboxProbeRunner;
  private probePromise: Promise<SandboxProbeResult> | undefined;

  protected constructor(options: SandboxProviderOptions) {
    this.runProbe = options.probeRunner ?? defaultProbeRunner;
  }

  probe(): Promise<SandboxProbeResult> {
    this.probePromise ??= this.runProbe(this.command, this.probeArgs()).then(
      () => ({ backend: this.backend, available: true, detail: `${this.command} startup probe passed` }),
      () => ({ backend: this.backend, available: false, detail: this.unavailableMessage() }),
    );
    return this.probePromise;
  }

  prepare<T>(cmd: SandboxCommand<T>, policy: SandboxPolicy): SandboxCommand<T> {
    if (policy.mode === "none") return cmd;
    return async () => {
      const probe = await this.probe();
      if (!probe.available) throw new SandboxUnavailableError(this.backend, probe.detail);
      const normalized = { ...policy, cwd: resolve(policy.cwd) };
      return activeSandbox.run({
        policy: normalized,
        wrap: (command, args, executionPolicy) => this.wrap(command, args, executionPolicy),
        denied: (stderr) => this.denied(stderr),
      }, cmd);
    };
  }
}

/** macOS sandbox-exec backend. Network is denied and only workspace-write grants file writes. */
export class SeatbeltSandboxProvider extends ProbedSandboxProvider {
  readonly backend = "seatbelt" as const;
  protected readonly command: string;

  constructor(options: SandboxProviderOptions = {}) {
    super(options);
    this.command = options.command ?? "/usr/bin/sandbox-exec";
  }

  protected probeArgs(): readonly string[] {
    return ["-p", "(version 1)\n(allow default)", "/usr/bin/true"];
  }

  protected unavailableMessage(): string { return SEATBELT_FIX; }

  protected wrap(command: string, args: readonly string[], policy: SandboxPolicy): WrappedInvocation {
    return { command: this.command, args: ["-p", seatbeltProfile(policy), command, ...args] };
  }

  protected denied(stderr: string): boolean {
    return /sandbox(?:-exec)?:?.*deny/iu.test(stderr);
  }
}

/** Linux bubblewrap backend with a read-only root and an optional writable workspace bind. */
export class BubblewrapSandboxProvider extends ProbedSandboxProvider {
  readonly backend = "bubblewrap" as const;
  protected readonly command: string;

  constructor(options: SandboxProviderOptions = {}) {
    super(options);
    this.command = options.command ?? "bwrap";
  }

  protected probeArgs(): readonly string[] {
    return [
      "--die-with-parent",
      "--new-session",
      "--unshare-all",
      "--ro-bind", "/", "/",
      "--dev", "/dev",
      "--proc", "/proc",
      "--", "/bin/true",
    ];
  }

  protected unavailableMessage(): string { return BUBBLEWRAP_FIX; }

  protected wrap(command: string, args: readonly string[], policy: SandboxPolicy): WrappedInvocation {
    const cwd = resolve(policy.cwd);
    const sandboxArgs = [
      "--die-with-parent",
      "--new-session",
      "--unshare-all",
      "--ro-bind", "/", "/",
      "--dev", "/dev",
      "--proc", "/proc",
    ];
    if (policy.mode === "workspace-write") sandboxArgs.push("--bind", cwd, cwd);
    sandboxArgs.push("--chdir", cwd, "--", command, ...args);
    return { command: this.command, args: sandboxArgs };
  }

  protected denied(stderr: string): boolean {
    return /read-only file system|network is unreachable|^bwrap:/imu.test(stderr);
  }
}

/** Probe the platform-native backend without making the CLI know provider commands or policy. */
export async function probeNativeSandbox(
  platform: NodeJS.Platform = process.platform,
  options: SandboxProviderOptions = {},
): Promise<SandboxProbeResult> {
  if (platform === "darwin") return new SeatbeltSandboxProvider(options).probe();
  if (platform === "linux") return new BubblewrapSandboxProvider(options).probe();
  return {
    backend: "none",
    available: false,
    detail: `no native sandbox backend is supported on ${platform}; use the none provider (unsandboxed fallback)`,
  };
}
