import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { discoverSkills, parseSkill, SkillCatalog, skillTool } from "@agentkitai/agentrig-core";
import type { ToolContext } from "@agentkitai/agentrig-core";

let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "skill-bundles-"))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function file(path: string, body: string) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), body);
}
const manifest = (fields: string, body = "OWN") => `---\nname: pack\ndescription: bundle\n${fields}\n---\n${body}`;
async function discover() {
  const errors: Error[] = [];
  const skills = await discoverSkills({ roots: [root], onError: e => errors.push(e) });
  return { skills, errors };
}

it("resolves nested includes in declaration order and exposes inert asset paths identically to the loader", async () => {
  await file("pack/SKILL.md", manifest('includes: ["parts/b.md", "parts/a.md"]\nassets: ["assets/check.sh"]\nflags: ["fresh-session"]'));
  await file("pack/parts/b.md", '---\nincludes: ["parts/c.md"]\n---\nB');
  await file("pack/parts/a.md", "A");
  await file("pack/parts/c.md", "C");
  await file("pack/assets/check.sh", "exit 42");
  const { skills, errors } = await discover();
  expect(errors).toEqual([]);
  expect(skills).toHaveLength(1);
  expect(skills[0]!.body).toBe(`C\n\nB\n\nA\n\nOWN\n\n## Bundled assets (paths only; not executed)\n- ${JSON.stringify(join(root, "pack/assets/check.sh"))}`);
  expect(skills[0]!.flags).toEqual(["fresh-session"]);
  expect(skills[0]!.assets).toEqual([join(root, "pack/assets/check.sh")]);
  const loaded = await skillTool(skills).execute({ name: "pack" }, { emit: () => {} } as unknown as ToolContext);
  expect(loaded.display).toBe(skills[0]!.body);
});

it.each(["includes", "assets", "flags"])("accepts empty opt-in %s without changing the legacy body", async key => {
  await file("pack/SKILL.md", manifest(`${key}: []`, "  body  "));
  expect((await discover()).skills[0]!.body).toBe("body");
});

it.each([
  'includes: ["../outside.md"]', 'includes: ["/tmp/a.md"]', 'includes: ["a/../b.md"]',
  'includes: ["a\\\\b.md"]', 'includes: ["C:/a.md"]', 'includes: ["a.md", "a.md"]',
  'includes: [12]', 'includes: "a.md"', 'includes: ["a.md"] # yaml comment',
  'assets: ["../outside"]', 'assets: ["a", "a"]', 'flags: ["merge"]',
  'flags: ["fresh-session", "fresh-session"]', 'flags: true',
])("rejects invalid bundle metadata: %s", fields => {
  expect(() => parseSkill(manifest(fields), "/skills/pack/SKILL.md")).toThrow();
});

it.each(["missing", "missing-asset", "cycle", "symlink-include", "symlink-parent", "symlink-asset", "directory", "fragment-flags"])("rejects the whole skill with a diagnostic: %s", async mode => {
  await file("pack/SKILL.md", manifest('includes: ["parts/a.md"]'));
  await file("pack/parts/a.md", "A");
  if (mode === "missing-asset") await file("pack/SKILL.md", manifest('assets: ["missing.txt"]'));
  if (mode === "missing") await rm(join(root, "pack/parts/a.md"));
  if (mode === "cycle") await file("pack/parts/a.md", '---\nincludes: ["SKILL.md"]\n---\nA');
  if (mode === "symlink-include") {
    await rm(join(root, "pack/parts/a.md")); await file("outside.md", "OUTSIDE");
    await symlink(join(root, "outside.md"), join(root, "pack/parts/a.md"));
  }
  if (mode === "symlink-parent") {
    await rm(join(root, "pack/parts"), { recursive: true }); await file("elsewhere/a.md", "OUTSIDE");
    await symlink(join(root, "elsewhere"), join(root, "pack/parts"), "dir");
  }
  if (mode === "symlink-asset") {
    await file("pack/SKILL.md", manifest('assets: ["asset"]')); await file("outside.txt", "OUTSIDE");
    await symlink(join(root, "outside.txt"), join(root, "pack/asset"));
  }
  if (mode === "directory") { await rm(join(root, "pack/parts/a.md")); await mkdir(join(root, "pack/parts/a.md")); }
  if (mode === "fragment-flags") await file("pack/parts/a.md", '---\nflags: ["fresh-session"]\n---\nA');
  const { skills, errors } = await discover();
  expect(skills.find(s => s.name === "pack")).toBeUndefined();
  expect(errors.map(e => e.message).join("\n")).toMatch(/skill .*pack.*(include|asset|bundle)/i);
  if (mode === "cycle") expect(errors[0]!.message).toContain("cyclic include");
});

it("bounds expanded bytes even when every individual include fits", async () => {
  await file("pack/SKILL.md", manifest('includes: ["a.md", "b.md"]'));
  await file("pack/a.md", "a".repeat(160_000)); await file("pack/b.md", "b".repeat(160_000));
  const { skills, errors } = await discover();
  expect(skills).toEqual([]); expect(errors[0]!.message).toMatch(/limit|budget/);
});

it("refresh detects flag changes and included bodies while old generations stay unchanged", async () => {
  await file("pack/SKILL.md", manifest('includes: ["parts/a.md"]'));
  await file("pack/parts/a.md", "OLD");
  const catalog = new SkillCatalog((await discover()).skills);
  const old = catalog.current();
  await file("pack/SKILL.md", manifest('includes: ["parts/a.md"]\nflags: ["fresh-session"]'));
  expect(catalog.replace((await discover()).skills).updated).toEqual(["pack"]);
  expect(old.skills[0]!.flags).toBeUndefined();
  await file("pack/parts/a.md", "NEW");
  expect(catalog.replace((await discover()).skills).updated).toEqual(["pack"]);
  expect(old.skills[0]!.body).toBe("OLD\n\nOWN");
  expect(catalog.current().skills[0]!.body).toBe("NEW\n\nOWN");
});

it("accepts CRLF frontmatter and normalizes composed include text", async () => {
  await file("pack/SKILL.md", manifest('includes: ["parts/a.md"]\nflags: ["fresh-session"]').replace(/\n/g, "\r\n"));
  await file("pack/parts/a.md", "FIRST\r\nSECOND\r\n");
  const { skills, errors } = await discover();
  expect(errors).toEqual([]); expect(skills[0]!.body).toBe("FIRST\nSECOND\n\nOWN");
});

it("bounds recursive depth and repeated DAG expansion count without forbidding a small diamond", async () => {
  await file("pack/SKILL.md", manifest('includes: ["parts/a.md", "parts/b.md"]'));
  await file("pack/parts/a.md", '---\nincludes: ["parts/c.md"]\n---\nA');
  await file("pack/parts/b.md", '---\nincludes: ["parts/c.md"]\n---\nB');
  await file("pack/parts/c.md", "C");
  expect((await discover()).skills[0]!.body).toBe("C\n\nA\n\nC\n\nB\n\nOWN");
  // A linear chain reaches the independent depth bound.
  for (let i = 0; i < 18; i++) await file(`pack/parts/d${i}.md`, i === 17 ? "END" : `---\nincludes: ["parts/d${i + 1}.md"]\n---\nD`);
  await file("pack/SKILL.md", manifest('includes: ["parts/d0.md"]'));
  expect((await discover()).errors[0]!.message).toContain("depth/count limit");
  // 32 unique first-level references each include two common leaves: no cycles, but >64 visits.
  const names = Array.from({ length: 32 }, (_, i) => `parts/n${i}.md`);
  for (const name of names) await file(`pack/${name}`, '---\nincludes: ["parts/b.md", "parts/c.md"]\n---\nN');
  await file("pack/SKILL.md", manifest(`includes: ${JSON.stringify(names)}`));
  expect((await discover()).errors[0]!.message).toContain("depth/count limit");
});

it("charges includes against the whole-root scan budget, never returning a checked prefix", async () => {
  for (let i = 0; i < 40; i++) {
    await file(`p${i}/SKILL.md`, `---\nname: p${i}\nincludes: ["large.md"]\n---\nOWN`);
    await file(`p${i}/large.md`, "x".repeat(220_000));
  }
  const { skills, errors } = await discover();
  expect(skills).toEqual([]);
  expect(errors.at(-1)!.message).toContain("8 MiB scan budget");
});
