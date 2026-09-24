import { createHash } from "node:crypto";
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

/** Compatibility only: new callers use provider-bound .agentrig/agents roles directly. */
export function shipBuilderCompatibility(provider: string | undefined, toolNames: string[], occupiedRoles: readonly string[] = []) {
  if (provider === undefined) return { roles: [] };
  const inheritedTools = [...new Set(toolNames.filter(name => name !== "subagent"))];
  // Core's role schema remains bounded. Legacy explicit-provider children inherit
  // the complete runtime tool catalogue without manufacturing invalid manifests.
  const bound = inheritedTools.length > 64 ? "64 tools per role" : occupiedRoles.length > 30 ? "32 roles per catalogue" : undefined;
  if (bound) return {
    roles: [],
    warning: `builderProvider / --builder-provider is deprecated; replace it with a provider-bound role in .agentrig/agents/<role>.md. Using explicit-provider fallback: compatibility roles would exceed ${bound}; no tools or project roles were dropped.`,
    systemPrompt: `Legacy builderProvider compatibility: role synthesis would exceed ${bound}. For ship builder and fixer children use subagent with explicit provider: ${JSON.stringify(provider)} and no agent field. Project roles remain unchanged; this fallback has no synthetic role binding.`,
  };
  const occupied = new Set(occupiedRoles);
  const roles = ["builder", "fixer"].map(kind => {
    const body = `Act as the ship ${kind}. Follow the assigned task and skill; do not expand its scope.`;
    const fields = { tools: inheritedTools, provider,
      "model-role": "subagents" as const, delegable: false };
    const base = `legacy-ship-${kind}`;
    let name = base;
    for (let suffix = 1; occupied.has(name); suffix++) name = `${base}-${suffix}`;
    occupied.add(name);
    return { name, body, ...fields, schema: "1" as const, origin: `ship:compat/${name}`,
      hash: createHash("sha256").update(JSON.stringify({ name, body, fields })).digest("hex") };
  });
  return { roles,
    warning: `builderProvider / --builder-provider is deprecated; replace it with a provider-bound role in .agentrig/agents/<role>.md (provider: ${provider}) and call subagent with agent: <role>.`,
    // Preserve the old marker for conductors already running the earlier ship instructions.
    systemPrompt: `Train builder provider entry: ${JSON.stringify(provider)}. See ship's builder routing rule.\nCompatibility role bindings: use subagent agent: "${roles[0]!.name}" for builders and agent: "${roles[1]!.name}" for fixers, including continuations. Omit subagent.provider when using these roles. Old conductors may still pass the named provider explicitly. Never apply this override to reviewers, arbiters or landers.`,
  };
}
