import { readFileSync } from "node:fs";
import { cp, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { discoverSkills, parseSkill, skillTool } from "@agentkitai/agentrig-core";
import type { ToolContext } from "@agentkitai/agentrig-core";
import { readSkillText } from "../../../test/skill-text.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const names = ["arbiter", "dogfood", "land", "review", "ship", "topic"];
const owned: string[] = [];
afterEach(async () => { await Promise.all(owned.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture(crlf: boolean) {
  const root = await mkdtemp(join(tmpdir(), "ship-skills-"));
  owned.push(root);
  await cp(join(repo, "packs/ship/skills"), root, { recursive: true });
  for (const path of await readdir(root, { recursive: true })) {
    if (!path.endsWith(".md")) continue;
    const file = join(root, path);
    const lf = readSkillText(file).replace(/\r\n/g, "\n");
    await writeFile(file, crlf ? lf.replace(/\n/g, "\r\n") : lf);
  }
  return root;
}

it.each([false, true])("preserves all six resolved skill bodies and metadata byte-for-byte (CRLF=%s)", async crlf => {
  const root = await fixture(crlf);
  const errors: Error[] = [];
  const skills = await discoverSkills({ roots: [root], onError: error => errors.push(error) });
  expect(errors).toEqual([]);
  expect(skills.map(skill => skill.name)).toEqual(names);
  for (const skill of skills) {
    const path = join(repo, ".agentrig/skills", skill.name, "SKILL.md");
    const lf = readSkillText(path);
    // The old entry is parsed by the same production parser, not a test composer.
    const legacy = parseSkill(crlf ? lf.replace(/\n/g, "\r\n") : lf, path);
    expect(Buffer.from(skill.body), skill.name).toEqual(Buffer.from(legacy.body));
    expect(skill.description, skill.name).toBe(legacy.description);
    expect(skill.flags).toEqual(skill.name === "topic" ? ["fresh-session"] : undefined);
    expect(legacy.flags).toEqual(skill.flags);
    expect(skill.assets).toBeUndefined();
    expect(skill.includes?.length).toBeGreaterThan(0);
    const loaded = await skillTool(skills).execute({ name: skill.name }, { emit: () => {} } as unknown as ToolContext);
    expect(loaded.display).toBe(legacy.body);
  }
});

it("inventories the six skills and byte-identical shipping policy while preserving compatibility entry points", () => {
  const manifest = JSON.parse(readSkillText(join(repo, "packs/ship/pack.json"))) as { skills: string[]; docs: string[] };
  expect(manifest.skills).toEqual(names.map(name => `skills/${name}.md`));
  expect(manifest.docs).toContain("docs/SHIPPING-WORKFLOW.md");
  expect(readFileSync(join(repo, "packs/ship/docs/SHIPPING-WORKFLOW.md")))
    .toEqual(readFileSync(join(repo, "docs/SHIPPING-WORKFLOW.md")));
});

it("shares each extracted contract between multiple entries without making fragments discoverable skills", async () => {
  const root = await fixture(false);
  const uses = new Map<string, Set<string>>();
  for (const name of names) {
    const skill = parseSkill(readSkillText(join(root, `${name}.md`)), join(root, `${name}.md`));
    for (const ref of skill.includes ?? []) {
      if (!ref.startsWith("shared/")) continue;
      if (!uses.has(ref)) uses.set(ref, new Set());
      uses.get(ref)!.add(name);
    }
  }
  for (const family of ["initial-review", "declared-checks", "trusted-provenance", "scratch-cleanup"]) {
    const refs = [...uses].filter(([ref]) => ref.startsWith(`shared/${family}-`));
    expect(refs.length, family).toBeGreaterThan(0);
    for (const [ref, entries] of refs) expect(entries.size, ref).toBeGreaterThan(1);
  }
  // A pack-only installation has no repository compatibility tree to fall back to.
  expect((await discoverSkills({ roots: [root] })).map(skill => skill.name)).toEqual(names);
});

it("repository shipping config is pack-owned with identical check commands", () => {
  const config = JSON.parse(readFileSync(new URL("../../../.agentrig/config.json", import.meta.url), "utf8"));
  expect(config).not.toHaveProperty("reviewers");
  expect(config).not.toHaveProperty("checks");
  expect(config.packs.ship.checks).toEqual({ bootstrap: "pnpm install --frozen-lockfile", preflight: "pnpm test:preflight", steps: [
    { name: "build", command: "pnpm build" },
    { name: "test", command: "pnpm test", countsParser: "vitest", testTimeout: 15000 },
    { name: "typecheck", command: "pnpm typecheck" },
  ] });
  expect(config.packs.ship.reviewers).toEqual({ "Claude Code": { adapter: "claude-cli", model: "claude-opus-5" }, "Codex": { adapter: "codex-cli", model: "gpt-5.6-sol" } });
});
