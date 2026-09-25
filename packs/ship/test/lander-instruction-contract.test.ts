import { expect, it } from "vitest";
import { readSkillText } from "../../../test/skill-text.js";

it.each(["ship", "topic"])("%s explicitly dispatches the named lander", name => {
  const text = readSkillText(`.agentrig/skills/${name}/SKILL.md`);
  expect(text).toContain('dispatch `subagent` with `agent: "lander"`');
  expect(text).not.toContain("Before invoking land in this session");
  expect(text).not.toContain("land subagent) without asking");
});

it("shipping policy requires named dispatch and fail-closed role installation", () => {
  const text = readSkillText("docs/SHIPPING-WORKFLOW.md");
  expect(text).toContain('Dispatch `subagent` with `agent: "lander"`');
  expect(text).toContain("halt and restore that role, then rebuild the agent");
  expect(text).toContain("never fall back to an unnamed");
});
