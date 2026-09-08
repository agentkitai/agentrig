import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, rename, symlink, link, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { pack, type Headers } from "tar-stream";
import { afterEach, beforeEach, expect, it } from "vitest";
import { addPackage, inspectPackages, packageDirectoryName, readPackageArchive, PACKAGE_LIMITS } from "../src/packages.ts";

const roots: string[] = [];
/**
 * An install publishes through a staging directory inside the fixture, so one that has not
 * finished is still writing after the body it belongs to has stopped. Teardown used to remove the
 * fixture out from under live staging and report `ENOTEMPTY` in place of whatever actually went
 * wrong. Every install a test starts is owned here instead: `settleOwned` cancels the fixture's
 * lifetime and joins the work, and only then is anything removed.
 */
const owned = new Set<Promise<unknown>>();
let lifetime = new AbortController();
function add(options: Parameters<typeof addPackage>[0]) {
  const work = addPackage({ signal: lifetime.signal, ...options });
  const settled = work.then(() => undefined, () => undefined);
  owned.add(settled); void settled.finally(() => owned.delete(settled));
  return work;
}
async function settleOwned() {
  lifetime.abort(new Error("package fixture teardown"));
  while (owned.size > 0) await Promise.all([...owned]);
}
/** Waits for a real staging directory to exist, so cancellation lands mid-publication. */
async function untilStaging(projectRoot: string) {
  for (let poll = 0; poll < 1000; poll++) {
    const names = await readdir(join(projectRoot, ".agentrig", "packages")).catch(() => [] as string[]);
    if (names.some(name => name.startsWith(".staging-"))) return true;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  return false;
}
beforeEach(() => { lifetime = new AbortController(); });
afterEach(async () => {
  await settleOwned();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
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
  const result = await add(f);
  expect(result.prompts).toEqual(["prompts/review.md"]);
  expect(await readFile(join(f.source, "package.json"))).toEqual(before);
  const inspected = await inspectPackages(f.projectRoot);
  expect(inspected.errors).toEqual([]); expect(inspected.packages).toHaveLength(1);
  expect(inspected.packages[0]?.skills).toEqual([join(result.destination, "skills")]);
  // the digest the inspection just matched, handed on: callers that must pin a bundle byte for
  // byte have no other field that changes when a same-size body does
  expect(inspected.packages[0]?.digest).toBe(result.digest);
  await expect(add(f)).rejects.toThrow(/already exists/);
  expect((await inspectPackages(f.projectRoot)).errors).toEqual([]);
  await writeFile(join(result.destination, "skills", "guide.md"), "human edit");
  expect((await inspectPackages(f.projectRoot)).packages).toEqual([]);
  expect((await inspectPackages(f.projectRoot)).errors.join()).toContain("integrity mismatch");
  expect(await readFile(join(result.destination, "skills", "guide.md"), "utf8")).toBe("human edit");
});

it("validates every selected manifest before any destination publication", async () => {
  const f = await fixture(); await mkdir(join(f.source, "extensions"));
  await writeFile(join(f.source, "extensions", "bad.mjs"), 'throw new Error("must never import")');
  await expect(add(f)).rejects.toThrow(/sidecar/);
  await expect(readdir(join(f.projectRoot, ".agentrig"))).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(join(f.source, "extensions", "bad.json"), JSON.stringify({ name: "bad", version: "1", apiVersion: 1, surfaces: [] }));
  await writeFile(join(f.source, "skills", "guide.md"), "---\nallowed-tools: bash\n---\nno");
  await expect(add(f)).rejects.toThrow(/allowed-tools/);
});

it.each(["skill.md", "Skill.md", "SKILL.MD", "sKiLl.Md"])("refuses nested marker %s before directory package publication", async marker => {
  const f = await fixture(); await mkdir(join(f.source, "skills", "nested"));
  await writeFile(join(f.source, "skills", "nested", marker), "---\nname: nested\n---\nNested content");
  await expect(add(f)).rejects.toThrow("nested package skill filename must be exactly SKILL.md");
  await expect(readdir(join(f.projectRoot, ".agentrig"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(f.source, "skills", "nested", marker), "utf8")).toContain("Nested content");
});

it("refuses case-variant nested markers in archive installs before publication", async () => {
  const f = await fixture(); const source = join(f.root, "case.tgz");
  await writeFile(source, await archive([{ header: { name: "package/package.json" }, body: manifest },
    { header: { name: "package/skills/nested/skill.md" }, body: "Nested skill" }]));
  await expect(add({ projectRoot: f.projectRoot, source })).rejects.toThrow("nested package skill filename must be exactly SKILL.md");
  await expect(readdir(join(f.projectRoot, ".agentrig"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("installed package inspection refuses a changed nested marker with the same explicit casing diagnostic", async () => {
  const f = await fixture(); await mkdir(join(f.source, "skills", "nested"));
  await writeFile(join(f.source, "skills", "nested", "SKILL.md"), "Nested content");
  const installed = await add(f), directory = join(installed.destination, "skills", "nested");
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
    await expect(add(f)).rejects.toThrow();
    await expect(readdir(join(f.projectRoot, ".agentrig"))).rejects.toMatchObject({ code: "ENOENT" });
  }
});

it("accepts a bounded npm-root archive and logical PAX long names", async () => {
  const bytes = await archive([{ header: { name: "package/", type: "directory" } }, { header: { name: "package/package.json" }, body: manifest },
    { header: { name: `package/prompts/${"a".repeat(150)}.md` }, body: "inert" }]);
  const result = await readPackageArchive(bytes); expect(result.files).toHaveLength(2);
  const f = await fixture(); const source = join(f.root, "fixture.tgz"); await writeFile(source, bytes);
  expect((await add({ projectRoot: f.projectRoot, source })).name).toBe("archive");
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
  await expect(add({ ...f, signal: controller.signal })).rejects.toThrow();
  await expect(readdir(join(f.projectRoot, ".agentrig"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("refuses directory hardlinks and in-scope symlink containers", async () => {
  const f = await fixture(); await link(join(f.source, "package.json"), join(f.source, "README"));
  await expect(add(f)).rejects.toThrow(/non-regular|linked/);
  await rm(join(f.source, "README"));
  await mkdir(join(f.projectRoot, ".agentrig"));
  await symlink(f.source, join(f.projectRoot, ".agentrig", "packages"), process.platform === "win32" ? "junction" : "dir");
  await expect(add(f)).rejects.toThrow(/real directory/);
});

it("serializes competing create-only installs without partial publication", async () => {
  const f = await fixture(); const results = await Promise.allSettled([add(f), add(f)]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  expect((await readdir(join(f.projectRoot, ".agentrig", "packages"))).filter(name => name.startsWith("."))).toEqual([]);
  expect((await inspectPackages(f.projectRoot)).packages).toHaveLength(1);
});

it("cancels during staging, removing only owned staging and lock while leaving source intact", async () => {
  const f = await fixture();
  for (let i = 0; i < 150; i++) await writeFile(join(f.source, "prompts", `${i}.md`), "content");
  const controller = new AbortController();
  const pending = add({ ...f, signal: controller.signal });
  const outcome = pending.then(() => "published", () => "cancelled");
  const sawStaging = await untilStaging(f.projectRoot);
  controller.abort();
  expect(await outcome).toBe("cancelled");
  expect(sawStaging).toBe(true);
  expect(await readdir(join(f.projectRoot, ".agentrig", "packages"))).toEqual([]);
  expect(await readFile(join(f.source, "prompts", "149.md"), "utf8")).toBe("content");
});

it("teardown joins an install the body left staging before the fixture is removed", async () => {
  // The shape a body that misses its deadline leaves behind: real staging still in flight with
  // nobody awaiting it. Teardown has to cancel and join that work, not race `rm` against it.
  const f = await fixture();
  for (let i = 0; i < 150; i++) await writeFile(join(f.source, "prompts", `${i}.md`), "content");
  const outcome = add(f).then(() => "published", () => "cancelled");
  expect(await untilStaging(f.projectRoot)).toBe(true);
  await settleOwned();
  // Asserted before the install is awaited anywhere else: once `settleOwned` returns, the owned
  // work is finished and its staging and lock are already gone. Removing the fixture here cannot
  // collide with it. Awaiting the install first would hide a teardown that never joined at all.
  expect(await readdir(join(f.projectRoot, ".agentrig", "packages"))).toEqual([]);
  expect(await outcome).toBe("cancelled");
});

/**
 * What one freshly installed fixture package costs the aggregate scan: `package.json`, `prompts/`,
 * `prompts/review.md`, `skills/` and `skills/guide.md`. Its install record is skipped, not counted.
 */
const FIXTURE_ENTRIES = 5;

/** Two real installs in one project, with the order the aggregate scan will actually walk them. */
async function twoInstalled() {
  const f = await fixture("first");
  const first = await add(f);
  await writeFile(join(f.source, "package.json"), JSON.stringify({ name: "second", version: "1", agentrig: { apiVersion: 1 } }));
  const second = await add(f);
  // Installed directories are `pkg-<sha256(name)>`, so which one is verified first is a property
  // of the names rather than of the order they were installed in.
  const [early, late] = [first, second].sort((a, b) => packageDirectoryName(a.name) < packageDirectoryName(b.name) ? -1 : 1);
  const before = await inspectPackages(f.projectRoot);
  expect(before.errors).toEqual([]);
  expect(before.packages.map(pkg => pkg.name)).toEqual([early!.name, late!.name]);
  return { f, early: early!, late: late!, earlyBytes: before.packages[0]!.bytes, lateBytes: before.packages[1]!.bytes };
}

it("does not expose an earlier verified package when the aggregate scan exhausts its entry cap", async () => {
  const { f, late } = await twoInstalled();
  // The entry budget is shared across packages and spent on every entry the walk sees, directories
  // included. Empty prompt directories exhaust the same real 2000-entry default that two thousand
  // installed files used to, without the install copying or the scan reading any of them, and they
  // leave the package otherwise intact so it is the aggregate that fires and nothing else. One
  // extra entry beyond the budget, under a single parent that keeps every `readdir` well inside the
  // per-package entry guard.
  const pad = join(late.destination, "prompts", "pad");
  await mkdir(pad);
  // FIXTURE_ENTRIES (early) + FIXTURE_ENTRIES + pad + padding === PACKAGE_LIMITS.entries + 1
  const padding = PACKAGE_LIMITS.entries + 1 - (2 * FIXTURE_ENTRIES + 1);
  await Promise.all(Array.from({ length: padding }, (_, i) => mkdir(join(pad, `d${String(i).padStart(4, "0")}`))));
  const result = await inspectPackages(f.projectRoot);
  expect(result.packages).toEqual([]);
  expect(result.errors.join()).toContain("aggregate package discovery entry limit exceeded");
}, 10_000);

it("does not expose an earlier verified package when the aggregate scan exhausts its byte cap", async () => {
  const { f, late, earlyBytes, lateBytes } = await twoInstalled();
  // The later package fits exactly on its own, including its manifest and other files. Only the
  // earlier package's consumption pushes the combined scan over the unchanged default budget.
  const prompt = join(late.destination, "prompts", "review.md");
  const oldSize = (await readFile(prompt)).length;
  const newSize = PACKAGE_LIMITS.bytes - lateBytes + oldSize;
  expect(lateBytes - oldSize + newSize).toBe(PACKAGE_LIMITS.bytes);
  expect(earlyBytes).toBeGreaterThan(0);
  await truncate(prompt, newSize);
  const result = await inspectPackages(f.projectRoot);
  expect(result.packages).toEqual([]);
  expect(result.errors.join()).toContain("aggregate package discovery byte limit exceeded");
});
