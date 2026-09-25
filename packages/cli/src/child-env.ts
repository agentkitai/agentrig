import { isAbsolute } from "node:path";
import { z } from "zod";
import type { ConfigFile, ReviewerSlot } from "./config.js";

const plain = z.string().max(4096).refine(value => !/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value), "must be a plain single-line string");
export const absoluteHome = (value: string): boolean => value.trim().length > 0 && isAbsolute(value);
export const reviewerHomes: Record<string, string> = { "codex-cli": "CODEX_HOME", "claude-cli": "CLAUDE_CONFIG_DIR" };
/** Configuration is not a secret store; no expansion or shell evaluation is performed. */
export const ChildEnvSchema = z.record(plain).superRefine((values, ctx) => {
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|PRIVATE_?KEY)/iu.test(key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: "childEnv keys must be environment names without secrets" });
    }
    if (Object.values(reviewerHomes).includes(key) && !absoluteHome(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: "CLI home must be an absolute path" });
  }
});

/** Project profile replaces the user profile map, matching config's object precedence. */
export function profileChildEnv(user: ConfigFile | undefined, project: ConfigFile | undefined, profile?: string): Record<string, string> {
  if (profile === undefined) return {};
  return project?.profiles?.[profile]?.childEnv ?? user?.profiles?.[profile]?.childEnv ?? {};
}

export function reviewerHome(slot: string, binding: ReviewerSlot, env: NodeJS.ProcessEnv): { variable: string; path: string } | null {
  const variable = reviewerHomes[binding.adapter];
  if (variable === undefined) return null;
  const path = env[variable];
  if (path === undefined || !absoluteHome(path) || !plain.safeParse(path).success) throw new Error(`reviewers:${slot}: missing or invalid ${variable}; set an absolute ${variable} in profiles.<name>.childEnv or the environment`);
  return { variable, path };
}

export function requireReviewerHomes(slots: Record<string, ReviewerSlot>, env: NodeJS.ProcessEnv): void {
  for (const [slot, binding] of Object.entries(slots)) reviewerHome(slot, binding, env);
}
