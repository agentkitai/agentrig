import { readSkillText } from "../../../test/skill-text.js";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const topic = readSkillText(new URL("../../../.agentrig/skills/topic/SKILL.md", import.meta.url));
const policy = readFileSync(new URL("../../../docs/SHIPPING-WORKFLOW.md", import.meta.url), "utf8");
for (const phrase of ["delimited JSON", "expected full reviewedHead", "never fall back when a machine block is present but invalid", "No first-line head gate", "--validate '<PREFIX>.verdict.md'", "same delimited agentrig-verdict:v1 JSON block"]) {
  it(`M-schema-gate deletion: ${phrase}`, () => {
    const check = (text: string) => expect(text.replace(/\s+/g, " ")).toContain(phrase);
    check(topic);
    expect(() => check(topic.replace(phrase, "REMOVED"))).toThrow();
  });
}
it("M-base-tooling: PR tooling cannot evaluate itself", () => {
  const check = (text: string) => {
    const section = text.split("**Adapter checkout boundary.**")[1]!.split("**Launch each slot")[0]!;
    expect(section.replace(/\s+/g, " ")).toContain("at the fetched base-branch commit");
    expect(section).toContain("NEVER the PR head");
    expect(section).toContain("never the copies from the PR under review");
  };
  check(topic);
  expect(() => check(topic.replace("NEVER the PR head", "at the PR head"))).toThrow();
});
it("M-marker-timing: canonical conductor finalization without weakening land", () => {
  const check = (text: string) => {
    const section = text.split("## Completion-marker timing (canonical)")[1]!.replace(/\s+/g, " ");
    for (const phrase of ["conductor, not the builder or lander", "final docs-only commit after reviews and the disposition ledger resolve", "early missing marker is advisory, not a blocker", "land gate is unchanged"]) expect(section).toContain(phrase);
  };
  check(policy);
  expect(() => check(policy.replace("after reviews", "before reviews"))).toThrow();
  const land = readSkillText(new URL("../../../.agentrig/skills/land/SKILL.md", import.meta.url));
  expect(land).toContain('marks that row `*(done)*`');
});
