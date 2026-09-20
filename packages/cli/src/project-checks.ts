import { join, resolve } from "node:path";
import { readConfigFile, resolveConfig } from "./config.js";
import type { ProjectChecks } from "./config.js";

/** Read-only inspection, not trust or permission to execute project-controlled commands.
 * Callers supply the explicit project root; no home fallback or toolchain guessing.
 * An absent declaration differs from an explicit empty steps list.
 */
export async function resolveProjectChecks(projectRoot: string, profile?: string): Promise<ProjectChecks | undefined> {
  const project = await readConfigFile(join(resolve(projectRoot), ".agentrig", "config.json"));
  if (project === undefined) return undefined;
  // Reuse profile-name validation, but keep declarations out of runtime values.
  resolveConfig({ defaults: {}, project, ...(profile === undefined ? {} : { profile }) });
  return (profile === undefined ? undefined : project.profiles?.[profile]?.checks) ?? project.checks;
}
