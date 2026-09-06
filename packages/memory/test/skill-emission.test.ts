import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { discoverSkills, parseSkill, parseSkillFrontmatter } from "@agentkitai/agentrig-core";
import { runDream, type FullDreamResult } from "@agentkitai/agentrig-memory";
import { skillFixture, skillProvider } from "./fixtures/skill-emission.ts";

const roots: string[] = []; const results: FullDreamResult[] = [];
afterEach(async () => {
  for (const result of results.splice(0)) await result.workspace.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(mode?: string) { const f = await skillFixture(mode); roots.push(f.root); return f; }
async function dream(f: Awaited<ReturnType<typeof fixture>>, apply?: string, fault?: string, extra: Record<string, unknown> = {}) {
  const result = await runDream({ ...f, provider: skillProvider(fault), limits: { maxCalls: 3 },
    emitSkills: { root: f.skills, ...(apply === undefined ? {} : { apply }) }, ...extra });
  results.push(result); return result;
}

it("real dream previews exact standard metadata, then fresh reviewed apply writes one unactivated skill and safely regenerates", async () => {
  const f = await fixture();
  const inputs = [join(f.wiki.root, "concepts/release.md"), join(f.root, "raw/sessions/s1.jsonl"), join(f.root, "raw/sessions/s2.jsonl")];
  const before = await Promise.all(inputs.map(path => readFile(path, "utf8")));
  const preview = await dream(f, undefined, undefined, { structuralOnly: true });
  expect(preview.auxiliary?.calls).toHaveLength(0);
  const proposal = preview.skillEmission!.proposals[0]!;
  expect(preview.skillEmission!.proposals).toHaveLength(1);
  expect(await readdir(f.skills).catch(() => [])).toEqual([]);
  const parsed = parseSkillFrontmatter(proposal.text);
  expect(parsed.fields.metadata).toMatchObject({ "agentrig-schema": "1", locked: "false" });
  expect(parseSkill(proposal.text, proposal.path).name).toBe(proposal.name);
  expect(() => parseSkill(proposal.text, join(f.skills, "wrong", "SKILL.md"))).toThrow(/directory/);
  const applied = await dream(f, preview.skillEmission!.digest);
  expect(applied.skillEmission!.status).toBe("applied"); expect(applied.auxiliary?.calls).toHaveLength(3);
  expect(applied.autoApply).toBeUndefined();
  expect(await readFile(proposal.path, "utf8")).toBe(applied.skillEmission!.proposals[0]!.text);
  expect(await discoverSkills({ roots: [join(f.root, "skills")] })).toEqual([]);
  expect(await discoverSkills({ roots: [f.skills] })).toHaveLength(1);
  const regenerated = await dream(f, preview.skillEmission!.digest);
  expect(regenerated.skillEmission!.written).toEqual([proposal.path]);
  expect(regenerated.skillEmission!.digest).toBe(preview.skillEmission!.digest);
  expect(await Promise.all(inputs.map(path => readFile(path, "utf8")))).toEqual(before);
});

it.each(["single", "fork", "copied"])("%s evidence cannot emit a procedure", async mode => {
  const f = await fixture(mode); const result = await dream(f);
  expect(result.skillEmission!.proposals).toEqual([]);
  expect((await dream(f, result.skillEmission!.digest)).skillEmission!.status).toBe("refused");
});

it.each(["unsafe", "rewrite", "nonrepeatable", "timeout"])("fresh %s review cannot reuse a previous digest as authorization", async fault => {
  const f = await fixture(); const preview = await dream(f, undefined, undefined, { structuralOnly: true });
  const applied = await dream(f, preview.skillEmission!.digest, fault, { limits: { maxCalls: 3, callTimeoutMs: 30 } });
  expect(applied.skillEmission!.status).toBe("refused"); expect(applied.skillEmission!.written).toEqual([]);
});

it("default shared two-call budget refuses emission without raising its ceiling", async () => {
  const f = await fixture(); const preview = await dream(f, undefined, undefined, { structuralOnly: true });
  const result = await dream(f, preview.skillEmission!.digest, undefined, { limits: {} });
  expect(result.auxiliary?.calls).toHaveLength(2); expect(result.skillEmission!.status).toBe("refused");
  expect(result.skillEmission!.reason).toContain("call limit");
});

it.each(["edited", "locked", "foreign", "directory", "occupied", "symlink"])("preserves %s destinations", async mode => {
  const f = await fixture(); const preview = await dream(f);
  const item = preview.skillEmission!.proposals[0]!;
  await mkdir(dirname(item.path), { recursive: true });
  let text = item.text;
  if (mode === "edited") text += "\nHuman note\n";
  if (mode === "locked") {
    text = text.replace('locked: "false"', 'locked: "true"');
    const unsigned = text.replace(/^  agentrig-content: "[a-f0-9]{64}"\n/m, "");
    text = text.replace(/agentrig-content: "[a-f0-9]{64}"/, `agentrig-content: "${createHash("sha256").update(unsigned).digest("hex")}"`);
  }
  if (mode === "foreign") text = "Human authored skill";
  if (mode === "directory") await mkdir(item.path);
  else if (mode === "symlink") {
    const target = join(f.root, "human.md"); await writeFile(target, "human");
    try { await symlink(target, item.path); } catch (error) { if (process.platform === "win32") return; throw error; }
  } else if (mode !== "occupied") await writeFile(item.path, text);
  const applied = await dream(f, preview.skillEmission!.digest);
  expect(applied.skillEmission!.status).toBe("refused"); expect(applied.skillEmission!.preserved).toHaveLength(1);
  expect(applied.skillEmission!.written).toEqual([]);
  if (!["directory", "symlink", "occupied"].includes(mode)) expect(await readFile(item.path, "utf8")).toBe(text);
});

it("rejects changed digest/destination, structural apply, cancellation and bounded scans", async () => {
  const f = await fixture(); const preview = await dream(f);
  expect((await dream(f, "0".repeat(64))).skillEmission!.status).toBe("refused");
  await expect(dream(f, undefined, undefined, { emitSkills: { root: join(f.root, "different"), apply: preview.skillEmission!.digest } })).rejects.toThrow(/approved memory/);
  await expect(dream(f, preview.skillEmission!.digest, undefined, { structuralOnly: true })).rejects.toThrow(/structural/);
  await expect(dream(f, preview.skillEmission!.digest, undefined, { autoApply: true })).rejects.toThrow(/auto/);
  const controller = new AbortController();
  await expect(dream(f, preview.skillEmission!.digest, undefined, { signal: controller.signal,
    onPhase: (phase: string) => { if (phase === "skill-emission") controller.abort(); } })).rejects.toThrow();
  await expect(dream(f, preview.skillEmission!.digest, undefined, { scanLimits: { maxFileBytes: 32 } })).rejects.toThrow();
  expect(await readdir(f.skills).catch(() => [])).toEqual([]);
});

it("cannot publish with a serialized reviewed report or missing fresh provider", async () => {
  const f = await fixture(); const preview = await dream(f);
  const fabricated = JSON.parse(JSON.stringify(preview.report));
  expect(fabricated.procedures.candidates[0].status).toBe("model-and-effect-reviewed");
  const refused = await dream(f, preview.skillEmission!.digest, undefined, { provider: undefined, report: fabricated });
  expect(refused.skillEmission!.status).toBe("refused"); expect(refused.skillEmission!.reason).toContain("fresh model/effect");
  expect(refused.skillEmission!.written).toEqual([]);
});

it("reloads raw witnesses after preview and respects stricter configured evidence counts", async () => {
  const f = await fixture(); const preview = await dream(f);
  expect((await dream(f, undefined, undefined, { minSessionsToPromote: 3 })).skillEmission!.proposals).toEqual([]);
  // Negative fixture only: simulate evidence changing outside the immutable-store contract.
  const path = join(f.root, "raw/sessions/s2.jsonl");
  await writeFile(path, (await readFile(path, "utf8")).replace("Inspect the changed files", "Unrelated observation"));
  const refused = await dream(f, preview.skillEmission!.digest);
  expect(refused.skillEmission!.status).toBe("refused"); expect(refused.skillEmission!.written).toEqual([]);
});

it("fails closed for unsupported, duplicate, malformed or oversized nested skill metadata", async () => {
  const f = await fixture(); const preview = await dream(f, undefined, undefined, { structuralOnly: true });
  const item = preview.skillEmission!.proposals[0]!;
  for (const text of [item.text.replace('locked: "false"', "locked: false"),
    item.text.replace('locked: "false"', 'permissions: "all"'),
    item.text.replace('locked: "false"', 'locked: "false"\n  locked: "true"'),
    item.text.replace('agentrig-schema: "1"', 'agentrig-schema: "2"'),
    item.text.replace("metadata:\n", "allowed-tools: bash\nmetadata:\n"),
    item.text.replace("metadata:\n", `metadata:\n${" ".repeat(20000)}`),
    item.text.replace(/\n---\n/, "\n")]) expect(() => parseSkill(text, item.path)).toThrow();
});

it.each(["root", "directory"])("rejects a symlink escape at the generated %s", async mode => {
  const f = await fixture(); const preview = await dream(f, undefined, undefined, { structuralOnly: true });
  const outside = join(f.root, "human-directory"); await mkdir(outside);
  await mkdir(join(f.root, "skills"));
  const link = mode === "root" ? f.skills : dirname(preview.skillEmission!.proposals[0]!.path);
  if (mode === "directory") await mkdir(f.skills);
  try { await symlink(outside, link, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (process.platform === "win32") return; throw error; }
  if (mode === "root") await expect(dream(f, preview.skillEmission!.digest)).rejects.toThrow(/unlinked directory/);
  else expect((await dream(f, preview.skillEmission!.digest)).skillEmission!.status).toBe("refused");
  expect(await readdir(outside)).toEqual([]);
});

it("canonicalizes an explicitly chosen memory-root alias, without rejecting OS temp aliases", async () => {
  const f = await fixture();
  const memory = join(f.root, "memory"); await mkdir(memory);
  try { await symlink(f.root, join(memory, "alias"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (process.platform === "win32") return; throw error; }
  // Same trusted selected memory root via an alias, not a symlink inside skills/generated.
  const { FileMemoryStore } = await import("@agentkitai/agentrig-memory");
  const chosen = join(memory, "alias");
  const preview = await dream(f, undefined, undefined, { wiki: new FileMemoryStore({ root: join(chosen, "wiki") }),
    emitSkills: { root: join(chosen, "skills/generated") }, structuralOnly: true });
  expect(preview.skillEmission!.proposals[0]!.path).toContain(f.skills);
  const applied = await dream(f, preview.skillEmission!.digest);
  expect(applied.skillEmission!.status).toBe("applied");
});
