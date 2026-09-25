import { isAbsolute } from "node:path";
import { z } from "zod";

const safeText = z.string().min(1).max(4096).refine(value => value.trim().length > 0 && !/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u.test(value), "must be nonblank control-free text");
/** Non-secret launch settings only; config is not a credential store. */
export const ChildEnvSchema = z.record(safeText).superRefine((values, ctx) => {
  if (Object.keys(values).length > 64) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "childEnv accepts at most 64 variables" });
  for (const [name, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(name) || /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|PRIVATE_KEY)/u.test(name)
      || /^(?:AGENTRIG_|NODE_OPTIONS$|LD_|DYLD_)/u.test(name)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: "invalid, reserved or credential variable in childEnv" });
    }
    if ((name === "CODEX_HOME" || name === "CLAUDE_CONFIG_DIR") && !isAbsolute(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: "reviewer home must be an absolute path" });
    if (/^(?:sk-|Bearer\s|-----BEGIN .*PRIVATE KEY)/u.test(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: "credentials cannot be stored in childEnv" });
  }
});
export type ChildEnv = z.infer<typeof ChildEnvSchema>;
export const reviewerCommands = {
  "codex-cli": { variable: "CODEX_HOME", command: "codex", status: ["login", "status"] },
  "claude-cli": { variable: "CLAUDE_CONFIG_DIR", command: "claude", status: ["auth", "status", "--json"] },
} as const;

export function reviewerHome(adapter: string, env: NodeJS.ProcessEnv): { variable: string; path: string } | null {
  if (adapter.startsWith("api:")) return null;
  if (!Object.hasOwn(reviewerCommands, adapter)) throw new Error("unknown reviewer adapter");
  const { variable } = reviewerCommands[adapter as keyof typeof reviewerCommands];
  const path = env[variable];
  if (path === undefined || !safeText.safeParse(path).success || !isAbsolute(path)) {
    throw new Error(`REVIEWER_HOME_REQUIRED: set ${variable} to an absolute path in the selected user profile childEnv or environment`);
  }
  return { variable, path };
}

/** No credential files or arbitrary CLI output are ever exposed by doctor. */
export function reviewerLoginSummary(adapter: string, stdout: string, stderr: string): string | undefined {
  if (adapter === "codex-cli") {
    const lines = (stdout + "\n" + stderr).split(/\r?\n/u);
    if (lines.includes("Logged in using ChatGPT")) return "logged in using ChatGPT (CLI exposes no account identity)";
    if (lines.some(value => /^Logged in using an API key(?:\s|$)/u.test(value))) return "logged in using an API key (key redacted; CLI exposes no account identity)";
    return undefined;
  }
  if (adapter !== "claude-cli") return undefined;
  try {
    const status = z.object({ loggedIn: z.boolean(), email: z.string().max(254).regex(/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/u).nullish() }).parse(JSON.parse(stdout));
    return status.loggedIn ? `logged in${status.email ? ` as ${status.email}` : " (CLI exposes no account identity)"}` : undefined;
  } catch { return undefined; }
}
