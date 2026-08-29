import { isAbsolute, relative, resolve } from "node:path";
import type { Decision, PermissionClass, PermissionRequest } from "./events.js";

export interface PermissionPolicy {
  decide(req: PermissionRequest): Promise<Decision>;
}

/**
 * One allow/deny/ask rule. A rule matches when every present field matches;
 * an absent field matches anything. `tool: "*"` also matches any tool.
 *
 * `cwdOnly` restricts the rule to calls whose declared paths all resolve inside the
 * session cwd. It matches only tools that declare paths at all — a pathless tool
 * (bash) can never satisfy a cwdOnly rule, so it falls through to later rules.
 */
export interface PermissionRule {
  tool?: string;
  class?: PermissionClass;
  cwdOnly?: boolean;
  decision: Decision;
}

export function isInsideCwd(cwd: string, path: string): boolean {
  const abs = isAbsolute(path) ? path : resolve(cwd, path);
  const rel = relative(resolve(cwd), abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
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
      if (rule.cwdOnly) {
        if (req.paths === undefined) continue;
        if (!req.paths.every((p) => isInsideCwd(req.cwd, p))) continue;
      }
      return rule.decision;
    }
    return this.fallback;
  }
}

/** Reads inside the cwd are safe; everything else escalates to `ask` (which headless mode resolves to deny). */
export const defaultRules: PermissionRule[] = [{ class: "read", cwdOnly: true, decision: "allow" }];
