import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

const TrustFileSchema = z.object({ projects: z.record(z.boolean()) }).strict();

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

function say(options: ProjectTrustOptions, message: string): void {
  (options.notice ?? console.error)(message);
}

async function readTrustFile(path: string, options: ProjectTrustOptions): Promise<Record<string, boolean>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    say(options, `Warning: could not read trust store ${path}; treating all projects as untrusted.`);
    return {};
  }

  try {
    const parsed = TrustFileSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error("invalid trust store shape");
    return parsed.data.projects;
  } catch {
    say(options, `Warning: malformed trust store ${path}; treating all projects as untrusted.`);
    return {};
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

/**
 * Resolve consent before any project-owned file is opened. The canonical root is also passed to
 * core, which re-checks it at the instruction-loading boundary.
 *
 * `--trust` is intentionally run-only: automation can opt into one checkout without silently
 * granting that checkout ambient permission for future interactive sessions.
 */
export async function resolveProjectTrust(cwd: string, options: ProjectTrustOptions): Promise<ProjectTrust> {
  const projectRoot = await realpath(cwd);
  const path = join(options.home, ".agentrig", "trust.json");
  const projects = await readTrustFile(path, options);
  const recorded = projects[projectRoot];

  if (options.explicitTrust === true) return { projectRoot, trusted: true };
  if (recorded === true) return { projectRoot, trusted: true };
  if (recorded === false) {
    say(options, `Project ${projectRoot} is not trusted; skipping project instructions and .agentrig/config.json.`);
    return { projectRoot, trusted: false };
  }
  if (!options.interactive) {
    say(options, `Project ${projectRoot} is not trusted; skipping project instructions and .agentrig/config.json. Use --trust to load them for this run.`);
    return { projectRoot, trusted: false };
  }

  const prompt = `Trust project ${projectRoot}? AgentRig will load AGENTS.md/CLAUDE.md instructions and .agentrig/config.json. [y/N] `;
  const trusted = await (options.confirm ?? (() => Promise.resolve(false)))(prompt);
  try {
    await writeTrustFile(path, { ...projects, [projectRoot]: trusted });
  } catch {
    say(options, `Warning: could not record trust decision in ${path}; this visit's decision still applies.`);
  }
  if (!trusted) {
    say(options, `Project ${projectRoot} was not trusted; continuing without project instructions or .agentrig/config.json.`);
  }
  return { projectRoot, trusted };
}
