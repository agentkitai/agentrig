import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { readConfigFile, resolveConfig, type ConfigFile, type ReviewerSlot } from "./config.js";
import { resolveProjectBoundary, resolveProjectTrust } from "./trust.js";

/** Use the same boundary guard and file loader as CLI preAction. */
export async function loadChildUserConfig(cwd: string, home = homedir()): Promise<ConfigFile | undefined> {
  const boundary = await resolveProjectBoundary(cwd, home);
  return boundary.userStateSafe ? readConfigFile(join(home, ".agentrig", "config.json")) : undefined;
}

/** Only operator-owned USER profiles may supply process environment. Project profiles
 * continue to resolve normal options but never grant environment-setting authority. */
export async function resolveChildEnvironment(options: { cwd?: string; home?: string; profile?: string; env?: NodeJS.ProcessEnv; validateProfile?: boolean; explicitTrust?: boolean; project?: ConfigFile; user?: ConfigFile } = {}): Promise<NodeJS.ProcessEnv> {
  const cwd = options.cwd ?? process.cwd(), home = options.home ?? homedir();
  const env = { ...(options.env ?? process.env) };
  const profile = options.profile ?? env.AGENTRIG_CHILD_PROFILE;
  const user = options.user ?? await loadChildUserConfig(cwd, home);
  if (profile !== undefined && profile !== "recommended") {
    // Reuse normal built-in/unknown-profile validation; trusted project declarations
    // may name profiles, but never contribute environment authority.
    const trust = options.project === undefined ? await resolveProjectTrust(cwd, { home, interactive: false, ...(options.explicitTrust === undefined ? {} : { explicitTrust: options.explicitTrust }) }) : undefined;
    const project = options.project ?? (trust?.trusted ? await readConfigFile(join(trust.projectRoot, ".agentrig", "config.json")) : undefined);
    resolveConfig({ defaults: {}, cli: {}, env: {}, ...(user === undefined ? {} : { user }), ...(project === undefined ? {} : { project }), profile });
  }
  Object.assign(env, profile === undefined ? {} : user?.profiles?.[profile]?.childEnv);
  if (profile !== undefined) env.AGENTRIG_CHILD_PROFILE = profile;
  return env;
}
export function reviewerHome(slot: string, adapter: string, env: NodeJS.ProcessEnv): { variable: string; home: string } | undefined {
  const variable = adapter === "codex-cli" ? "CODEX_HOME" : adapter === "claude-cli" ? "CLAUDE_CONFIG_DIR" : undefined;
  if (!variable) return undefined;
  const home = env[variable];
  if (!home?.trim()) throw Object.assign(new Error(`REVIEWER_HOME_MISSING: reviewers:${slot} requires ${variable} in user profile childEnv or environment`), { name: "ReviewerHomeMissingError" });
  if (!isAbsolute(home) || /[\x00-\x1f\x7f]/u.test(home)) throw Object.assign(new Error(`REVIEWER_HOME_INVALID: reviewers:${slot} requires an absolute ${variable}`), { name: "ReviewerHomeInvalidError" });
  return { variable, home };
}
export function assertReviewerHomes(reviewers: Record<string, ReviewerSlot> | undefined, env: NodeJS.ProcessEnv): void {
  for (const [slot, binding] of Object.entries(reviewers ?? {})) reviewerHome(slot, binding.adapter, env);
}
export async function trainChildEnvironment(cwd: string, profile?: string): Promise<NodeJS.ProcessEnv> {
  const trust = await resolveProjectTrust(cwd, { home: homedir(), interactive: false });
  const config = trust.trusted ? await readConfigFile(join(trust.projectRoot, ".agentrig", "config.json")) : undefined;
  const user = await loadChildUserConfig(cwd);
  const env = await resolveChildEnvironment({ cwd, ...(user === undefined ? {} : { user }), validateProfile: true, ...(config === undefined ? {} : { project: config }), ...(profile === undefined ? {} : { profile }) });
  assertReviewerHomes(config?.reviewers, env);
  return env;
}
