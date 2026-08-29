import type { Decision, PermissionClass, PermissionRequest } from "./events.js";

export interface PermissionPolicy {
  decide(req: PermissionRequest): Promise<Decision>;
}

/**
 * One allow/deny/ask rule. A rule matches when every present field matches;
 * an absent field matches anything. `tool: "*"` also matches any tool.
 */
export interface PermissionRule {
  tool?: string;
  class?: PermissionClass;
  decision: Decision;
}

/** First matching rule wins; no match falls through to `fallback` (default `ask`). */
export class RulePolicy implements PermissionPolicy {
  constructor(
    private readonly rules: PermissionRule[],
    private readonly fallback: Decision = "ask",
  ) {}

  async decide(req: PermissionRequest): Promise<Decision> {
    for (const rule of this.rules) {
      if (rule.tool !== undefined && rule.tool !== "*" && rule.tool !== req.tool) continue;
      if (rule.class !== undefined && rule.class !== req.class) continue;
      return rule.decision;
    }
    return this.fallback;
  }
}

/** Reads are safe; everything else escalates to `ask` (which headless mode resolves to deny). */
export const defaultRules: PermissionRule[] = [{ class: "read", decision: "allow" }];
