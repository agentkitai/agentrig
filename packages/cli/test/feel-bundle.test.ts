import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("retains TypeScript exported signatures in an actual split ESM bundle using the CLI build configuration", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ["packages/cli/scripts/feel-bundle-check.mjs"], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)), timeout: 30_000,
  });
  expect(stdout).toContain("PASS: compiled ESM TypeScript repository-map signatures");
}, 35_000);

it("keeps temporary bundle directories invisible to root git status, even if a child is terminated", async () => {
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const temp = await mkdtemp(join(repo, "packages/cli/.feel-bundle-"));
  try {
    const marker = join(temp, "left-by-terminated-child.js");
    await expect(promisify(execFile)(process.execPath, ["-e",
      'require("node:fs").writeFileSync(process.argv[1], "fixture"); setInterval(() => {}, 1000)', marker,
    ], { timeout: 2000 })).rejects.toMatchObject({ killed: true });
    expect(await readFile(marker, "utf8")).toBe("fixture");
    const { stdout } = await promisify(execFile)("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", temp], { cwd: repo });
    expect(stdout).toBe("");
  } finally { await rm(temp, { recursive: true, force: true }); }
}, 10_000);

it.skipIf(process.platform === "win32")("builds via absolute symlink paths with either main-module resolution mode, but not on import", async () => {
  const temp = await mkdtemp(join(tmpdir(), "feel-bundle-main-"));
  const scriptDir = fileURLToPath(new URL("../scripts/", import.meta.url));
  try {
    await mkdir(join(temp, "src"));
    await writeFile(join(temp, "src/index.ts"), 'console.log("bundled fixture");');
    await symlink(scriptDir, join(temp, "scripts"), "dir");
    // --preserve-symlinks-main resolves packages from the invocation path.
    await symlink(fileURLToPath(new URL("../node_modules/", import.meta.url)), join(temp, "node_modules"), "dir");
    const script = join(temp, "scripts/bundle.mjs");
    for (const flags of [[], ["--preserve-symlinks-main"]]) {
      await promisify(execFile)(process.execPath, [...flags, script], { cwd: temp });
      expect(await readFile(join(temp, "dist/index.js"), "utf8")).toContain("bundled fixture");
      await rm(join(temp, "dist"), { recursive: true });
    }
    await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(new URL("../scripts/bundle.mjs", import.meta.url).href)})`], { cwd: temp });
    await expect(readFile(join(temp, "dist/index.js"))).rejects.toThrow(/ENOENT/);
  } finally { await rm(temp, { recursive: true, force: true }); }
}, 30_000);

it("imports without building when argv names a nonexistent entrypoint", async () => {
  const temp = await mkdtemp(join(tmpdir(), "feel-bundle-import-"));
  try {
    await promisify(execFile)(process.execPath, ["--input-type=module", "-e",
      `await import(${JSON.stringify(new URL("../scripts/bundle.mjs", import.meta.url).href)})`, "no-such-file",
    ], { cwd: temp });
    await expect(readFile(join(temp, "dist/index.js"))).rejects.toThrow(/ENOENT/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
