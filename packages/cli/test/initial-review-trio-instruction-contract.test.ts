import { expect, it } from "vitest";
import { instructionSource } from "./instruction-source.js";
const read = (skill: string) => instructionSource(`.agentrig/skills/${skill}/SKILL.md`);
function policy(text: string) {
  const section = text.split("## Declared reviewer slots (issue #396)")[1]?.split("\n## ")[0] ?? "";
  for (const phrase of ["zero, one or two named slots", "API slots reference existing provider entries by name", "same-head declared checks GREEN BEFORE launching any", "reviewers judge code and never run project checks", "Optional targeted mutation probes", "Hosted CI overlaps review", "External review: none declared", "checks → CI → land", "With 1 slot, only that slot reviews", "Landing requires only declared slots", "their exact pinned models", "named receipts"]) expect(section.replace(/\s+/g, " ")).toContain(phrase);
  expect(text).not.toMatch(/claude|codex|opus|anthropic|openai|gpt-/i);
}
for (const skill of ["dogfood", "topic", "ship", "review", "land"]) {
  it(`${skill} declares role separation, zero/one/two slots and landing gates`, () => policy(read(skill)));
  for (const phrase of ["GREEN BEFORE launching any", "only declared slots", "External review: none declared", "their exact pinned models"]) it(`M-declared-role ${skill} kills removal of ${phrase}`, () => {
    const text = read(skill); policy(text);
    expect(() => policy(text.replaceAll(phrase, "REMOVED"))).toThrow();
  });
}
it("topic operative flow orders preparation and checks before launch and passes provenance", () => {
  const text = read("topic").split("4. Run the **external review pass**")[1]?.split("## 3.")[0] ?? "";
  const ordered = ["**Prepare.**", "**Independent conductor checks — BEFORE reviewers.**", "**Launch each declared slot.**", "**Wait.**", "**Provenance.**", "scripts/post-review-comment.mjs"];
  let previous = -1;
  for (const gate of ordered) { const index = text.indexOf(gate); expect(index).toBeGreaterThan(previous); previous = index; }
  for (const required of ["exit code zero in each", "before launching any reviewer job", "persist the failure receipt", "REVHEAD must equal the current PR HEAD", "GREEN before any launch", "pass", "these receipts to every slot", "actual model equals the configured pin", "Nonzero stops posting", "Persist", "partial/uncertain"]) expect(text).toContain(required);
});
it("shipping policy has no reviewer-trio special case", () => {
  const policy = instructionSource("docs/SHIPPING-WORKFLOW.md").split("## 3.")[1]?.split("\n## ")[0] ?? "";
  expect(policy).not.toMatch(/Codex trio|reviewers run the affected checks|focused reviews run the affected checks/);
  expect(policy).toContain("GREEN BEFORE launching any reviewers");
});
it("review's operative probe section is optional rather than a hidden check gate", () => {
 const text = read("review").split("## 5. Test quality and mutation probes")[1]?.split("## 6.")[0] ?? "";
 expect(text).toContain("There is no required probe count");
 expect(text).toContain("optional reviewer-owned probe, never a check gate");
 expect(text).not.toMatch(/run 2-4|re-run at least one/);
});
it("land compares every declared pin, not one hardcoded model", () => {
  const text = read("land");
  expect(text).toContain("initial heading model must equal its configured pin");
  expect(text).toContain("require\nonly declared slot comments with exact declared pins");
});
