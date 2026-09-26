import { expect, it } from "vitest";
import { readSkillText } from "../../../test/skill-text.js";
it.each(["dogfood", "ship", "topic"])("%s requires typed handoff, independent checks and one conductor retry", name => {
  const text = readSkillText(`.agentrig/skills/${name}/SKILL.md`);
  for (const expected of ["childSessionId", "commandOutcome.exitCode", "gh api", "merged_at", "verifiedSources", "route the conflict", "rather than halting", "subagent.outputSchema", "output.result", "child-result.mjs assess", "necessary outside-row path", "An in-scope-only", "redispatches BUILDER", "exactly once", "previous notes", "On the second failed", "never reset the counter", 'final `{"pr":123}` receipt']) expect(text).toContain(expected);
});

it.each(["dogfood", "ship", "topic"])("%s binds session provenance to runtime identity, not host environment", name => {
  const text = readSkillText(`.agentrig/skills/${name}/SKILL.md`);
  for (const expected of ["AgentRig session id:", "never a session id from any inherited host variable", "runtime context is absent", "report provenance unavailable", "scrub host CLI nesting/session markers", "preserving reviewer-home selection"]) expect(text).toContain(expected);
});
