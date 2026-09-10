import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildProgram } from "../src/program.js";
import type { RunOptions } from "../src/run.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "diagnostic-resolution-"))); roots.push(root);
  const project = join(root, "project"), home = join(root, "home"), cwd = join(project, "packages", "app");
  await mkdir(cwd, { recursive: true }); await mkdir(home); await mkdir(join(project, ".git"));
  const compiler = join(project, "node_modules", "typescript", "bin", "tsc");
  await mkdir(dirname(compiler), { recursive: true });
  await writeFile(compiler, 'console.log("local compiler fixture");');
  async function load(trusted = true, diagnostics?: object[]) {
    if (diagnostics) {
      await mkdir(join(home, ".agentrig"), { recursive: true });
      await writeFile(join(home, ".agentrig", "config.json"), JSON.stringify({ diagnostics }));
    }
    let options: RunOptions | undefined;
    await buildProgram({ config: { cwd, home, env: {}, notice: () => {} }, run: async (_task, opts) => { options = opts; } })
      .parseAsync(["run", "task", ...(trusted ? ["--trust"] : [])], { from: "user" });
    return options!.diagnostics![0]!;
  }
  return { root, project, cwd, compiler, load };
}

it("resolves the implicit checker in a trusted monorepo without PATH or shell shims", async () => {
  const { compiler, cwd, load } = await fixture();
  const checker = await load();
  expect(checker.executable).toBe(process.execPath);
  expect(checker.args).toEqual([compiler, "--noEmit", "--pretty", "false", "--listFiles"]);
  const result = await promisify(execFile)(checker.executable, checker.args, { cwd, env: { ...process.env, PATH: "" } });
  expect(result.stdout.trim()).toBe("local compiler fixture");
});

it("never discovers project executables without project trust", async () => {
  const { load } = await fixture();
  expect(await load(false)).toMatchObject({ executable: "tsc", args: ["--noEmit", "--pretty", "false", "--listFiles"] });
});

it("prefers a nested package compiler and never searches above the trusted project", async () => {
  const { root, project, cwd, load } = await fixture();
  const nested = join(cwd, "node_modules", "typescript", "bin", "tsc");
  await mkdir(dirname(nested), { recursive: true });
  await writeFile(nested, "// nested compiler");
  expect((await load()).args[0]).toBe(nested);
  await rm(join(cwd, "node_modules"), { recursive: true });
  await rm(join(project, "node_modules"), { recursive: true });
  const ancestor = join(root, "node_modules", "typescript", "bin", "tsc");
  await mkdir(dirname(ancestor), { recursive: true });
  await writeFile(ancestor, "// outside compiler");
  expect((await load()).executable).toBe("tsc");
});

it("preserves explicit checker commands even when a local compiler exists", async () => {
  const { load } = await fixture();
  const configured = { parser: "tsc", extensions: [".ts"], executable: "tsc", args: ["--noEmit", "custom.ts"] };
  expect(await load(true, [configured])).toMatchObject(configured);
});

it("retains PATH fallback when the local compiler is missing, not a file, or resolves outside the trusted root", async () => {
  const { compiler, root, load } = await fixture();
  await rm(compiler);
  expect((await load()).executable).toBe("tsc");
  await mkdir(compiler);
  expect((await load()).executable).toBe("tsc");
  await rm(compiler, { recursive: true });
  // A directory junction works on Windows without symlink privileges.
  const external = join(root, "external"); await mkdir(external);
  await writeFile(join(external, "tsc"), 'throw new Error("outside trust boundary");');
  await rm(dirname(compiler), { recursive: true });
  await symlink(external, dirname(compiler), process.platform === "win32" ? "junction" : "dir");
  expect((await load()).executable).toBe("tsc");
});
