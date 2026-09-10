import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

// Instruction-contract checks, not proof that a model obeys the shipping workflow.
const read = async (path: string) => (await readFile(new URL(`../../../${path}`, import.meta.url), "utf8")).replace(/\s+/g, " ");
const policy = () => read("docs/SHIPPING-WORKFLOW.md");

it.each(["dogfood", "ship", "topic", "review", "land"])("%s uses the same review/repair policy", async name => {
  const path = `.agentrig/skills/${name}/SKILL.md`;
  const text = await read(path);
  expect(text).toContain("Read [shipping policy](../../../docs/SHIPPING-WORKFLOW.md)");
  const target = new URL("../../../docs/SHIPPING-WORKFLOW.md", new URL(`../../../${path}`, import.meta.url));
  expect((await readFile(target, "utf8")).replace(/\s+/g, " ")).toBe(await policy());
});

it("starts reviews before hosted CI completes but joins both gates at landing", async () => {
  const text = await policy();
  expect(text).toContain("do not wait for hosted CI");
  expect(text).toContain("while hosted CI runs");
  expect(text).toContain("return their code verdict without waiting for CI");
  expect(text).toContain("resolved reviews AND successful required checks on the actual current head");
  expect(text).toContain("Missing, pending, cancelled, stale, or failed checks never count as green");
});

it("defers polish without turning real blockers into issues and merging them", async () => {
  const text = await policy();
  expect(text).toContain("even a LOW acceptance failure blocks");
  expect(text).toContain("All HIGH findings block");
  expect(text).toContain("an issue number never makes a blocker landable");
  expect(text).toContain("Do not implement non-blocking polish inside a blocker repair batch");
  expect(text).toContain("Record advisory followups at the end of the roadmap");
});

it("reviews material deltas with one reviewer and preserves bounded, resumable closure", async () => {
  const text = await policy();
  expect(text).toContain("task/skill workflow rules");
  expect(text).toContain("Uncertain deltas are material");
  expect(text).toContain("Use ONE independent reviewer over OLD..NEW");
  expect(text).toContain("A small executable fix is not mechanical");
  expect(text).toContain("at most THREE repair rounds");
  expect(text).toContain("Do not reset the counter after a push, conflict, restart, or reviewer change");
  expect(text).toContain("Never land unresolved blockers to meet a cap");
});

it("removes old conflicting loop and CI-wait instructions from callers", async () => {
  const names = ["dogfood", "ship", "topic", "review", "land"];
  const text = (await Promise.all(names.map(name => read(`.agentrig/skills/${name}/SKILL.md`)))).join(" ");
  for (const obsolete of ["Severity never decides fixability", "Fix majors AND minors", "every finding that carries a concrete proposed fix is repair work", "A LOW or MEDIUM residual lands once its issue exists", "Also confirm CI is green on the ACTUAL head SHA", "A clean, fully verified delta verdict from both reviewers lands"]) {
    expect(text).not.toContain(obsolete);
  }
});
