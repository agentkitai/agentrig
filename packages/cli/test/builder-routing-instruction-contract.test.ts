import { expect, it } from "vitest";
import { readSkillText } from "../../../test/skill-text.js";
it("ship owns builder routing once, separates other roles and records effective inventory", () => {
  const text = readSkillText(".agentrig/skills/ship/SKILL.md");
  expect(text.match(/## Builder provider routing/g)).toHaveLength(1);
  for (const rule of ["Use it as `provider`", "run --builder-provider <entry>", "profile's configured child default", "every builder, continuation builder and fixer", "unless the row explicitly overrides", "reviewers, arbiters and landers are unaffected", "effective builder provider", "child inventory"]) expect(text).toContain(rule);
});
