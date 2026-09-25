import { expect, it } from "vitest";
import { readSkillText } from "../../../test/skill-text.js";
it.each(["dogfood", "ship", "topic", "land", "review", "arbiter"])("%s preserves profile home and heading instructions", skill => {
  const text = readSkillText(`.agentrig/skills/${skill}/SKILL.md`);
  expect(text).toContain('insert ` [VARIABLE="/resolved/path"]` immediately after the model parentheses');
  expect(text).toContain('Pass `--profile <name>` to the adapter');
  expect(text).toContain('missing CODEX_HOME or CLAUDE_CONFIG_DIR refuses that CLI slot');
  expect(text).toContain('Never read or print credentials');
});
