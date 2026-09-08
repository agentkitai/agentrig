import { describe, expect, it } from "vitest";
import { assertColdStartBudget, assertFeelBudgets, formatFeelBudgets } from "../src/feel-budgets.js";
import { feelReference } from "../src/feel-reference.js";

describe("feel budget policy", () => {
  it("rejects the exact cold-start ceiling, missing data and non-finite measurements", () => {
    expect(assertColdStartBudget(399.999)).toBe(399.999);
    for (const value of [400, 450, null, undefined, NaN, Infinity, -1]) expect(() => assertColdStartBudget(value)).toThrow();
  });
  it("validates all five actual recorded measurements and retains honest manual outcomes", () => {
    expect(assertFeelBudgets(feelReference).tasks).toHaveLength(8);
    const lines = formatFeelBudgets(feelReference).join("\n");
    expect(lines).toContain("not a measurement of this machine");
    expect(lines).toContain("cold process to visible prompt");
    expect(lines).toContain("event-loop tick");
    expect(lines).toContain("CPU per streamed event");
    for (const id of ["A1", "A2", "A3", "A4", "X1", "X2", "X3", "X4"]) expect(lines).toContain(`feel:E1:${id}`);
    expect(lines.match(/evaluator BLOCKED/g)).toHaveLength(2);
  });
  it("fails on each independent regression, missing task and fabricated manual verdict", () => {
    for (const mutate of [
      (r: ReturnType<typeof assertFeelBudgets>) => { r.coldStartMs = 400; },
      (r: ReturnType<typeof assertFeelBudgets>) => { r.stream.firstByteToEventTicks = 2; },
      (r: ReturnType<typeof assertFeelBudgets>) => { r.stream.firstByteToVisibleTicks = 2; },
      (r: ReturnType<typeof assertFeelBudgets>) => { r.stream.maxFrameCpuMs = 16; },
      (r: ReturnType<typeof assertFeelBudgets>) => { r.stream.frameCount = 0 as 16; },
      (r: ReturnType<typeof assertFeelBudgets>) => { r.tasks[0]!.permissionPrompts++; },
      (r: ReturnType<typeof assertFeelBudgets>) => { r.tasks[0]!.turnsToDone++; },
      (r: ReturnType<typeof assertFeelBudgets>) => { r.tasks[0]!.task = "X4"; },
      (r: ReturnType<typeof assertFeelBudgets>) => { r.tasks.find(t => t.task === "A4")!.check.outcome = "PASS"; },
    ]) {
      const report = assertFeelBudgets(feelReference);
      mutate(report);
      expect(() => assertFeelBudgets(report)).toThrow();
    }
  });
});
