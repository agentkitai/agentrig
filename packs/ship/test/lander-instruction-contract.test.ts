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

const recoverySources = [
  ".agentrig/agents/lander.md",
  ".agentrig/skills/land/SKILL.md",
  "packs/ship/docs/MERGE-GUARD.md",
  "docs/SHIPPING-WORKFLOW.md",
];
it.each(recoverySources)("%s bounds command-form recovery without weakening gates", path => {
  const text = readSkillText(path);
  expect(text).toContain("Run every `gh` command as one literal command without shell operators, pipes, or substitutions, including read-only commands.");
  expect(text).toContain("Prepare files and process output in separate tool calls.");
  expect(text).toContain("If the ship-pack hook refuses a malformed non-merge command, correct the command to the accepted literal form named in the refusal and retry once.");
  expect(text).toContain("If that retry is refused, halt and report the exact reason.");
  expect(text).toContain("This retry is only a command-form correction, not permission to bypass a ledger refusal or change evidence.");
  expect(text).toContain("If a bounded merge command is refused or any land gate fails, halt and report the exact reason; do not retry the merge or weaken the gate.");
  expect(text).toContain("Authorization, exact-head CI, dispatch binding, append-only ledger/source checks, review resolution, and post-merge CI remain required.");
  expect(text).not.toContain("If any land gate or the merge guard refuses, halt");
});
