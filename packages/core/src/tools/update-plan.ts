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
      const rendered = input.items.map((i) => `  [${i.status}] ${i.text}\n    accept: ${i.accept === undefined ? "undeclared (unverified)" : `${JSON.stringify(i.accept)} (declared, unverified)`}`).join("\n");
      return { output: `plan recorded (${input.items.length} steps)`, display: `plan:\n${rendered}` };
    },
  };
}
