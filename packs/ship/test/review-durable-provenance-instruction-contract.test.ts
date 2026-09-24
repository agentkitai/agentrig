import { expect, it } from "vitest";
import { readSkillText } from "../../../test/skill-text.js";

it.each(["ship", "topic", "land"])("%s preserves adapter-owned evidence beyond scratch cleanup", skill => {
  const text = readSkillText(`.agentrig/skills/${skill}/SKILL.md`);
  for (const token of ["AGENTRIG_REVIEW_REPOSITORY", "AGENTRIG_REVIEW_PR", "AGENTRIG_REVIEW_PASS",
    "$HOME/.agentrig/review-evidence/OWNER/REPO/NN/PASS/ATTEMPT/", "node scripts/review-provenance.mjs",
    '"$RECEIPT_SHA256"', "BEFORE comment validation", "Scratch cleanup never\ndeletes these durable artifacts"]) {
    expect(text).toContain(token);
  }
});

it.each(["ship", "topic", "land", "dogfood", "review"])("%s distinguishes durable pairs from the posting scratch copy", skill => {
  const text = readSkillText(`.agentrig/skills/${skill}/SKILL.md`);
  expect(text).toContain("Retain the adapter-written durable `provenance.json` and adjacent `review.md`");
  expect(text).toContain("The scratch `<PREFIX>.provenance.json` is only a posting-compatible copy.");
  expect(text).toContain("AGENTRIG_REVIEW_PASS");
  expect(text).toContain("node scripts/review-provenance.mjs");
  expect(text).not.toContain("before deleting their only local copies");
});

const policy = readSkillText("docs/SHIPPING-WORKFLOW.md");
it.each([
  ["ship", readSkillText(".agentrig/skills/ship/SKILL.md")],
  ["topic", readSkillText(".agentrig/skills/topic/SKILL.md")],
  ["policy", policy],
])("%s supplies durable identity at the positional launch recipe", (_name, text) => {
  const recipes = text.split("\n").filter(line => /node (?:<REPO>\/)?scripts\/reviewer-adapters\.mjs /.test(line));
  expect(recipes).toHaveLength(1);
  for (const recipe of recipes) {
    for (const assignment of ["AGENTRIG_REVIEW_REPOSITORY=OWNER/REPO", "AGENTRIG_REVIEW_PR=NN", "AGENTRIG_REVIEW_PASS=PASS"]) {
      expect(recipe.slice(0, recipe.indexOf("node "))).toContain(assignment);
    }
  }
});
it.each(["ship", "topic", "land", "policy"])("%s names the real adapter launch, not a nonexistent flag", name => {
  const text = name === "policy" ? policy : readSkillText(`.agentrig/skills/${name}/SKILL.md`);
  expect(text).not.toContain("adapter `--run`");
  expect(text).toContain("Before every positional adapter launch");
});
it("shipping transport policy retrieves the durable pair, not the posting scratch copy", () => {
  const section = policy.split("### Transport authority at the posting/landing boundary")[1]!.split("### Profile-scoped reviewer launch homes")[0]!;
  expect(section).not.toContain("as a durable artifact");
  expect(section).not.toContain("Land retrieves the same artifact");
  expect(section).toContain("durable `provenance.json` and adjacent `review.md`");
  expect(section).toContain("scratch `<PREFIX>.provenance.json` is only a posting-compatible copy");
  expect(section).toContain("Land retrieves the durable receipt");
  expect(section).toContain("review-provenance.mjs");
  expect(section).toContain("TRUSTED_ADAPTER_RECEIPT");
});
