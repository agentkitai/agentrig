import type { CommandOutcome } from "./events.js";
import type { ToolContext, ToolResult } from "./tool.js";

// Internal, process-local receipt. Neither returned JSON fields nor a tool's display name
// authorizes an observation. Binding both identities prevents copying or replay into another call.
const receipts = new WeakMap<object, { context: ToolContext; outcome: Readonly<CommandOutcome> }>();

export function stampCommandOutcome(result: ToolResult, context: ToolContext, outcome: CommandOutcome): void {
  if (outcome.command.length > 1024 || outcome.cwd.length > 4096) return;
  receipts.set(result, { context, outcome: Object.freeze({ ...outcome }) });
}

export function takeCommandOutcome(result: ToolResult, context: ToolContext): CommandOutcome | undefined {
  const receipt = receipts.get(result);
  receipts.delete(result);
  return receipt?.context === context ? { ...receipt.outcome } : undefined;
}
