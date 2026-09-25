import { expect, it } from "vitest";
import { readSkillText } from "../../../test/skill-text.js";
it("ship routes every builder/fixer and records effective provider without routing other roles", () => {
  const text = readSkillText(".agentrig/skills/ship/SKILL.md").replace(/\s+/g, " ");
  for (const phrase of ["--builder-provider", "every builder and fixer spawn", "unless the row explicitly says otherwise", "reviewers, arbiters and landers are unaffected", "effective builder provider", "PR body's child inventory"]) expect(text).toContain(phrase);
});
