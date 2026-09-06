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

it("total byte cap covers multibyte hints, example and omitted entries", () => {
  const skills = Array.from({ length: 100 }, (_, i) => parseSkill(`---\nname: s${i}\ndescription: ${"界".repeat(200)}\ntrigger: ${"界".repeat(160)}\n---\nBody`, `/skills/s${i}.md`));
  const text = skillsInjection(skills);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8192);
  expect(text).toContain("further skill(s) not listed");
  expect(text).toContain('skill({"name":"s0"})');
  expect(text.match(/First call/g)).toHaveLength(1);
});

it("example uses an actually listed name and valid tool input, with none for an empty catalogue", () => {
  const oversized: Skill = { name: "x".repeat(9000), description: "too large", path: "/x", body: "body" };
  const actual = parseSkill("body", '/skills/a"quote.md');
  const text = skillsInjection([oversized, actual]);
  expect(text).toContain(`- ${actual.name}:`);
  const json = /First call for a covered task: skill\((.*?)\)\./.exec(text)![1]!;
  expect(skillTool([actual]).inputSchema.parse(JSON.parse(json))).toEqual({ name: actual.name });
  expect(skillsInjection([oversized])).not.toContain("First call");
  expect(Buffer.byteLength(skillsInjection([oversized]))).toBeLessThanOrEqual(8192);
  expect(skillsInjection([])).toBe("");
});
