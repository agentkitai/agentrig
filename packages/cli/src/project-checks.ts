import { join, resolve } from "node:path";
import { readConfigFile, resolveConfig } from "./config.js";
import { loadChildUserConfig } from "./child-env.js";
import type { ConfigFile, ProjectChecks } from "./config.js";

/** Read-only inspection, not trust or permission to execute project-controlled commands.
 * Callers supply the explicit project root; no home command fallback or toolchain guessing.
 * An absent declaration differs from an explicit empty steps list.
 */
export async function resolveProjectChecks(projectRoot: string, profile?: string, user?: ConfigFile): Promise<ProjectChecks | undefined> {
  const project = await readConfigFile(join(resolve(projectRoot), ".agentrig", "config.json"));
  if (project === undefined) return undefined;
  // Match run --profile name validation using the same safe-home boundary.
  // User config supplies names only; commands remain project-owned.
  user ??= await loadChildUserConfig(projectRoot);
  resolveConfig({ defaults: {}, project, ...(user === undefined ? {} : { user }), ...(profile === undefined ? {} : { profile }) });
  const checks = (profile === undefined ? undefined : project.profiles?.[profile]?.checks) ?? project.checks;
  if (checks === undefined) return undefined;
  return { ...checks, steps: checks.steps.map(step => ({ ...step,
    command: step.testTimeout === undefined ? step.command : `${step.command} --testTimeout=${step.testTimeout}`,
  })) };
}

/** Train keeps its fixed validation sequence; only its pnpm test budget is configurable.
 * Resolve after each fast-forward, from the same profile as the conductor.
 */
export async function resolveTrainTestTimeout(projectRoot: string, profile?: string): Promise<number | undefined> {
  const checks = await resolveProjectChecks(projectRoot, profile);
  const matches = checks?.steps.filter(step => step.testTimeout !== undefined
    && step.command === `pnpm test --testTimeout=${step.testTimeout}`) ?? [];
  if (matches.length > 1) throw new Error("ambiguous train pnpm test budget");
  return matches[0]?.testTimeout;
}
