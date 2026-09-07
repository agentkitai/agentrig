import { ownedProcess } from "./owned-process.js";

export interface ReviewProcessOptions { cwd: string; signal: AbortSignal; input?: string; maxBytes?: number }
export type ReviewProcess = (program: "git" | "gh", args: string[], options: ReviewProcessOptions) => Promise<string>;

/** Fixed trusted binaries, no shell. Cancellation joins the owned child and its kill request. */
export const reviewProcess: ReviewProcess = async (program, args, options) => {
  options.signal.throwIfAborted();
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GH_PAGER: "cat", PAGER: "cat", LC_ALL: "C" };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_") && !["GIT_NO_REPLACE_OBJECTS", "GIT_TERMINAL_PROMPT", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"].includes(key)) delete env[key as keyof typeof env];
  delete (env as NodeJS.ProcessEnv).GH_REPO; delete (env as NodeJS.ProcessEnv).GH_HOST;
  return ownedProcess(program, args, { ...options, env, timeoutMs: 15_000,
    maxBytes: Math.min(options.maxBytes ?? 65_536, 65_536),
    errorMessage: "review subprocess refused, failed, exceeded its bound or was cancelled" });
};
