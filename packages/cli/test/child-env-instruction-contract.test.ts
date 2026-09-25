import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { readSkillText } from "../../../test/skill-text.js";

it("all shipping heading/launch instructions require receipt-bound homes and explicit profile selection", () => {
  for (const skill of ["arbiter", "dogfood", "ship", "topic", "review", "land"]) {
    const text = readSkillText(new URL(`../../../.agentrig/skills/${skill}/SKILL.md`, import.meta.url));
    expect(text, skill).toContain(" — home <VARIABLE>=<JSON-quoted absolute path>");
    expect(text, skill).toContain("AGENTRIG_CHILD_PROFILE");
    expect(text, skill).toContain("Require the same home\nsuffix on every chunk");
  }
  for (const path of ["TRAIN-OPERATIONS.md", "SHIPPING-WORKFLOW.md"]) {
    const text = readFileSync(new URL(`../../../docs/${path}`, import.meta.url), "utf8");
    for (const word of ["childEnv", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "REVIEWER_HOME_REQUIRED", "doctor --profile"]) expect(text, path).toContain(word);
  }
});
