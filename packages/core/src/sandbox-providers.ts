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
/** Bytes of a child's stderr the classifier reads: its head and its tail, never the middle. */
const CLASSIFY_HEAD_CHARS = 64 * 1024;
const CLASSIFY_TAIL_CHARS = 64 * 1024;
const CLASSIFY_SLACK_CHARS = 8 * 1024;

/**
 * The part of an unbounded stderr the classifier looks at. A denial is printed where the write
 * failed — usually near the end, sometimes at the start — and a child that prints megabytes
 * between must not make the synchronous scan proportional to its output.
 */
export function classifiable(stderr: string): string {
  if (stderr.length <= CLASSIFY_HEAD_CHARS + CLASSIFY_TAIL_CHARS) return stderr;
  // cut on line boundaries (within a few KB of the budget) so no denial line is split into a
  // fragment that names only its inside path
  const headEnd = stderr.indexOf("\n", CLASSIFY_HEAD_CHARS);
  const head = stderr.slice(0, headEnd === -1 || headEnd > CLASSIFY_HEAD_CHARS + CLASSIFY_SLACK_CHARS ? CLASSIFY_HEAD_CHARS : headEnd);
  const tailStart = stderr.lastIndexOf("\n", stderr.length - CLASSIFY_TAIL_CHARS);
  const tail = stderr.slice(tailStart === -1 || tailStart < stderr.length - CLASSIFY_TAIL_CHARS - CLASSIFY_SLACK_CHARS ? -CLASSIFY_TAIL_CHARS : tailStart + 1);
  return `${head}\n[…]\n${tail}`;
}

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
  const line = active.denied(classifiable(stderr), active.policy);
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
  unless?: RegExp | ((line: string, spent: boolean) => boolean),
): string | undefined {
  // The pattern test is cheap and runs on every line; the corroboration (`unless`, which may
  // touch the filesystem) is spent on at most MAX_CORROBORATED_LINES distinct matching lines.
  // Past that budget `unless` is told so and judges by string alone (no filesystem): a forged
  // inside line is still dropped at any position, a late genuine outside or relative denial is
  // still kept, and only symlink-through-inside detection is lost past the budget.
  let corroborated = 0;
  const seen = new Set<string>();
  for (const line of stderr.split(/\r?\n/u)) {
    if (!patterns.some((p) => p.test(line))) continue;
    if (unless === undefined) return line;
    if (unless instanceof RegExp) {
      if (unless.test(line)) continue;
      return line;
    }
    // a repeated line is one line: a forger cannot spend the budget by printing it fifty times
    if (seen.has(line)) continue;
    seen.add(line);
    const spent = corroborated >= MAX_CORROBORATED_LINES;
    if (!spent) corroborated += 1;
    if (unless(line, spent)) continue;
    return line;
  }
  return undefined;
}

/** Longest path any filesystem accepts; a longer token cannot name a file and is not resolved. */
const MAX_PATH_CHARS = 4_096;
/**
 * Deepest path the walk resolves through the filesystem. Every probe and the final realpath
 * cost one syscall per EXISTING component, so a child that builds a two-thousand-level tree
 * inside the workspace (allowed) and names leaves under it made each classification a
 * three-minute block; past this depth the path is judged as a string, which only ever drops.
 */
const MAX_PATH_COMPONENTS = 64;
/** Paths considered per line, and matching lines corroborated per stderr: the input is a child's. */
const MAX_PATHS_PER_LINE = 16;
const MAX_CORROBORATED_LINES = 50;
/** Symlink hops followed when the deepest existing component is a dangling link. */
const MAX_LINK_HOPS = 40;

/**
 * The operand a coreutils/shell message names right before the errno text (`sh: line 5: hosts:
 * Read-only file system`, `mv: cannot move 'a' to 'x': Read-only file system` quotes it, this
 * catches the unquoted form): a single word that is not absolute is a target the boundary
 * cannot judge.
 */
function operandBeforeErrno(line: string): string | undefined {
  // preceded by `: ` (never the program name at the start of the line) and ending the line
  // (Node's `EROFS: read-only file system, open …` names its path after the text, not before)
  const m = /:\s([^\s:'"‘’`]+):\s*read-only file system\s*$/iu.exec(line);
  return m?.[1];
}

/**
 * Every filesystem path a denial line names, in order and bounded: quoted paths first (`touch:
 * cannot touch '/etc/x': Read-only file system`), then bare tokens (`sandbox-exec: deny
 * file-write-create /etc/x`, `-> /etc/x`), trailing punctuation stripped. Relative names are
 * returned as written (`../../etc/x`, `build/x`, `hosts`): they cannot be resolved — the command
 * may have `cd`'d — but a line that names one is a line whose target is unknown, never one whose
 * every path is known to be inside; so is any quoted token, and the unquoted operand right before
 * the errno text. Empty when the line carries no recognisable path.
 */
export function deniedPaths(line: string): string[] {
  const found: string[] = [];
  const add = (path: string): boolean => {
    if (!found.includes(path)) found.push(path);
    return found.length >= MAX_PATHS_PER_LINE;
  };
  const quotedSpans: Array<[number, number]> = [];
  // every quoted token is a candidate: a word without a slash (`'hosts'` after a `cd`, or a
  // quoted phrase) is a target the boundary cannot judge, and unknown keeps the line
  const quoted = /['"‘’`]([^'"‘’`\s][^'"‘’`]*)['"‘’`]/gu;
  for (const m of line.matchAll(quoted)) {
    if (m[1] === undefined) continue;
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
  // last, the unquoted operand right before the errno text: a word the boundary cannot judge
  const operand = operandBeforeErrno(line);
  if (operand !== undefined) add(operand);
  return found;
}

/** The first path a denial line names, for callers that want one; see `deniedPaths`. */
export function deniedPath(line: string): string | undefined {
  return deniedPaths(line)[0];
}

/**
 * Where an absolute `path` really points on the host: the deepest existing prefix is resolved
 * through its symlinks and the rest re-joined. A symlink inside the workspace that points
 * outside names an inside path in the denial line but an outside one to the boundary. Existence
 * is monotone along the components, so the deepest existing prefix is found by binary search
 * with a non-throwing stat: eleven probes for two thousand components, not two thousand thrown
 * errors — a child that prints deep paths cannot make this expensive. A dangling link is
 * followed through its target, itself canonicalised, up to a hop budget.
 */
function canonical(path: string, hops = 0): string {
  if (path.length > MAX_PATH_CHARS || hops > MAX_LINK_HOPS) return path;
  const parts = path.split(sep).filter((p) => p !== "");
  if (parts.length > MAX_PATH_COMPONENTS) return path;
  const prefix = (n: number): string => sep + parts.slice(0, n).join(sep);
  // `throwIfNoEntry: false` silences ENOENT only; ENOTDIR (a path through a regular file) and
  // ENAMETOOLONG still throw, and a component that cannot exist is simply absent
  const stat = (n: number): ReturnType<typeof lstatSync> | undefined => {
    try {
      return lstatSync(prefix(n), { throwIfNoEntry: false });
    } catch {
      return undefined;
    }
  };
  // invariant: prefix(lo) exists (the root always does), prefix(hi + 1) does not
  let lo = 0;
  let hi = parts.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (stat(mid) !== undefined) lo = mid;
    else hi = mid - 1;
  }
  const existing = prefix(lo);
  const rest = parts.slice(lo);
  const link = stat(lo)?.isSymbolicLink() === true;
  try {
    // an existing chain (link to link to directory) resolves outright
    const real = realpathSync.native(existing);
    return rest.length === 0 ? real : join(real, ...rest);
  } catch {
    if (!link) return path;
  }
  try {
    // the deepest existing component is a DANGLING link: follow it to where the write would land
    const dir = realpathSync.native(dirname(existing));
    const target = canonical(resolve(dir, readlinkSync(existing)), hops + 1);
    return rest.length === 0 ? target : join(target, ...rest);
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
  opts: { sharedFilesystem?: boolean; stringOnly?: boolean } = {},
): boolean {
  if (policy.mode !== "workspace-write") return true;
  const named = deniedPaths(line);
  if (named.length === 0) return true;
  const fs = opts.stringOnly !== true;
  const cwd = fs ? canonical(resolve(policy.cwd)) : resolve(policy.cwd);
  return named.some((path) => {
    if (!isAbsolute(path)) return true;
    const literalInside = insideWorkspace(path, cwd, false);
    if (!literalInside && (opts.sharedFilesystem !== true || !fs)) return true;
    return fs ? !insideWorkspace(path, cwd, true) : !literalInside;
  });
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
      (line, spent) =>
        /read-only file system/iu.test(line) &&
        !writeDenialPlausible(line, policy, { sharedFilesystem: false, stringOnly: spent }),
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
      (line, spent) =>
        (policy.network === true && /network/iu.test(line)) ||
        (/file-write/iu.test(line) && !writeDenialPlausible(line, policy, { sharedFilesystem: true, stringOnly: spent })),
    );
  }
}
