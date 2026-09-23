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
