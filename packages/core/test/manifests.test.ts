import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverSkills, parseSkill, skillsInjection, skillTool,
  ExtensionManifestV1, PackageManifestV1, SkillFrontmatterV1,
  resolveManifestNames, validateExtensionSurfaces,
} from "@agentkitai/agentrig-core";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function root(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), "agentrig-manifests-")); dirs.push(dir); return dir; }
const validExtension = { name: "example", version: "1.0.0", apiVersion: 1, surfaces: ["tools"] };
const validPackage = { name: "@example/pack", version: "1.0.0", agentrig: { apiVersion: 1 } };

describe("versioned manifest boundaries", () => {
  it("accepts v1 and rejects missing/unknown versions before an extension may import", () => {
    expect(ExtensionManifestV1.parse(validExtension)).toEqual(validExtension);
    for (const apiVersion of [undefined, "1", 0, 2, null]) {
      expect(ExtensionManifestV1.safeParse({ ...validExtension, apiVersion }).success).toBe(false);
    }
    for (const extra of [{ permissions: "*" }, { credentials: true }, { surfaces: ["network"] }, { surfaces: ["tools", "tools"] }]) {
      expect(ExtensionManifestV1.safeParse({ ...validExtension, ...extra }).success).toBe(false);
    }
  });
  it("refuses registration outside declared surfaces", () => {
    expect(validateExtensionSurfaces(validExtension, ["tools"])).toEqual(validExtension);
    expect(() => validateExtensionSurfaces(validExtension, ["hooks"])).toThrow("undeclared surface hooks");
  });
  it("allows npm metadata, but not unknown AgentRig authority or unsupported installation behavior", () => {
    expect(PackageManifestV1.parse({ ...validPackage, license: "MIT", private: true }).license).toBe("MIT");
    for (const extra of [
      { agentrig: { apiVersion: 2 } }, { agentrig: { apiVersion: 1, permissions: "*" } },
      { agentrig: undefined }, { scripts: { postinstall: "do something" } },
      { scripts: { preprepare: "do something" } }, { scripts: { postprepare: "do something" } },
      { scripts: { dependencies: "do something" } }, { scripts: { test: "do something" } },
      { dependencies: { x: "*" } }, { optionalDependencies: { x: "*" } }, { bin: "index.js" },
      { name: "../escape" }, { name: "@scope/../escape" },
      { permissions: "*" }, { "allowed-tools": "bash" }, { unexpectedAuthority: true },
    ]) expect(PackageManifestV1.safeParse({ ...validPackage, ...extra }).success).toBe(false);
  });
  it("retains only explicitly supported opaque npm metadata, with no execution authority", () => {
    const metadata = { repository: { type: "git", url: "https://example.test/repo" }, exports: { ".": "./index.js" } };
    expect(PackageManifestV1.parse({ ...validPackage, ...metadata })).toMatchObject(metadata);
  });
  it("rejects non-string skill metadata and unknown future authority", () => {
    expect(SkillFrontmatterV1.safeParse({ name: 42 }).success).toBe(false);
    expect(SkillFrontmatterV1.safeParse({ schema: "2" }).success).toBe(false);
    expect(SkillFrontmatterV1.safeParse({ schema: "1", locked: "true" }).success).toBe(false);
  });
});

describe("real skill loading fails closed", () => {
  const malformed = [
    "---\nallowed-tools: bash\n---\nUNSAFE BODY", "---\npermissions: all\n---\nUNSAFE BODY",
    "---\nname: x\nname: y\n---\nUNSAFE BODY", "---\nname: x\nUNSAFE BODY",
    "---\nmetadata:\n  permissions: all\n---\nUNSAFE BODY", "---\nname: [x]\n---\nUNSAFE BODY",
    "---\nname: \"unterminated\n---\nUNSAFE BODY", "---\nschema: 2\n---\nUNSAFE BODY",
    "---\nname:\n---\nUNSAFE BODY", "---\ndescription: |\ntext\n---\nUNSAFE BODY",
    "\uFEFF---\nallowed-tools: bash\n---\nUNSAFE BODY", "---\n<<: *defaults\n---\nUNSAFE BODY",
    "--- \nallowed-tools: bash\n---\nUNSAFE BODY", "---\nname: null\n---\nUNSAFE BODY",
    "---\nname: true\n---\nUNSAFE BODY",
  ];
  it.each(malformed)("refuses malformed/unsupported unit %j", async (text) => {
    const dir = await root();
    await writeFile(join(dir, "bad.md"), text);
    const errors: string[] = [];
    const loaded = await discoverSkills({ roots: [dir], onError: (error) => errors.push(error.message) });
    expect(loaded).toEqual([]);
    expect(skillsInjection(loaded)).not.toContain("UNSAFE BODY");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(join(dir, "bad.md"));
    const result = await skillTool(loaded).execute({ name: "bad" }, { cwd: dir, sessionId: "test", signal: new AbortController().signal, emit: () => {} });
    expect(result.isError).toBe(true);
    expect(result.display).not.toContain("UNSAFE BODY");
  });
  it("preserves legacy text and valid flat metadata, including an EOF closing fence", () => {
    expect(parseSkill("# Existing instructions", "/a/legacy.md").name).toBe("legacy");
    const skill = parseSkill("---\r\nschema: '1'\r\nname: safe\r\ndescription: \"safe prose\"\r\nlicense: MIT\r\nversion: 1.0.0\r\ncompatibility: Node\r\n---", "/a/safe.md");
    expect(skill).toMatchObject({ name: "safe", description: "safe prose", body: "" });
  });
  it("finds late duplicate after maxSkills, refuses both, and never falls back to a lower root", async () => {
    const high = await root(); const low = await root();
    await writeFile(join(high, "a.md"), "---\nname: Deploy\n---\nFIRST");
    await writeFile(join(high, "b.md"), "---\nname: useful\n---\nGOOD");
    await mkdir(join(high, "z"));
    await writeFile(join(high, "z", "SKILL.md"), "---\nname: deploy\n---\nSECOND");
    await writeFile(join(low, "deploy.md"), "LOWER BODY");
    const errors: string[] = [];
    const loaded = await discoverSkills({ roots: [high, low], maxSkills: 1, onError: (error) => errors.push(error.message) });
    expect(loaded.map((skill) => skill.name)).toEqual(["useful"]);
    expect(errors.join("\n")).toContain("equal precedence");
    expect(errors.join("\n")).toContain("ambiguous higher precedence");
  });
  it("deduplicates repeated roots, and sanitization collisions also refuse", async () => {
    const dir = await root();
    await writeFile(join(dir, "a.md"), "---\nname: x\n---\nbody");
    expect(await discoverSkills({ roots: [dir, dir] })).toHaveLength(1);
    await writeFile(join(dir, "b.md"), "---\nname: x\u200B\n---\nbody");
    expect(await discoverSkills({ roots: [dir] })).toEqual([]);
  });
  it("refuses an over-budget root instead of accepting an unchecked prefix", async () => {
    const dir = await root();
    await Promise.all(Array.from({ length: 34 }, (_, i) => writeFile(join(dir, `${i}.md`), "x".repeat(256 * 1024))));
    const errors: string[] = [];
    expect(await discoverSkills({ roots: [dir], maxSkills: 1, onError: (error) => errors.push(error.message) })).toEqual([]);
    expect(errors[0]).toContain("scan budget");
  });
});

it("resolves extension/package names independently of enumeration order", () => {
  const candidates = [
    { name: "pack", path: "/b/pack", precedence: 1 },
    { name: "PACK", path: "/a/pack", precedence: 1 },
    { name: "safe", path: "/user/safe", precedence: 2 },
    { name: "safe", path: "/explicit/safe", precedence: 0 },
  ];
  expect(resolveManifestNames(candidates)).toEqual([candidates[3]]);
  expect(resolveManifestNames([...candidates].reverse())).toEqual([candidates[3]]);
});
