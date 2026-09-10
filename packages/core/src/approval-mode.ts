import type { AgentConfig } from "./agent.js";

// Live host context only. Model briefs, serialized tool inputs and receipts cannot set mode.
const modes = new WeakMap<object, NonNullable<AgentConfig["approvalMode"]>>();
export function bindApprovalMode(target: object, mode: AgentConfig["approvalMode"]): void {
  modes.set(target, mode ?? "interactive");
}
export function inheritedApprovalMode(target: object): AgentConfig["approvalMode"] {
  return modes.get(target);
}
