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
