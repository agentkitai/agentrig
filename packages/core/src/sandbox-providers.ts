import { AsyncLocalStorage } from "node:async_hooks";
import { lstatSync, readlinkSync } from "node:fs";
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
  unless?: RegExp | ((line: string, spent: boolean, budget: ProbeBudget) => boolean),
): string | undefined {
  const budget = probeBudget();
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
    const spent = corroborated >= MAX_CORROBORATED_LINES || budget.remaining <= 0;
    if (!spent) corroborated += 1;
    if (unless(line, spent, budget)) continue;
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
 * three-minute block; past this depth the path is judged as a string, against both forms of
 * the workspace, so a symlinked `policy.cwd` cannot make the string judgement keep a line.
 */
const MAX_PATH_COMPONENTS = 64;
/** Paths considered per line, and matching lines corroborated per stderr: the input is a child's. */
const MAX_PATHS_PER_LINE = 16;
const MAX_CORROBORATED_LINES = 50;
/** Symlink hops followed when the deepest existing component is a dangling link. */
const MAX_LINK_HOPS = 40;
/**
 * Filesystem calls one classification may spend, across every line and path it corroborates.
 * The per-axis caps (path length, depth, hops, paths per line, lines) each bound one dimension,
 * and a child kept finding the product of two — a dangling chain whose every target is deep.
 * A global budget bounds the product: once spent, the rest of the stderr is judged by string
 * alone, which only ever drops.
 */
const MAX_PROBES_PER_CLASSIFICATION = 4_000;

/** What one probe learned about one path: missing, a directory or file, or a link and its target. */
type Probed = { kind: "missing" } | { kind: "entry" } | { kind: "link"; target: string };

/**
 * The probe budget threaded through one classification, with a memo of every path probed: the
 * sixteen leaves of one line share their prefixes, and a chain that keeps landing on the same
 * directories costs its distinct paths, not its hops times its depth.
 */
export interface ProbeBudget {
  remaining: number;
  memo: Map<string, Probed>;
}

export function probeBudget(remaining = MAX_PROBES_PER_CLASSIFICATION): ProbeBudget {
  return { remaining, memo: new Map() };
}

/** One filesystem probe, memoised and charged; `undefined` once the budget is spent. */
function probe(path: string, budget: ProbeBudget): Probed | undefined {
  const known = budget.memo.get(path);
  if (known !== undefined) return known;
  if (budget.remaining <= 0) return undefined;
  budget.remaining -= 1;
  let result: Probed;
  try {
    // `throwIfNoEntry: false` silences ENOENT only; ENOTDIR (a path through a regular file) and
    // ENAMETOOLONG still throw, and a component that cannot exist is simply absent
    const st = lstatSync(path, { throwIfNoEntry: false });
    if (st === undefined) result = { kind: "missing" };
    else if (!st.isSymbolicLink()) result = { kind: "entry" };
    else {
      if (budget.remaining <= 0) return undefined;
      budget.remaining -= 1;
      result = { kind: "link", target: readlinkSync(path) };
    }
  } catch {
    result = { kind: "missing" };
  }
  budget.memo.set(path, result);
  return result;
}

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
 * Where an absolute `path` really points on the host, resolved one component at a time with the
 * classification's own probes — never the platform `realpath`, whose cost over a child-built
 * symlink chain is unbounded and invisible to the budget. Each component is one memoised lstat
 * (plus one readlink for a link); a link restarts the walk on its target with the remaining
 * components re-joined, up to a hop budget, and a dangling link resolves to where the write
 * would land. A path longer or deeper than the caps, a walk that exhausts the budget or the
 * hops, or a component the filesystem rejects is returned as it stands: a string judgement.
 */
function canonical(path: string, budget: ProbeBudget): string {
  // Components are walked as written — `.` and `..` included — because a `..` after a symlink
  // component climbs from the LINK'S TARGET, as the kernel does, not from the name: `w/../x`
  // with `w -> /etc` is `/x`, and a lexical collapse would have judged it inside.
  let parts = path.split(sep).filter((p) => p !== "");
  for (let hop = 0; hop <= MAX_LINK_HOPS; hop += 1) {
    if (parts.length > MAX_PATH_COMPONENTS || parts.join(sep).length > MAX_PATH_CHARS) return sep + parts.join(sep);
    let resolved: string = sep;
    let restarted = false;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]!;
      if (part === ".") continue;
      if (part === "..") {
        resolved = dirname(resolved);
        continue;
      }
      const candidate = join(resolved, part);
      const rest = parts.slice(i + 1);
      const seen = probe(candidate, budget);
      // budget spent, or nothing there: where the write would land, lexically from here down
      if (seen === undefined || seen.kind === "missing") return resolve(candidate, ...rest);
      if (seen.kind === "link") {
        // restart on the target — relative to the link's directory — with the rest re-joined
        const target = seen.target.split(sep).filter((p) => p !== "");
        const base = isAbsolute(seen.target) ? [] : resolved.split(sep).filter((p) => p !== "");
        parts = [...base, ...target, ...rest];
        restarted = true;
        break;
      }
      resolved = candidate;
    }
    if (!restarted) return resolved;
  }
  return sep + parts.join(sep);
}

/** Whether `target` is `cwd` or beneath it, for any of the cwd's forms (literal and canonical). */
function under(target: string, cwds: readonly string[]): boolean {
  return cwds.some((cwd) => target === cwd || target.startsWith(cwd + sep));
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
  opts: { sharedFilesystem?: boolean; stringOnly?: boolean; budget?: ProbeBudget } = {},
): boolean {
  if (policy.mode !== "workspace-write") return true;
  const named = deniedPaths(line);
  if (named.length === 0) return true;
  const budget = opts.budget ?? probeBudget();
  const fs = opts.stringOnly !== true && budget.remaining > 0;
  // Both forms of the workspace: a symlinked `policy.cwd` names the same directory either way,
  // and a string judgement (past a cap or the budget) must not keep a line for naming the other.
  // The cwd is the policy's own string, not the child's, so its resolution has a small budget
  // of its own rather than the classification's.
  const literalCwd = resolve(policy.cwd);
  const cwds = [literalCwd, canonical(literalCwd, probeBudget(256))];
  return named.some((path) => {
    if (!isAbsolute(path)) return true;
    // the string judgement is lexical (`resolve` collapses `..`); the walk gets the path as
    // written, because a `..` after a symlink climbs from the link's target, not from its name
    const literal = resolve(path);
    const literalInside = under(literal, cwds);
    if (!fs) return !literalInside;
    // docker shares only the workspace bind, so an outside string is judged as written
    if (!literalInside && opts.sharedFilesystem !== true) return true;
    return !under(canonical(path, budget), cwds);
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
      (line, spent, budget) =>
        /read-only file system/iu.test(line) &&
        !writeDenialPlausible(line, policy, { sharedFilesystem: false, stringOnly: spent, budget }),
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
      (line, spent, budget) =>
        (policy.network === true && /network/iu.test(line)) ||
        (/file-write/iu.test(line) &&
          !writeDenialPlausible(line, policy, { sharedFilesystem: true, stringOnly: spent, budget })),
    );
  }
}
