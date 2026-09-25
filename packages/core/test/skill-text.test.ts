import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readSkillText } from "../../../test/skill-text.js";

function incompleteDiagnostic(skill: string, root: string, pathJoin = join) {
  return `incomplete skills override: ${pathJoin(skill, "SKILL.md")} in ${root}`;
}
const owned: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "skill-text-"));
  owned.push(root);
  cpSync(new URL("../../../.agentrig/skills/", import.meta.url), root, { recursive: true });
  return root;
}

it("normalizes CRLF and lone CR skill text from the entire-tree override", () => {
  const root = fixture();
  writeFileSync(join(root, "dogfood", "SKILL.md"), "one\r\ntwo\rthree\n");
  vi.stubEnv("AGENTRIG_TEST_SKILLS_ROOT", root);
  expect(readSkillText(".agentrig/skills/dogfood/SKILL.md")).toBe("one\ntwo\nthree\n");
  expect(readSkillText(new URL("../../../.agentrig/skills/dogfood/SKILL.md", import.meta.url))).toBe("one\ntwo\nthree\n");
});

it("does not silently fall back to checkout skills when the override is incomplete", () => {
  const root = fixture();
  rmSync(join(root, "dogfood", "SKILL.md"));
  vi.stubEnv("AGENTRIG_TEST_SKILLS_ROOT", root);
  expect(() => readSkillText(".agentrig/skills/dogfood/SKILL.md")).toThrow(incompleteDiagnostic("dogfood", root));
});

it("keeps non-skill document bytes and paths unchanged", () => {
  const root = fixture();
  const path = join(root, "policy.md");
  writeFileSync(path, "one\r\ntwo\r\n");
  vi.stubEnv("AGENTRIG_TEST_SKILLS_ROOT", root);
  expect(readSkillText(path)).toBe("one\r\ntwo\r\n");
});

it.each(["", " ", "\t"])("rejects a present-empty proof root %j", value => {
  vi.stubEnv("AGENTRIG_TEST_SKILLS_ROOT", value);
  expect(() => readSkillText(".agentrig/skills/dogfood/SKILL.md")).toThrow(/empty/i);
});
it("rejects an incomplete tree even when the requested skill exists", () => {
  const root = fixture();
  rmSync(join(root, "topic"), { recursive: true });
  vi.stubEnv("AGENTRIG_TEST_SKILLS_ROOT", root);
  expect(() => readSkillText(".agentrig/skills/dogfood/SKILL.md")).toThrow(incompleteDiagnostic("topic", root));
});
it("preserves generated SKILL.md raw bytes including line-ending-only edits", () => {
  const path = join(fixture(), "SKILL.md");
  writeFileSync(path, "one\r\ntwo\r");
  expect(readSkillText(path)).toBe("one\r\ntwo\r");
});

it("M-posix-diagnostic: diagnostic assertions support Windows separators", () => {
  const diagnostic = `incomplete skills override: ${win32.join("dogfood", "SKILL.md")} in C:\\proof`;
  expect(() => { throw new Error(diagnostic); }).toThrow(incompleteDiagnostic("dogfood", "C:\\proof", win32.join));
});
