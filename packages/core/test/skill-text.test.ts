import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readSkillText } from "../../../test/skill-text.js";

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
  expect(() => readSkillText(".agentrig/skills/dogfood/SKILL.md")).toThrow(`incomplete skills override: ${join("dogfood", "SKILL.md")} in ${root}`);
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
  expect(() => readSkillText(".agentrig/skills/dogfood/SKILL.md")).toThrow(`incomplete skills override: ${join("topic", "SKILL.md")} in ${root}`);
});
it("preserves generated SKILL.md raw bytes including line-ending-only edits", () => {
  const path = join(fixture(), "SKILL.md");
  writeFileSync(path, "one\r\ntwo\r");
  expect(readSkillText(path)).toBe("one\r\ntwo\r");
});

it("#450 emits a simulated Windows incomplete-override diagnostic from the actual reader", () => {
  const root = fixture();
  rmSync(join(root, "dogfood", "SKILL.md"));
  vi.stubEnv("AGENTRIG_TEST_SKILLS_ROOT", root);
  // Keep filesystem access on this host while exercising the Windows relative-path
  // diagnostic emitted by the reader itself.
  const windowsPaths = { resolve: (...parts: string[]) => resolve(...parts.map(part => part.replaceAll("\\", "/"))), relative: win32.relative, isAbsolute: win32.isAbsolute };
  expect(() => readSkillText(".agentrig/skills/dogfood/SKILL.md", "utf8", windowsPaths)).toThrow(`incomplete skills override: ${win32.join("dogfood", "SKILL.md")} in ${root}`);
});
