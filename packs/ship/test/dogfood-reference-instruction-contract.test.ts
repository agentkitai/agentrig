import { expect, it } from "vitest";
import { readSkillText } from "../../../test/skill-text.js";

const dogfood = readSkillText(".agentrig/skills/dogfood/SKILL.md");

it("dogfood cites the existing declared reviewer slots and check ordering rule", () => {
  const policy = readSkillText("docs/SHIPPING-WORKFLOW.md");
  const section = policy.split("## 3. ")[1]!.split("## 4. ")[0]!;
  expect(section).toContain("### Declared reviewer slots and check ordering");
  expect(dogfood).toContain("This policy implements shipping policy §3's declared reviewer slots and check ordering rule");
  expect(dogfood).not.toContain("reviewer-trio rule");
});

it("dogfood standalone reviews reference the named cleanup section without a stale direction", () => {
  expect(dogfood).toContain("## Review scratch cleanup\n");
  const standalone = dogfood.split("## 8. ")[1]!.split("## 9. ")[0]!;
  expect(standalone).toContain("Apply the shared **Review scratch cleanup** contract to all declared slots only,");
  expect(standalone).not.toMatch(/cleanup[^\n]*\b(?:above|below)\b/);
});

const checkArbiterCitation = (text: string) => {
  const opening = text.split("## 1.")[0]!;
  expect(opening).toContain("This policy implements shipping policy §3's declared reviewer slots and check ordering rule");
  expect(opening).not.toContain("reviewer-trio rule");
  expect(opening).toContain("and supersedes conflicting inherited ship/land check instructions for this task.");
};
it("arbiter cites the existing declared reviewer-slot rule without stale supersession", () => {
  checkArbiterCitation(readSkillText(".agentrig/skills/arbiter/SKILL.md"));
});
it("M-arbiter-stale-citation: restoring the obsolete citation violates the contract", () => {
  const arbiter = readSkillText(".agentrig/skills/arbiter/SKILL.md");
  checkArbiterCitation(arbiter);
  const mutant = arbiter.replace("This policy implements shipping policy §3's declared reviewer slots and check ordering rule", "This policy supersedes shipping policy §3's reviewer-trio rule");
  expect(mutant).not.toBe(arbiter);
  expect(() => checkArbiterCitation(mutant)).toThrow();
});
