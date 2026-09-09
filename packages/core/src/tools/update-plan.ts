import { z } from "zod";
import type { AnyTool } from "../tool.js";
import { PlanItem } from "../events.js";

const Item = z.object({
  id: z.string().min(1).describe("stable id for this step, so status changes can be tracked"),
  text: z.string().min(1).describe("what the step is, in one line"),
  status: z.enum(["pending", "in_progress", "done", "dropped"]),
  accept: PlanItem.shape.accept.describe("observable acceptance check for this item, e.g. pnpm test exits 0; declaration only, not verified proof; at most 1024 characters"),
  scope: z
    .array(z.string())
    .optional()
    .describe("files or directories this step may touch, e.g. [\"packages/core/src\"]"),
});

const Input = z.object({
  items: z.array(Item).min(1).describe("the whole plan, not a delta — send every step each time"),
});

/**
 * How one acceptance check is described, in one place.
 *
 * This wording is a promise about what the harness knows: a check is something the model DECLARED,
 * never something anything here evaluated. The tool result and the CLI's plan rendering were
 * separately maintained copies of this string, which is exactly the kind of duplication that ends
 * with one of them quietly dropping "(unverified)".
 */
export function renderPlanAcceptance(accept: string | undefined): string {
  return `accept: ${accept === undefined ? "undeclared (unverified)" : `${JSON.stringify(accept)} (declared, unverified)`}`;
}

/**
 * The plan as displayed. A plan where NOTHING is declared — a legacy plan, or one written before
 * `accept` existed — repeated "undeclared (unverified)" once per step and buried the steps in it.
 * It is stated once instead, and still stated: quieter is not the same as hidden, and no item is
 * ever shown without its own check when any item has one.
 */
export function renderPlanItems(items: readonly { status: string; text: string; accept?: string | undefined }[]): string {
  const declared = items.filter((item) => item.accept !== undefined).length;
  if (declared === 0) {
    return [...items.map((item) => `  [${item.status}] ${item.text}`),
      `  acceptance: undeclared for all ${items.length} step(s) (unverified)`].join("\n");
  }
  return items.map((item) => `  [${item.status}] ${item.text}\n    ${renderPlanAcceptance(item.accept)}`).join("\n");
}

/**
 * Emits `plan.updated`, which two supervisor pieces are specified in terms of and neither could
 * use before this existed: `drift` (PLAN §4.1) compares `file.changed` against the plan's declared
 * `scope`, and `force_replan` (§4.2) requires a fresh plan before more tool calls. The event and
 * both consumers shipped in M0 and M4; nothing ever emitted one, so both were dormant.
 *
 * The whole plan is sent each time rather than a delta: a partial update would need merge rules,
 * and a plan the model can only patch is one it stops re-reading.
 */
export function updatePlanTool(): AnyTool {
  return {
    name: "update_plan",
    sandbox: "compatible",
    description:
      "Record or revise your plan for this task. Send the complete list of steps every time. " +
      "Declare a `scope` per step naming the files or directories it may touch — work outside " +
      "the declared scope is flagged. Include `accept` per item: the observable check that would " +
      "demonstrate completion. Checks are declarations, not verified evidence; status done does not verify them. " +
      "Call this before starting work and whenever the plan changes.",
    inputSchema: Input,
    // planning touches nothing on disk and reads nothing sensitive; gating it behind a
    // permission prompt would make the safest possible call the most annoying one
    permission: "read",
    effects: "read-only",
    execute: async (input: z.infer<typeof Input>, ctx) => {
      ctx.emit({ type: "plan.updated", items: input.items });
      return { output: `plan recorded (${input.items.length} steps)`, display: `plan:\n${renderPlanItems(input.items)}` };
    },
  };
}
