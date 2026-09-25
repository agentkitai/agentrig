import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { readSkillText } from "../../../test/skill-text.js";
import { compatibilityCopies } from "../compatibility.mjs";

const baseline = readFileSync(new URL("./checklist-baseline.txt", import.meta.url), "utf8").trim();
const source = readFileSync(new URL("../skills/shared/pre-push-checklist.md", import.meta.url), "utf8");
const guidance = [
  "include the PRE-PUSH CHECKLIST block below verbatim in EVERY builder/fixer",
  "dispatch, including initial builders, continuations, retries and repair batches.",
  "before every push, check every item and record each item by number",
  "under `## Checklist` in the PR body as addressed (with evidence) or not applicable",
  "(with a reason). This applies to standalone dogfood authors as well as children.",
  "Reviewers and landers must not block on a",
  "missing or partial `## Checklist` section.",
  "Actual acceptance failures, unsafe",
  "behavior and missing required proof remain blocking",
];

it("C607-baseline: preserves all twelve tested items verbatim in one shared source", () => {
  expect(baseline.match(/^\d+\. /gm)).toHaveLength(12);
  expect(source).toContain(baseline);
  expect(source).toContain("https://github.com/agentkitai/agentrig/issues/607");
  expect(source).toContain("Refresh this checklist manually from recurring blocking");
  expect(source).toContain("no automated extraction, scoring, or enforcement is added");
});

for (const skill of ["dogfood", "ship", "topic"]) {
  it(`C607-${skill}: shared include reaches source composition and LF/CRLF compatibility reader`, async () => {
    const manifest = readFileSync(new URL(`../skills/${skill}.md`, import.meta.url), "utf8");
    expect(manifest).toContain('"shared/pre-push-checklist.md"');
    const path = `.agentrig/skills/${skill}/SKILL.md`;
    const copies = await compatibilityCopies();
    for (const text of [copies.get(path)!, readSkillText(path)]) {
      expect(text.split(baseline)).toHaveLength(2);
      for (const phrase of guidance) expect(text).toContain(phrase);
    }
  });
}

it("C607-policy: guidance cannot become a landing gate or waive actual failures", () => {
  for (const path of ["../docs/SHIPPING-WORKFLOW.md", "../../../docs/SHIPPING-WORKFLOW.md"]) {
    const text = readFileSync(new URL(path, import.meta.url), "utf8");
    for (const phrase of [
      "guidance, not a landing gate: reviewers and landers must not block on a",
      "missing or partial Checklist", "Actual acceptance failures and missing required",
      "proof remain blocking", "Refresh the checklist manually from recurring blocking-finding classes",
      "no automated extraction, scoring, enforcement or new gate",
      "LOW\nobservations and wording followups are advisories, not residual issues",
    ]) expect(text).toContain(phrase);
  }
});
