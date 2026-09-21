import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
const skill = (name: string) => readFile(new URL(`../../../.agentrig/skills/${name}/SKILL.md`, import.meta.url), "utf8");
it.each(["topic","ship","review","dogfood","land"])("%s delegates reviewer launches to declared adapters", async name => {
  const text = await skill(name);
  expect(text).toContain("scripts/reviewer-adapter.mjs");
  expect(text).not.toMatch(/claude|codex|anthropic|openai/i);
});
it("adapter owns CLI launch details, model assertions, and fail-closed output handling", async () => {
  const text = await readFile(new URL("../../../scripts/reviewer-adapter.mjs", import.meta.url),"utf8");
  expect(text).toContain('slot.adapter === "claude-cli"');
  expect(text).toContain('slot.adapter === "codex-cli"');
  expect(text).toContain("modelUsage");
  expect(text).toContain("stderr model banner");
  expect(text).toContain("review adapter produced an empty review");
  expect(text).toContain("review adapter failed");
});
it("reviewer receives conductor receipts and cannot substitute project checks", async () => {
  const text=(await skill("review")).replace(/\s+/g," ");
  expect(text).toContain("Give those receipts to every reviewer as inputs");
  expect(text).toContain("never rerun project checks");
  expect(text).toContain("reviewer-owned probe or named mutant");
});
it("count-specific focused review assignment is explicit", async () => {
  const text=(await skill("topic")).replace(/\s+/g," ");
  expect(text).toContain("With one slot, that slot supplies the full review and every later focused-delta review");
  expect(text).toContain("With two, both slots supply initial full reviews");
});
