import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, rename, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { pack, type Headers } from "tar-stream";
import { afterEach, expect, it } from "vitest";
import { addPackage, inspectPackages, readPackageArchive } from "../src/packages.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(name = "bundle") {
  const root = await mkdtemp(join(tmpdir(), "agentrig-package-")); roots.push(root);
  const source = join(root, "source"); const projectRoot = join(root, "project");
  await mkdir(source); await mkdir(projectRoot);
  await writeFile(join(source, "package.json"), JSON.stringify({ name, version: "1.0.0", agentrig: { apiVersion: 1 } }));
  await mkdir(join(source, "skills")); await writeFile(join(source, "skills", "guide.md"), "---\nname: guide\ndescription: A guide\n---\nDo the task carefully.");
  await mkdir(join(source, "prompts")); await writeFile(join(source, "prompts", "review.md"), "Inert prompt");
  return { root, source, projectRoot };
}
async function archive(entries: Array<{ header: Partial<Headers> & { name: string }; body?: string }>) {
  const stream = pack(); const chunks: Buffer[] = [];
  const collecting = (async () => { for await (const chunk of stream) chunks.push(Buffer.from(chunk)); })();
  for (const entry of entries) stream.entry(entry.header, entry.body ?? "");
  stream.finalize(); await collecting; return gzipSync(Buffer.concat(chunks));
}
const manifest = JSON.stringify({ name: "archive", version: "1", agentrig: { apiVersion: 1 } });

it("installs a complete immutable copy, lists inert prompts, verifies integrity and refuses overwrite", async () => {
  const f = await fixture(); const before = await readFile(join(f.source, "package.json"));
  const result = await addPackage(f);
  expect(result.prompts).toEqual(["prompts/review.md"]);
  expect(await readFile(join(f.source, "package.json"))).toEqual(before);
  const inspected = await inspectPackages(f.projectRoot);
  expect(inspected.errors).toEqual([]); expect(inspected.packages).toHaveLength(1);
  expect(inspected.packages[0]?.skills).toEqual([join(result.destination, "skills")]);
  // the digest the inspection just matched, handed on: callers that must pin a bundle byte for
  // byte have no other field that changes when a same-size body does
  expect(inspected.packages[0]?.digest).toBe(result.digest);
  await expect(addPackage(f)).rejects.toThrow(/already exists/);
  expect((await inspectPackages(f.projectRoot)).errors).toEqual([]);
  await writeFile(join(result.destination, "skills", "guide.md"), "human edit");
  expect((await inspectPackages(f.projectRoot)).packages).toEqual([]);
  expect((await inspectPackages(f.projectRoot)).errors.join()).toContain("integrity mismatch");
  expect(await readFile(join(result.destination, "skills", "guide.md"), "utf8")).toBe("human edit");
});

it("validates every selected manifest before any destination publication", async () => {
  const f = await fixture(); await mkdir(join(f.source, "extensions"));
  await writeFile(join(f.source, "extensions", "bad.mjs"), 'throw new Error("must never import")');
  await expect(addPackage(f)).rejects.toThrow(/sidecar/);
  await expect(readdir(join(f.projectRoot, ".agentrig"))).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(join(f.source, "extensions", "bad.json"), JSON.stringify({ name: "bad", version: "1", apiVersion: 1, surfaces: [] }));
  await writeFile(join(f.source, "skills", "guide.md"), "---\nallowed-tools: bash\n---\nno");
  await expect(addPackage(f)).rejects.toThrow(/allowed-tools/);
});

it.each(["skill.md", "Skill.md", "SKILL.MD", "sKiLl.Md"])("refuses nested marker %s before directory package publication", async marker => {
  const f = await fixture(); await mkdir(join(f.source, "skills", "nested"));
  await writeFile(join(f.source, "skills", "nested", marker), "---\nname: nested\n---\nNested content");
  await expect(addPackage(f)).rejects.toThrow("nested package skill filename must be exactly SKILL.md");
  await expect(readdir(join(f.projectRoot, ".agentrig"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(f.source, "skills", "nested", marker), "utf8")).toContain("Nested content");
});

it("refuses case-variant nested markers in archive installs before publication", async () => {
  const f = await fixture(); const source = join(f.root, "case.tgz");
  await writeFile(source, await archive([{ header: { name: "package/package.json" }, body: manifest },
    { header: { name: "package/skills/nested/skill.md" }, body: "Nested skill" }]));
  await expect(addPackage({ projectRoot: f.projectRoot, source })).rejects.toThrow("nested package skill filename must be exactly SKILL.md");
  await expect(readdir(join(f.projectRoot, ".agentrig"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("installed package inspection refuses a changed nested marker with the same explicit casing diagnostic", async () => {
  const f = await fixture(); await mkdir(join(f.source, "skills", "nested"));
  await writeFile(join(f.source, "skills", "nested", "SKILL.md"), "Nested content");
  const installed = await addPackage(f), directory = join(installed.destination, "skills", "nested");
  // Use an intermediate name so this exercises a real spelling change on case-insensitive hosts too.
  await rename(join(directory, "SKILL.md"), join(directory, "marker.tmp"));
  await rename(join(directory, "marker.tmp"), join(directory, "skill.md"));
  const result = await inspectPackages(f.projectRoot);
  expect(result.packages).toEqual([]);
  expect(result.errors.join()).toContain("nested package skill filename must be exactly SKILL.md");
  expect(await readFile(join(directory, "skill.md"), "utf8")).toBe("Nested content");
});

it("rejects all nonempty scripts and runtime dependency declarations without running them", async () => {
  const f = await fixture();
  for (const extra of [{ scripts: { arbitrary: "echo bad" } }, { dependencies: { bad: "1" } }, { optionalDependencies: { bad: "1" } }, { bin: "run.js" }]) {
    await writeFile(join(f.source, "package.json"), JSON.stringify({ name: "bad", version: "1", agentrig: { apiVersion: 1 }, ...extra }));
    await expect(addPackage(f)).rejects.toThrow();
    await expect(readdir(join(f.projectRoot, ".agentrig"))).rejects.toMatchObject({ code: "ENOENT" });
  }
});

it("accepts a bounded npm-root archive and logical PAX long names", async () => {
  const bytes = await archive([{ header: { name: "package/", type: "directory" } }, { header: { name: "package/package.json" }, body: manifest },
    { header: { name: `package/prompts/${"a".repeat(150)}.md` }, body: "inert" }]);
  const result = await readPackageArchive(bytes); expect(result.files).toHaveLength(2);
  const f = await fixture(); const source = join(f.root, "fixture.tgz"); await writeFile(source, bytes);
  expect((await addPackage({ projectRoot: f.projectRoot, source })).name).toBe("archive");
});

it.each(["package/../escape", "/package/escape", "package/a\\b", "package/C:escape", "other/file", "package/CON.txt", "package/ending."])("rejects unsafe final archive path %s", async name => {
  await expect(readPackageArchive(await archive([{ header: { name }, body: "x" }]))).rejects.toThrow();
});

it.each(["symlink", "link", "character-device", "block-device", "fifo"] as const)("rejects archive %s entries", async type => {
  await expect(readPackageArchive(await archive([{ header: { name: "package/evil", type, linkname: "outside" } }]))).rejects.toThrow(/type refused/);
});

it("rejects duplicate, case-alias, parent/file and surface-container collisions", async () => {
  for (const names of [["package/a", "package/a"], ["package/A", "package/a"], ["package/a", "package/a/b"], ["package/skills"]]) {
    await expect(readPackageArchive(await archive(names.map(name => ({ header: { name }, body: "x" }))))).rejects.toThrow(/conflicting|container/);
  }
});

it("enforces compressed, expanded and entry budgets and aborts without publishing", async () => {
  const bytes = await archive([{ header: { name: "package/package.json" }, body: manifest }, { header: { name: "package/prompts/bomb" }, body: "x".repeat(100000) }]);
  await expect(readPackageArchive(bytes, { limits: { compressed: 10 } })).rejects.toThrow(/compressed/);
  await expect(readPackageArchive(bytes, { limits: { bytes: 1024 } })).rejects.toThrow(/expanded/);
  const metadata = await archive([{ header: { name: "package/package.json", pax: { comment: "x".repeat(100000) } }, body: manifest }]);
  await expect(readPackageArchive(metadata, { limits: { bytes: 1024 } })).rejects.toThrow(/expanded/);
  await expect(readPackageArchive(bytes, { limits: { entries: 1 } })).rejects.toThrow(/entry limit/);
  await expect(readPackageArchive(bytes.subarray(0, bytes.length - 10))).rejects.toThrow();
  const f = await fixture(); const controller = new AbortController(); controller.abort();
  await expect(addPackage({ ...f, signal: controller.signal })).rejects.toThrow();
  await expect(readdir(join(f.projectRoot, ".agentrig"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("refuses directory hardlinks and in-scope symlink containers", async () => {
  const f = await fixture(); await link(join(f.source, "package.json"), join(f.source, "README"));
  await expect(addPackage(f)).rejects.toThrow(/non-regular|linked/);
  await rm(join(f.source, "README"));
  await mkdir(join(f.projectRoot, ".agentrig"));
  await symlink(f.source, join(f.projectRoot, ".agentrig", "packages"), process.platform === "win32" ? "junction" : "dir");
  await expect(addPackage(f)).rejects.toThrow(/real directory/);
});

it("serializes competing create-only installs without partial publication", async () => {
  const f = await fixture(); const results = await Promise.allSettled([addPackage(f), addPackage(f)]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  expect((await readdir(join(f.projectRoot, ".agentrig", "packages"))).filter(name => name.startsWith("."))).toEqual([]);
  expect((await inspectPackages(f.projectRoot)).packages).toHaveLength(1);
});

it("cancels during staging, removing only owned staging and lock while leaving source intact", async () => {
  const f = await fixture();
  for (let i = 0; i < 150; i++) await writeFile(join(f.source, "prompts", `${i}.md`), "content");
  const controller = new AbortController(); let sawStaging = false;
  const pending = addPackage({ ...f, signal: controller.signal });
  const outcome = pending.then(() => "published", () => "cancelled");
  for (let poll = 0; poll < 1000 && !sawStaging; poll++) {
    const names = await readdir(join(f.projectRoot, ".agentrig", "packages")).catch(() => [] as string[]);
    sawStaging = names.some(name => name.startsWith(".staging-"));
    if (sawStaging) controller.abort();
    else await new Promise(resolve => setTimeout(resolve, 1));
  }
  if (!sawStaging) controller.abort();
  expect(await outcome).toBe("cancelled");
  expect(sawStaging).toBe(true);
  expect(await readdir(join(f.projectRoot, ".agentrig", "packages"))).toEqual([]);
  expect(await readFile(join(f.source, "prompts", "149.md"), "utf8")).toBe("content");
});

it("does not expose an earlier verified package when the aggregate scan exhausts its cap", async () => {
  const f = await fixture("first");
  for (let i = 0; i < 1000; i++) await writeFile(join(f.source, "prompts", `${i}.md`), "x");
  await addPackage(f);
  await writeFile(join(f.source, "package.json"), JSON.stringify({ name: "second", version: "1", agentrig: { apiVersion: 1 } }));
  await addPackage(f);
  const result = await inspectPackages(f.projectRoot);
  expect(result.packages).toEqual([]); expect(result.errors.join()).toContain("aggregate");
}, 30_000);
