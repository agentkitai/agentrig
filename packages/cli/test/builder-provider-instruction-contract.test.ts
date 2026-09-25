import { expect, it } from "vitest";
import { readSkillText } from "../../../test/skill-text.js";

it("pins the single ship builder routing rule and operational inventory", () => {
  const text = readSkillText(".agentrig/skills/ship/SKILL.md");
  expect(text.match(/## Builder routing/g)).toHaveLength(1);
  const section = text.split("## Builder routing")[1]!.split("\n## ")[0]!.replace(/\s+/g, " ");
  for (const phrase of ["run option `builderProvider`", "as `provider` on every builder and fixer spawn (including continuations)", "unless the row explicitly overrides it", "Without it, retain the configured child default", "does not change reviewers, arbiters, landers or the conductor's provider", "PR child inventory", "each child session ID, job, effective provider entry and state", "recorded `subagent.spawn.provider`, not row intent", "historical provenance unknown"]) expect(section).toContain(phrase);
});

it("documents the operator default and ten-row reassessment without automatic classification", () => {
  const text = readSkillText("docs/TRAIN-OPERATIONS.md").replace(/\s+/g, " ");
  expect(text).toContain("doc/test/helper-scoped rows default to `sol`, product rows to the profile default");
  expect(text).toContain("re-check after ten Sol rows");
  expect(text).toContain("operator policy, not automatic scope classification");
});
