import { expect, it } from "vitest";
import { parseSkill, SkillFrontmatterV1, skillsInjection, skillTool, type Skill } from "@agentkitai/agentrig-core";

it("accepts inert manual hints, sanitizes controls and bounds displayed code points", () => {
  const skill = parseSkill(`---\ntrigger: When testing\u0007\u202E ${"🚀".repeat(180)}\n---\nBody`, "/skills/test.md");
  expect(skill.trigger).toMatch(/^When testing /);
  expect([...skill.trigger!]).toHaveLength(160);
  expect(skill.trigger!.isWellFormed()).toBe(true);
  expect(skill.trigger).not.toMatch(/[\u0000-\u001f\u202e]/);
  expect(skillsInjection([skill])).toContain(`[trigger: ${skill.trigger}]`);
  expect(parseSkill("Plain body", "/skills/plain.md")).not.toHaveProperty("trigger");
});

it("rejects malformed, oversized or executable-shaped hint fields", () => {
  for (const trigger of [true, 7, [], {}, "", "a".repeat(1025)]) {
    expect(SkillFrontmatterV1.safeParse({ trigger }).success).toBe(false);
  }
  for (const field of ["trigger: [test]", "trigger: true", "trigger: test\ntrigger: again", "triggers: test", "allowed-tools: bash"]) {
    expect(() => parseSkill(`---\n${field}\n---\nBody`, "/skills/test.md")).toThrow();
  }
});

/** The generated dialect's required provenance fields, so a hint can also be placed in `metadata`. */
const generatedFields = Object.entries({
  "agentrig-schema": "1", "agentrig-generated": "true", "agentrig-sessions": '["session:s1","session:s2"]',
  "agentrig-page": "concepts/procedure.md", "agentrig-dream": "fixture", "agentrig-evidence": "0".repeat(64),
  "agentrig-content": "0".repeat(64), locked: "false",
}).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}\n`).join("");

it("a hint that sanitizes away entirely is absent, not an empty property", () => {
  // Zero-width space and word joiner are stripped outright and BEL collapses to whitespace that
  // then trims away, so each value passes the manifest's `min(1)` and nothing survives
  // sanitization. An empty string is not a shorter hint, it is no hint — a consumer testing
  // `"trigger" in skill` must not be handed one.
  const zwsp = String.fromCharCode(0x200b), joiner = String.fromCharCode(0x2060), bel = String.fromCharCode(7);
  for (const value of [zwsp + joiner, bel, " " + zwsp + " "]) {
    const manual = parseSkill(`---\nname: test\ntrigger: ${value}\n---\nBody`, "/skills/test.md");
    expect(manual).not.toHaveProperty("trigger");
    expect(skillsInjection([manual])).not.toContain("[trigger:");
  }
  const generated = parseSkill(
    `---\nname: hinted\ndescription: d\nmetadata:\n${generatedFields}  agentrig-trigger: ${JSON.stringify(zwsp)}\n---\nBody`,
    "/skills/hinted/SKILL.md");
  expect(generated.generated).toBe(true);
  expect(generated).not.toHaveProperty("trigger");
  // a hint with anything left still lands on the property, so absence means absence
  expect(parseSkill(`---\nname: test\ntrigger: ${zwsp}When testing\n---\nBody`, "/skills/test.md").trigger).toBe("When testing");
});

it("total byte cap covers multibyte hints, example and omitted entries", () => {
  const skills = Array.from({ length: 100 }, (_, i) => parseSkill(`---\nname: s${i}\ndescription: ${"界".repeat(200)}\ntrigger: ${"界".repeat(160)}\n---\nBody`, `/skills/s${i}.md`));
  const text = skillsInjection(skills);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8192);
  expect(text).toContain("further skill(s) not listed");
  expect(text).toContain("- s0:");
  expect(text.match(/Select the skill matching the task/g)).toHaveLength(1);
});

it("selection guidance accompanies listed names, with none for an empty catalogue", () => {
  const oversized: Skill = { name: "x".repeat(9000), description: "too large", path: "/x", body: "body" };
  const actual = parseSkill("body", '/skills/a"quote.md');
  const text = skillsInjection([oversized, actual]);
  expect(text).toContain(`- ${actual.name}:`);
  expect(text).toContain("Select the skill matching the task");
  expect(skillTool([actual]).inputSchema.parse({ name: actual.name })).toEqual({ name: actual.name });
  expect(skillsInjection([oversized])).not.toContain("Select the skill");
  expect(Buffer.byteLength(skillsInjection([oversized]))).toBeLessThanOrEqual(8192);
  expect(skillsInjection([])).toBe("");
});
