import { isAbsolute } from "node:path";
interface ReviewerSlot { adapter: string }
/** CLI supplies generic configuration/trust resolution; ship owns train preflight policy. */
export interface TrainHost {
  childConfiguration(cwd: string, profile?: string): Promise<{ env: NodeJS.ProcessEnv; reviewers: Record<string, ReviewerSlot> | undefined; providerEntries(): string[] }>;
  projectChecks(projectRoot: string, profile?: string): Promise<{ steps: Array<{ command: string; testTimeout?: number | undefined }> } | undefined>;
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
export function createTrainHost(host: TrainHost) {
  async function trainChildEnvironment(cwd: string, profile?: string, builderProvider?: string): Promise<NodeJS.ProcessEnv> {
    const { env, reviewers, providerEntries } = await host.childConfiguration(cwd, profile);
    if (builderProvider !== undefined && !providerEntries().includes(builderProvider)) {
      throw new Error(`unknown builder provider entry "${builderProvider}" in active profile`);
    }
    assertReviewerHomes(reviewers, env);
    return env;
  }
  /** Train keeps its fixed validation sequence; only its pnpm test budget is configurable.
   * Resolve after each fast-forward, from the same profile as the conductor.
   */
  async function resolveTrainTestTimeout(projectRoot: string, profile?: string): Promise<number | undefined> {
    const checks = await host.projectChecks(projectRoot, profile);
    const matches = checks?.steps.filter(step => step.testTimeout !== undefined
      && step.command === `pnpm test --testTimeout=${step.testTimeout}`) ?? [];
    if (matches.length > 1) throw new Error("ambiguous train pnpm test budget");
    return matches[0]?.testTimeout;
  }

  return { trainChildEnvironment, resolveTrainTestTimeout };
}
