import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { resolveProjectBoundary } from "./trust.js";

const safeText = z.string().min(1).max(4096).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value), "must be nonblank plain single-line text");
export const ChildEnvSchema = z.record(safeText).superRefine((values, ctx) => {
  if (Object.keys(values).length > 64) ctx.addIssue({ code: "custom", message: "childEnv supports at most 64 entries" });
  for (const [name, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(name) || /TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|PRIVATE_KEY/u.test(name) || ["PATH", "HOME", "NODE_OPTIONS", "AGENTRIG_CHILD_PROFILE", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"].includes(name)) ctx.addIssue({ code: "custom", path: [name], message: "childEnv requires non-secret, non-reserved environment names" });
    if ((name === "CODEX_HOME" || name === "CLAUDE_CONFIG_DIR") && !isAbsolute(value)) ctx.addIssue({ code: "custom", path: [name], message: `${name} must be an absolute path` });
    if (/^(?:sk-|Bearer )|-----BEGIN .*PRIVATE KEY/u.test(value)) ctx.addIssue({ code: "custom", path: [name], message: "childEnv must not contain credentials" });
  }
});

/** User-owned profile only: project files cannot redirect a CLI's login home. */
export async function profileChildEnvironment(cwd: string, profile?: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<NodeJS.ProcessEnv> {
  const boundary = await resolveProjectBoundary(cwd, home);
  if (!boundary.userStateSafe || profile === undefined) return { ...env };
  const { readConfigFile } = await import("./config.js");
  const user = await readConfigFile(join(home, ".agentrig", "config.json"));
  return { ...env, ...user?.profiles?.[profile]?.childEnv };
}

export function reviewerHome(adapter: string, env: NodeJS.ProcessEnv): string | undefined {
  const name = adapter === "codex-cli" ? "CODEX_HOME" : adapter === "claude-cli" ? "CLAUDE_CONFIG_DIR" : undefined;
  if (name === undefined) {
    if (adapter.startsWith("api:")) return undefined;
    throw new Error("unknown reviewer adapter");
  }
  const value = env[name];
  if (!value || !isAbsolute(value) || !safeText.safeParse(value).success) throw new Error(`reviewer home missing or invalid: set ${name} to an absolute path in user profiles.<name>.childEnv or environment`);
  return value;
}

export async function trainChildEnvironment(cwd: string, profile?: string): Promise<NodeJS.ProcessEnv> {
  const env = await profileChildEnvironment(cwd, profile);
  const { readConfigFile } = await import("./config.js");
  const project = await readConfigFile(join(cwd, ".agentrig", "config.json"));
  for (const binding of Object.values(project?.reviewers ?? {})) reviewerHome(binding.adapter, env);
  return { ...env, ...(profile === undefined ? {} : { AGENTRIG_CHILD_PROFILE: profile }) };
}
