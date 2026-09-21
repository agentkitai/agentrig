import { expect, it } from "vitest";
import { instructionSource } from "./instruction-source.js";
const read = (skill: string) => instructionSource(`.agentrig/skills/${skill}/SKILL.md`);
const heading = "## External review — <slot> (<model>) — head <SHA> — merged with origin/main <MAIN> — full";
function headingContract(text: string) {
 const section = text.split("## Initial full review heading contract")[1]?.split("\n## ")[0] ?? "";
 expect(section).toContain(heading);
 expect(section).toContain("No alternate heading is valid for posting");
 expect(section).toContain("Require the complete heading, not just its prefix");
 expect(section).toContain("not focused delta verdicts");
 const headings = [...text.matchAll(/[`"](## (?:External|Independent|Peer|Adversarial)[^`"\n]*)[`"]/g)].map(match => match[1]);
 for (const found of headings) expect(found).toBe(heading);
}
for (const skill of ["dogfood", "topic", "ship", "review", "land"]) {
 it(`${skill} has slot/model canonical full heading`, () => headingContract(read(skill)));
 for (const [id, replacement] of [["M-heading-short", "## External review — <slot>"], ["M-heading-delimiter", heading.replaceAll(" — ", " | ")], ["M-heading-role", heading.replace("<slot>", "anyone")]]) it(`${skill} ${id}`, () => {
  const text = read(skill); headingContract(text);
  expect(() => headingContract(text.replaceAll(heading, replacement!))).toThrow();
 });
 it(`${skill} rejects alternate heading even if canonical survives`, () => expect(() => headingContract(read(skill) + '\nPost `## Independent review — arbitrary`')).toThrow());
}
it("rerun gate reuses complete slot/model/head evidence without requiring historical base equal current main", () => {
 const gate = read("topic").split("4. Run the **external review pass**")[1]?.split("- **Prepare.**")[0] ?? "";
 for (const phrase of ["complete matching slot/model/head", "missing declared slots still must finish", "historical provenance and need not equal current main", "re-verifies exact-head CI", "Conflict", "material-delta rules", "Never pass builder reasoning"]) expect(gate).toContain(phrase);
});
it("isolated reviewer hands off only its own verdict", () => {
 const text = read("review");
 expect(text).toContain("Hand off only your own verdict and provenance to the conductor");
 expect(text).toContain("invoke a counterpart, or fabricate a counterpart verdict");
 expect(text).toContain("conductor launches this review through");
});
it("ship delegates launch/provenance to slot adapters after checks while CI overlaps", () => {
 const section = read("ship").split("## 2. Review")[1]?.split("## 3.")[0] ?? "";
 for (const phrase of ["topic §2 step 4", "only the declared slots", "pass conductor receipts", "Do not start reviewers before independent checks are green", "Hosted CI may run concurrently"]) expect(section).toContain(phrase);
});
