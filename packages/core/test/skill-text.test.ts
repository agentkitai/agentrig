import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readSkillText } from "../../../test/skill-text.js";

// Simulate native Windows diagnostics while mapping filesystem lookups back to
// the host separator, so missing-file failures identify the intended file.
const pathStyle = vi.hoisted(() => ({ windows: false }));
vi.mock("node:path", async importOriginal => {
  const actual = await importOriginal<typeof import("node:path")>();
  return {
    ...actual,
    resolve: (...args: string[]) => actual.resolve(...args.map(arg =>
      pathStyle.windows ? arg.replaceAll("\\", "/") : arg)),
    relative: (...args: Parameters<typeof actual.relative>) => {
      const path = actual.relative(...args);
      return pathStyle.windows ? path.replaceAll("/", "\\") : path;
    },
  };
});
const owned: string[] = [];
afterEach(() => {
  pathStyle.windows = false;
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

it.each([false, true])("does not silently fall back with Windows-style relative paths=%s", windows => {
  pathStyle.windows = windows;
  const root = fixture();
  rmSync(join(root, "dogfood", "SKILL.md"));
  vi.stubEnv("AGENTRIG_TEST_SKILLS_ROOT", root);
  expect(() => readSkillText(".agentrig/skills/dogfood/SKILL.md")).toThrow(`incomplete skills override: ${["dogfood", "SKILL.md"].join(windows ? "\\" : sep)} in ${root}`);
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
it.each([false, true])("rejects incomplete tree with Windows-style relative paths=%s", windows => {
  pathStyle.windows = windows;
  const root = fixture();
  rmSync(join(root, "topic"), { recursive: true });
  vi.stubEnv("AGENTRIG_TEST_SKILLS_ROOT", root);
  expect(() => readSkillText(".agentrig/skills/dogfood/SKILL.md")).toThrow(`incomplete skills override: ${["topic", "SKILL.md"].join(windows ? "\\" : sep)} in ${root}`);
});
it("preserves generated SKILL.md raw bytes including line-ending-only edits", () => {
  const path = join(fixture(), "SKILL.md");
  writeFileSync(path, "one\r\ntwo\r");
  expect(readSkillText(path)).toBe("one\r\ntwo\r");
});
