import { join, resolve } from "node:path";
import { readConfigFile, resolveConfig } from "./config.js";
import { loadChildUserConfig } from "./child-env.js";
import type { ConfigFile, ConfigReadOptions, ProjectChecks } from "./config.js";

/** Read-only inspection, not trust or permission to execute project-controlled commands.
 * Callers supply the explicit project root; no home command fallback or toolchain guessing.
 * An absent declaration differs from an explicit empty steps list.
 */
export async function resolveProjectChecks(projectRoot: string, profile?: string, user?: ConfigFile, options: ConfigReadOptions = {}): Promise<ProjectChecks | undefined> {
  const project = await readConfigFile(join(resolve(projectRoot), ".agentrig", "config.json"), options);
  if (project === undefined) return undefined;
  // Match run --profile name validation using the same safe-home boundary.
  // User config supplies names only; commands remain project-owned.
  user ??= await loadChildUserConfig(projectRoot, undefined, options);
  const activeProfile = profile === "recommended" && user?.profiles?.recommended === undefined && project.profiles?.recommended === undefined ? undefined : profile;
  resolveConfig({ defaults: {}, project, ...(user === undefined ? {} : { user }), ...(activeProfile === undefined ? {} : { profile: activeProfile }) });
  const checks = (profile === undefined ? undefined : project.profiles?.[profile]?.checks) ?? project.checks;
  if (checks === undefined) return undefined;
  return { ...checks, steps: checks.steps.map(step => ({ ...step,
    command: step.testTimeout === undefined ? step.command : `${step.command} --testTimeout=${step.testTimeout}`,
  })) };
}
