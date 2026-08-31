import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";

const TrustFileSchema = z.object({ projects: z.record(z.boolean()) }).strict();

/** Pure, read-only parser shared by runtime and diagnostics so trust can never be interpreted loosely. */
export function parseTrustText(text: string): Record<string, boolean> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("malformed trust store");
  }
  const parsed = TrustFileSchema.safeParse(raw);
  if (!parsed.success) throw new Error("malformed trust store");
  return parsed.data.projects;
}

export interface ProjectTrustOptions {
  home: string;
  interactive: boolean;
  explicitTrust?: boolean;
  confirm?: (message: string) => Promise<boolean>;
  notice?: (message: string) => void;
}

export interface ProjectTrust {
  projectRoot: string;
  trusted: boolean;
}

export interface ProjectBoundary {
  projectRoot: string;
  /** False when ~/.agentrig itself is controlled by the project tree. */
  userStateSafe: boolean;
}

function say(options: ProjectTrustOptions, message: string): void {
  (options.notice ?? console.error)(message);
}

interface TrustFileState {
  projects: Record<string, boolean>;
  /** False when writing would destroy unreadable or malformed user state. */
  writable: boolean;
}

async function readTrustFile(path: string, options: ProjectTrustOptions): Promise<TrustFileState> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { projects: {}, writable: true };
    say(options, `Warning: could not read trust store ${path}; treating all projects as untrusted.`);
    return { projects: {}, writable: false };
  }

  try {
    return { projects: parseTrustText(text), writable: true };
  } catch {
    say(options, `Warning: malformed trust store ${path}; treating all projects as untrusted.`);
    return { projects: {}, writable: false };
  }
}

async function writeTrustFile(path: string, projects: Record<string, boolean>): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.trust-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify({ projects }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function canonicalProjectRoot(cwd: string): Promise<string> {
  const canonicalCwd = await realpath(cwd);
  let directory = canonicalCwd;
  while (true) {
    try {
      const marker = await lstat(join(directory, ".git"));
      if (marker.isDirectory() || marker.isFile()) return directory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) return canonicalCwd;
    directory = parent;
  }
}

function isAtOrBelow(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

export async function resolveProjectBoundary(cwd: string, home: string): Promise<ProjectBoundary> {
  const [projectRoot, canonicalHome] = await Promise.all([canonicalProjectRoot(cwd), realpath(home)]);
  return { projectRoot, userStateSafe: !isAtOrBelow(projectRoot, canonicalHome) };
}

function displayPath(path: string): string {
  // JSON escapes terminal controls; explicit bidi escaping prevents visual path reordering.
  return JSON.stringify(path).replace(/[\u202a-\u202e\u2066-\u2069]/giu, (character) =>
    `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`,
  );
}

/**
 * Resolve consent before any project-owned file is opened. The canonical root is also passed to
 * core, which re-checks it at the instruction-loading boundary.
 *
 * `--trust` is intentionally run-only: automation can opt into one checkout without silently
 * granting that checkout ambient permission for future interactive sessions.
 */
export async function resolveProjectTrust(
  cwd: string,
  options: ProjectTrustOptions,
  knownBoundary?: ProjectBoundary,
): Promise<ProjectTrust> {
  const boundary = knownBoundary ?? await resolveProjectBoundary(cwd, options.home);
  const { projectRoot } = boundary;
  const shownRoot = displayPath(projectRoot);
  const path = join(options.home, ".agentrig", "trust.json");

  if (options.explicitTrust === true) return { projectRoot, trusted: true };
  if (!boundary.userStateSafe) {
    say(options, `Project ${shownRoot} contains the user AgentRig state directory; ignoring user config and trust records. Use --trust to load project files for this run.`);
    return { projectRoot, trusted: false };
  }

  const state = await readTrustFile(path, options);
  const recorded = state.projects[projectRoot];
  if (recorded === true) return { projectRoot, trusted: true };
  if (recorded === false) {
    say(options, `Project ${shownRoot} is not trusted; skipping project instructions and .agentrig/config.json.`);
    return { projectRoot, trusted: false };
  }
  if (!options.interactive) {
    say(options, `Project ${shownRoot} is not trusted; skipping project instructions and .agentrig/config.json. Use --trust to load them for this run.`);
    return { projectRoot, trusted: false };
  }
  if (options.confirm === undefined) {
    throw new Error("interactive project trust requires a confirmation callback");
  }

  const prompt = `Trust project ${shownRoot}? AgentRig will load AGENTS.md/CLAUDE.md instructions and .agentrig/config.json. [y/N] `;
  const trusted = await options.confirm(prompt);
  if (state.writable) {
    try {
      await writeTrustFile(path, { ...state.projects, [projectRoot]: trusted });
    } catch {
      say(options, `Warning: could not record trust decision in ${path}; this visit's decision still applies.`);
    }
  } else {
    say(options, `Warning: trust decision was not recorded because ${path} could not be safely updated.`);
  }
  if (!trusted) {
    say(options, `Project ${shownRoot} was not trusted; continuing without project instructions or .agentrig/config.json.`);
  }
  return { projectRoot, trusted };
}
