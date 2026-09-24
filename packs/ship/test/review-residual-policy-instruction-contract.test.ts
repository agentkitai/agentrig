import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { readSkillText } from "../../../test/skill-text.js";
const policy = readFileSync(new URL("../../../docs/SHIPPING-WORKFLOW.md", import.meta.url), "utf8");
function assertPolicy(text: string) {
  const legacy = text.split("## Structured review verdicts")[0]!;
  const canonical = text.split("## Structured review verdicts")[1]!.split("## Completion-marker")[0]!;
  expect(legacy).toContain("Finding indexing supports plain `F<n> — SEVERITY` and `[P<n>]` lines");
  expect(legacy).toContain("Recognizable unsupported findings follow the [structured review verdicts](#structured-review-verdicts) rule");
  expect(text).not.toContain("Recognizable unsupported findings fail closed");
  expect(canonical).toMatch(/logged nonfatal display\/index fallback; it cannot authorize landing/);
  expect(canonical).toContain("Unsupported recognizable prose findings are logged as nonfatal advisories, never silently dropped; the schema remains authoritative.");
  expect(text.match(/Unsupported recognizable prose findings are logged as nonfatal advisories/g)).toHaveLength(1);
  expect(canonical).toContain("Malformed/stale blocks fail closed");
}
it("#491 legacy indexing points to one canonical schema-first advisory disposition", () => {
  assertPolicy(policy);
  for (const name of ["review", "ship", "topic", "land"]) {
    const text = readSkillText(`.agentrig/skills/${name}/SKILL.md`);
    expect(text).toContain("SHIPPING-WORKFLOW.md");
  }
});
it("M-policy-fail-closed is killed by the same instruction contract", () => {
  const mutated = policy.replace("Recognizable unsupported findings follow the [structured review verdicts](#structured-review-verdicts) rule", "Recognizable unsupported findings fail closed");
  expect(mutated).not.toBe(policy);
  expect(() => assertPolicy(mutated)).toThrow();
});
