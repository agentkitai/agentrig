import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, win32 } from "node:path";
import { z } from "zod";
import { resolveProjectBoundary } from "./trust.js";

/** Non-secret process settings only. Values are never interpolated by a shell. */
export const ChildEnvSchema = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).refine(key => !/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|PRIVATE_?KEY)/i.test(key), "childEnv cannot contain credential variables"),
  z.string().max(8192).refine(value => !/[\x00-\x1f\x7f]/.test(value), "childEnv requires plain strings"),
).superRefine((env, ctx) => {
  for (const key of ["CODEX_HOME", "CLAUDE_CONFIG_DIR"]) {
    const value = env[key];
    if (value !== undefined && !(isAbsolute(value) || win32.isAbsolute(value))) ctx.addIssue({ code: "custom", path: [key], message: "CLI home must be an absolute path" });
  }
});

export function reviewerHome(adapter: string, env: NodeJS.ProcessEnv): { variable: string; path: string } | null {
  const variable = adapter === "codex-cli" ? "CODEX_HOME" : adapter === "claude-cli" ? "CLAUDE_CONFIG_DIR" : undefined;
  if (!variable) return null;
  const path = env[variable];
  if (!path || !ChildEnvSchema.safeParse({ [variable]: path }).success) throw new Error(`reviewer requires ${variable}: set an absolute CLI home in user profiles.<name>.childEnv or the environment`);
  return { variable, path };
}

/** Read only safe user configuration; project profiles cannot select tool identities. */
export async function profileChildEnv(cwd: string, profile?: string, home = homedir()): Promise<Record<string, string>> {
  if (!profile || !(await resolveProjectBoundary(cwd, home)).userStateSafe) return {};
  const path = join(home, ".agentrig", "config.json");
  let text: string;
  try { text = await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  const { parseConfigText } = await import("./config.js");
  return parseConfigText(path, text).profiles?.[profile]?.childEnv ?? {};
}

export function resolveChildEnv(overrides: Record<string, string>, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...inherited, ...ChildEnvSchema.parse(overrides), GIT_TRACE2_EVENT: "0" };
}

/** CLI command lifetime only: restore even when a command throws. */
export function installChildEnv(overrides: Record<string, string>): () => void {
  overrides = { ...overrides, GIT_TRACE2_EVENT: "0" };
  const old = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  return () => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
}
