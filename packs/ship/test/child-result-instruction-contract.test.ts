import { expect, it } from "vitest";
import { readSkillText } from "../../../test/skill-text.js";
it.each(["dogfood", "ship", "topic"])("%s requires typed handoff, independent checks and one conductor retry", name => {
  const text = readSkillText(`.agentrig/skills/${name}/SKILL.md`);
  for (const expected of ["childSessionId", "commandOutcome.exitCode", "gh api", "merged_at", "verifiedSources", "route the conflict", "rather than halting", "subagent.outputSchema", "output.result", "child-result.mjs assess", "necessary outside-row path", "An in-scope-only", "redispatches BUILDER", "exactly once", "previous notes", "On the second failed", "never reset the counter", 'final `{"pr":123}` receipt']) expect(text).toContain(expected);
});
