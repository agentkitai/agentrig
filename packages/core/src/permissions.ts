import { isAbsolute, relative, resolve } from "node:path";
import type { Decision, PermissionClass, PermissionRequest } from "./events.js";
import { CommandPrefixSchema, ShellOperationSchema } from "./shell-operation.js";
import { PermissionPolicyReceiptSchema, type PermissionPolicyReceipt, type PermissionDecisionSource } from "./permission-attribution.js";

export interface PermissionPolicy {
  decide(req: PermissionRequest, report?: (receipt: PermissionPolicyReceipt) => void): Promise<Decision>;
}

/** Evaluate exactly once. Optional diagnostics cannot change the policy's actual decision.
 * A custom policy may ignore the callback. Malformed, multiple, mismatched or late receipts
 * never become guessed attribution; trusted policy code itself is not sandboxed. */
export async function evaluatePermissionPolicy(policy: PermissionPolicy, req: PermissionRequest): Promise<{ decision: Decision; source: PermissionDecisionSource }> {
  let active = true;
  let seen = 0;
  let receipt: PermissionPolicyReceipt | undefined;
  let decision: Decision;
  try {
    decision = await policy.decide(req, value => {
      if (!active) return;
      seen = Math.min(2, seen + 1);
      if (seen !== 1) { receipt = undefined; return; }
      try { const parsed = PermissionPolicyReceiptSchema.safeParse(value); if (parsed.success) receipt = parsed.data; }
      catch { receipt = undefined; }
    });
  } finally { active = false; }
  const source = receipt?.decision === decision && (receipt.source.kind !== "rule" || receipt.source.rule.decision === decision)
    ? receipt.source : { kind: "unknown" as const };
  return { decision, source };
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
  /** Explicit literal argv prefix for supported foreground shell operations, not a string glob.
   * Program behavior/PATH/hooks are not attested. Separate broad rules retain their authority. */
  commandPrefix?: string[];
  decision: Decision;
}

export function isInsideCwd(cwd: string, path: string): boolean {
  const abs = isAbsolute(path) ? path : resolve(cwd, path);
  const rel = relative(resolve(cwd), abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** First matching rule wins; no match falls through to `fallback` (default `ask`). */
export class RulePolicy implements PermissionPolicy {
  private readonly rules: PermissionRule[];
  constructor(
    rules: PermissionRule[],
    private readonly fallback: Decision = "ask",
  ) {
    this.rules = rules.map(rule => ({ ...rule, ...(rule.commandPrefix === undefined ? {} : { commandPrefix: CommandPrefixSchema.parse(rule.commandPrefix) }) }));
  }

  async decide(req: PermissionRequest, report?: (receipt: PermissionPolicyReceipt) => void): Promise<Decision> {
    for (const [index, rule] of this.rules.entries()) {
      if (rule.tool !== undefined && rule.tool !== "*" && rule.tool !== req.tool) continue;
      if (rule.class !== undefined && rule.class !== req.class) continue;
      if (rule.commandPrefix !== undefined) {
        const operation = ShellOperationSchema.safeParse(req.operation);
        if (!operation.success || operation.data.status !== "parsed" || operation.data.background) continue;
        const argv = operation.data.argv;
        if (!rule.commandPrefix.every((word, index) => argv[index] === word)) continue;
      }
      if (rule.cwdOnly) {
        if (req.paths === undefined) continue;
        if (!req.paths.every((p) => isInsideCwd(req.cwd, p))) continue;
      }
      // Diagnostic reporting must not give a callback a reference to the live rules.
      report?.({ decision: rule.decision, source: { kind: "rule", index: index + 1, rule: structuredClone(rule) } });
      return rule.decision;
    }
    report?.({ decision: this.fallback, source: { kind: "fallback" } });
    return this.fallback;
  }
}

/**
 * Reads inside the cwd are safe; everything else escalates to `ask` (which headless mode resolves
 * to deny).
 *
 * `update_plan` is allowed by name and must come first. It declares `read` but touches no path,
 * and the `cwdOnly` rule below is skipped whenever `req.paths` is undefined — so under the plain
 * defaults it fell through to `ask` and headless denied it. That is not a cosmetic gap: the
 * supervisor's `force_replan` gate (PLAN §4.2) refuses every tool until a fresh plan lands, so a
 * denied `update_plan` is a gate nothing can ever clear. Interactively it was just as wrong the
 * other way — a prompt on every plan revision, for a call that reads and writes nothing.
 */
export const defaultRules: PermissionRule[] = [
  { tool: "update_plan", decision: "allow" },
  // Same shape of gap as update_plan: `bash_job` only observes or stops jobs this session's own
  // `bash` already got permission to start — there is nothing new to approve. Falling through to
  // `ask` meant headless mode denied every poll, leaving a running job the session could neither
  // see nor stop, and interactive mode prompted on each one.
  { tool: "bash_job", decision: "allow" },
  // `read_output` can only read an artifact from this session's validated append-only log. It has
  // no honest filesystem path to declare, so the cwdOnly rule cannot match it; prompting would
  // make overflow recovery unavailable in headless mode despite granting no new read capability.
  { tool: "read_output", decision: "allow" },
  { class: "read", cwdOnly: true, decision: "allow" },
];
