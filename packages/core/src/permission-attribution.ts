import { z } from "zod";
import { Decision, PermissionClass } from "./permission-types.js";
import { CommandPrefixSchema } from "./shell-operation.js";

const Name = z.string().min(1).max(256).refine(s => !/[\u0000-\u001f\u007f]/.test(s));
export const PermissionRuleSnapshotSchema = z.object({
  tool: Name.optional(), class: PermissionClass.optional(), cwdOnly: z.boolean().optional(),
  commandPrefix: CommandPrefixSchema.optional(), decision: Decision,
}).strict();
export const PermissionPolicySourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("rule"), index: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), rule: PermissionRuleSnapshotSchema }).strict(),
  z.object({ kind: z.literal("fallback") }).strict(),
  z.object({ kind: z.literal("unknown") }).strict(),
]);
export const PermissionPolicyReceiptSchema = z.object({ decision: Decision, source: PermissionPolicySourceSchema }).strict();
export type PermissionPolicyReceipt = z.infer<typeof PermissionPolicyReceiptSchema>;
export const PermissionDecisionSourceSchema = z.discriminatedUnion("kind", [
  ...PermissionPolicySourceSchema.options,
  z.object({ kind: z.literal("grant"), grantId: Name }).strict(),
  // onAsk may be a human UI or arbitrary trusted host callback; do not assert which.
  z.object({ kind: z.literal("approval-handler") }).strict(),
  z.object({ kind: z.literal("unattended") }).strict(),
  z.object({ kind: z.literal("boundary"), reason: Name }).strict(),
]);
export type PermissionDecisionSource = z.infer<typeof PermissionDecisionSourceSchema>;
