import { homedir } from "node:os";
import { join } from "node:path";
import { assertNoProjectChildEnv, readConfigFile, resolveConfig, type ConfigFile } from "./config.js";
import type { ChildEnv } from "./child-env.js";
import { reviewerHome } from "./child-env.js";
import { resolveTrainTestTimeout } from "./project-checks.js";
import { resolveProjectBoundary } from "./trust.js";

/** Only operator-owned user profiles may supply launch environment, never project data. */
export async function resolveChildEnvironment(cwd: string, profile?: string, env: NodeJS.ProcessEnv = process.env, home = homedir(), project?: ConfigFile): Promise<NodeJS.ProcessEnv> {
  let childEnv: ChildEnv | undefined;
  let user: ConfigFile | undefined;
  if (profile !== undefined && (await resolveProjectBoundary(cwd, home)).userStateSafe) {
    user = await readConfigFile(join(home, ".agentrig", "config.json"));
    childEnv = user?.profiles?.[profile]?.childEnv;
  }
  if (project !== undefined && profile !== undefined && !(profile === "recommended" && user?.profiles?.recommended === undefined && project.profiles?.recommended === undefined)) resolveConfig({ defaults: {}, ...(user === undefined ? {} : { user }), project, profile });
  return { ...env, ...childEnv };
}

/** Called at CLI launch, not by pure config/diagnostic resolution. Children inherit this snapshot. */
export async function applyChildEnvironment(cwd: string, profile?: string, home?: string): Promise<void> {
  const env = await resolveChildEnvironment(cwd, profile, process.env, home);
  Object.assign(process.env, env);
  if (profile !== undefined) process.env.AGENTRIG_CHILD_PROFILE = profile;
}

/** Train checks every declared slot before validation or the headless child can spend. */
export async function trainChildEnvironment(checkout: string, profile?: string, inherited: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<NodeJS.ProcessEnv> {
  const config = await readConfigFile(join(checkout, ".agentrig", "config.json"));
  assertNoProjectChildEnv(config);
  const env = await resolveChildEnvironment(checkout, profile, inherited, home, config ?? {});
  for (const binding of Object.values(config?.reviewers ?? {})) reviewerHome(binding.adapter, env);
  return { ...env, ...(profile === undefined ? {} : { AGENTRIG_CHILD_PROFILE: profile }) };
}

/** Runtime user-only profiles do not fabricate project-check profile declarations. */
export async function trainProfileTestTimeout(checkout: string, profile?: string): Promise<number | undefined> {
  const project = await readConfigFile(join(checkout, ".agentrig", "config.json"));
  return resolveTrainTestTimeout(checkout, profile !== undefined && project?.profiles?.[profile] !== undefined ? profile : undefined);
}
