import { AsyncLocalStorage } from "node:async_hooks";
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
 * produced (a network denial under a network grant; a write denial inside a writable workspace).
 */
function firstDenialLine(
  stderr: string,
  patterns: readonly RegExp[],
  unless?: RegExp | ((line: string) => boolean),
): string | undefined {
  for (const line of boundedLines(stderr)) {
    if (!patterns.some((p) => p.test(line))) continue;
    if (unless !== undefined && (unless instanceof RegExp ? unless.test(line) : unless(line))) continue;
    return line;
  }
  return undefined;
}

/** Longest path any filesystem accepts; a longer token cannot name a file and is not resolved. */
const MAX_PATH_CHARS = 4_096;
/** Paths considered per line and lines considered per stderr: the input is a child's, unbounded. */
const MAX_PATHS_PER_LINE = 16;
const MAX_DENIAL_LINES = 200;

/** A token that reads as a path: absolute, or relative with a slash or a dot prefix. */
function pathLike(token: string): boolean {
  return isAbsolute(token) || token.includes("/") || token.startsWith(".");
}

/**
 * Every filesystem path a denial line names, in order and bounded: quoted paths first (`touch:
 * cannot touch '/etc/x': Read-only file system`), then bare tokens (`sandbox-exec: deny
 * file-write-create /etc/x`, `-> /etc/x`), trailing punctuation stripped. Relative paths are
 * returned as named (`../../etc/x`, `build/x`): they cannot be resolved — the command may have
 * `cd`'d — but a line that names one is a line whose target is unknown, never one whose every
 * path is known to be inside. A bare quoted word without a slash is not a path (the quoted
 * phrase could be anything). Empty when the line carries no recognisable path.
 */
export function deniedPaths(line: string): string[] {
  const found: string[] = [];
  const add = (path: string): boolean => {
    if (!found.includes(path)) found.push(path);
    return found.length >= MAX_PATHS_PER_LINE;
  };
  const quotedSpans: Array<[number, number]> = [];
  const quoted = /['"‘’`]([^'"‘’`\s][^'"‘’`]*)['"‘’`]/gu;
  for (const m of line.matchAll(quoted)) {
    if (m[1] === undefined || !pathLike(m[1])) continue;
    quotedSpans.push([m.index, m.index + m[0].length]);
    if (add(m[1])) return found;
  }
  // quote characters are boundaries too, so an unbalanced apostrophe elsewhere on the line
  // (`can't`) cannot hide a space-free quoted path from this pass; a token inside a quoted
  // path already taken (the first word of `'/opt/a b'`) is not a second path
  const bare = /(?:^|[\s(=,:>'"‘’`])((?:\/|\.\.?\/)[^\s'"`‘’,;)]+)/gu;
  for (const m of line.matchAll(bare)) {
    if (m[1] === undefined) continue;
    const at = m.index + m[0].length - m[1].length;
    if (quotedSpans.some(([start, end]) => at >= start && at < end)) continue;
    if (add(m[1].replace(/[:.,;]+$/u, ""))) return found;
  }
  return found;
}

/** The first path a denial line names, for callers that want one; see `deniedPaths`. */
export function deniedPath(line: string): string | undefined {
  return deniedPaths(line)[0];
}

/**
 * Where an absolute `path` really points on the host: the longest existing prefix is resolved
 * through its symlinks (a dangling last link through its target) and the rest re-joined. A
 * symlink inside the workspace that points outside names an inside path in the denial line but
 * an outside one to the boundary. One pass over the components; a token longer than any
 * filesystem accepts is returned as is, so a child cannot make this walk expensive.
 */
function canonical(path: string): string {
  if (path.length > MAX_PATH_CHARS) return path;
  const parts = path.split(sep).filter((p) => p !== "");
  // find the deepest existing prefix without following the final component's symlink
  let depth = parts.length;
  let existing: string | null = null;
  let isLink = false;
  for (; depth >= 0; depth -= 1) {
    const candidate = sep + parts.slice(0, depth).join(sep);
    try {
      isLink = lstatSync(candidate).isSymbolicLink();
      existing = candidate;
      break;
    } catch {
      // keep climbing
    }
  }
  if (existing === null) return path;
  const rest = parts.slice(depth);
  try {
    let real: string;
    if (isLink) {
      // a dangling link exists but its target may not: resolve the link's own directory, then
      // point at its target (bounded to one hop; a chain of dangling links is left as the target)
      const dir = realpathSync(dirname(existing));
      real = resolve(dir, readlinkSync(existing));
    } else {
      real = realpathSync(existing);
    }
    return rest.length === 0 ? real : join(real, ...rest);
  } catch {
    return path;
  }
}

function insideWorkspace(path: string, cwd: string, canonicalise: boolean): boolean {
  const literal = resolve(path);
  const target = canonicalise ? canonical(literal) : literal;
  return target === cwd || target.startsWith(cwd + sep);
}

/**
 * Whether a write denial line is one the ACTIVE policy could have produced (#95). Under
 * `workspace-write` the workspace is writable, so a "read-only" line about paths inside it did
 * not come from the boundary: it is the command's own words (forged, or a host mount that is
 * read-only for reasons of its own), and classifying it would earn a forger an escalation
 * prompt. The line is dropped only when EVERY path it names is absolute and inside the
 * workspace: a real denial often names an inside source before the outside target (`copyfile
 * '/work/a' -> '/etc/x'`, `/work/script.sh: line 3: /etc/x: …`), a relative target is unknown
 * (`mv '/work/a' '../../etc/x'`), and either keeps the line. Under `read-only` every path is
 * denied. A line naming no path keeps today's classification: corroboration narrows, never
 * widens.
 *
 * `sharedFilesystem`: whether the boundary sees the host's filesystem (seatbelt does; docker
 * shares only the workspace bind). Where it does not, an OUTSIDE string is judged as written —
 * a host symlink from outside into the workspace does not exist in the container, so a write
 * through it there is a genuine denial — and only inside strings are canonicalised, because the
 * bind is at the same path on both sides.
 */
export function writeDenialPlausible(
  line: string,
  policy: SandboxPolicy,
  opts: { sharedFilesystem?: boolean } = {},
): boolean {
  if (policy.mode !== "workspace-write") return true;
  const named = deniedPaths(line);
  if (named.length === 0) return true;
  const cwd = canonical(resolve(policy.cwd));
  return named.some((path) => {
    if (!isAbsolute(path)) return true;
    const literalInside = insideWorkspace(path, cwd, false);
    if (!literalInside && opts.sharedFilesystem !== true) return true;
    return !insideWorkspace(path, cwd, true);
  });
}

/** `firstDenialLine` over a bounded number of lines: the rest of a huge stderr is not scanned. */
function boundedLines(stderr: string): string[] {
  return stderr.split(/\r?\n/u).slice(0, MAX_DENIAL_LINES);
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
    const bindMode = policy.mode === "workspace-write" ? "" : ",readonly";
    return {
      command: this.command,
      args: [
        "run",
        "--rm",
        "--read-only",
        ...(policy.network === true ? [] : ["--network", "none"]),
        "--mount",
        `type=bind,src=${cwd},dst=${cwd}${bindMode}`,
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
    // a "read-only" line naming a path inside a writable workspace is not the container's doing
    return firstDenialLine(
      stderr,
      patterns,
      (line) => /read-only file system/iu.test(line) && !writeDenialPlausible(line, policy, { sharedFilesystem: false }),
    );
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
    // likewise a file-write denial inside the workspace the profile allows writes to
    return firstDenialLine(
      stderr,
      [/sandbox(?:-exec)?:?.*deny/iu],
      (line) =>
        (policy.network === true && /network/iu.test(line)) ||
        (/file-write/iu.test(line) && !writeDenialPlausible(line, policy, { sharedFilesystem: true })),
    );
  }
}
