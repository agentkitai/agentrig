import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildProgram } from "../src/program.ts";
import { loadRunConfig, parseConfigText, resolveConfig } from "../src/config.ts";
import type { RunOptions } from "../src/run.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(trusted = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentrig-generated-config-"))); roots.push(root);
  const cwd = join(root, "project"); const home = join(root, "home");
  await mkdir(join(cwd, ".agentrig"), { recursive: true }); await mkdir(join(home, ".agentrig"), { recursive: true });
  if (trusted) await writeFile(join(home, ".agentrig/trust.json"), JSON.stringify({ projects: { [cwd]: true } }));
  return { cwd, home };
}
async function resolved(f: Awaited<ReturnType<typeof fixture>>, flags: string[] = []) {
  let opts: RunOptions | undefined;
  await buildProgram({ config: { ...f, env: {} }, run: async (_task, value) => { opts = value; } })
    .parseAsync(["run", "fixture", ...flags], { from: "user" });
  return opts!;
}

it("generated discovery defaults off; explicit opt-in appends roots after all manual roots", async () => {
  const f = await fixture(); const project = join(f.cwd, ".agentrig/skills"); const home = join(f.home, ".agentrig/skills");
  expect((await resolved(f)).skills).toEqual([project, home]);
  expect((await resolved(f, ["--generated-skills", "--skills", "/explicit"])).skills)
    .toEqual(["/explicit", project, home, join(project, "generated"), join(home, "generated")]);
});

it("config/negative overrides and no-discovery preserve explicit roots and empty-array replacement", async () => {
  const f = await fixture();
  await writeFile(join(f.home, ".agentrig/config.json"), JSON.stringify({ generatedSkills: true, skills: ["/user"] }));
  await writeFile(join(f.cwd, ".agentrig/config.json"), JSON.stringify({ skills: [] }));
  expect((await resolved(f)).skills).not.toContain("/user");
  expect((await resolved(f)).skills).toContain(join(f.cwd, ".agentrig/skills/generated"));
  expect((await resolved(f, ["--no-generated-skills"])).skills).toEqual([join(f.cwd, ".agentrig/skills"), join(f.home, ".agentrig/skills")]);
  expect((await resolved(f, ["--generated-skills", "--no-skill-discovery", "--skills", "/explicit"])).skills).toEqual(["/explicit"]);
  expect((await resolved(f, ["--no-skill-discovery"])).skills).toEqual([]);
  await writeFile(join(f.cwd, ".agentrig/config.json"), JSON.stringify({ generatedSkills: false, skillDiscovery: false }));
  expect((await resolved(f, ["--generated-skills", "--skill-discovery"])).skills).toContain(join(f.cwd, ".agentrig/skills/generated"));
  expect(() => parseConfigText("fixture", '{"generatedSkills":"true"}')).toThrow();
  expect(resolveConfig({ defaults: {}, user: { skills: ["a"] }, cli: { skills: [] } }).skills).toEqual([]);
});

it("untrusted projects cannot enable generated roots or read project config, while safe home remains available", async () => {
  const f = await fixture(false);
  await writeFile(join(f.cwd, ".agentrig/config.json"), "not even valid JSON");
  const opts = await resolved(f, ["--generated-skills"]);
  expect(opts.skills).not.toContain(join(f.cwd, ".agentrig/skills/generated"));
  expect(opts.skills).toContain(join(f.home, ".agentrig/skills/generated"));
  expect(opts.trustedProjectRoot).toBeUndefined();
});

it("does not load nominal home state when the repository contains home", async () => {
  const f = await fixture(); await mkdir(join(f.cwd, ".git"));
  const home = join(f.cwd, "nested-home"); await mkdir(join(home, ".agentrig"), { recursive: true });
  await writeFile(join(home, ".agentrig/config.json"), "invalid user state must not be parsed");
  const opts = await resolved({ cwd: f.cwd, home }, ["--trust", "--generated-skills"]);
  expect(opts.skills).toContain(join(f.cwd, ".agentrig/skills/generated"));
  expect(opts.skills).not.toContain(join(home, ".agentrig/skills/generated"));
});

it("uses trusted project root from nested cwd by default, selected --memory/config directory when explicit", async () => {
  const f = await fixture(); await mkdir(join(f.cwd, ".git"));
  const nested = join(f.cwd, "src/nested"); await mkdir(nested, { recursive: true });
  const opts = await resolved({ ...f, cwd: nested }, ["--generated-skills"]);
  expect(opts.skills).toContain(join(f.cwd, ".agentrig/skills/generated"));
  expect(opts.skills).not.toContain(join(nested, ".agentrig/skills/generated"));
  expect((await resolved({ ...f, cwd: nested }, ["--generated-skills", "--memory", "chosen-memory"])).skills)
    .toContain(join(nested, "chosen-memory/skills/generated"));
  await writeFile(join(f.cwd, ".agentrig/config.json"), JSON.stringify({ memory: "configured-memory", generatedSkills: true }));
  expect((await resolved(f)).skills).toContain(join(f.cwd, "configured-memory/skills/generated"));
});

it("run, TUI and resume resolve the same opt-in and explicit duplicate roots are not rescanned", async () => {
  const f = await fixture(); const generated = join(f.cwd, ".agentrig/skills/generated");
  for (const names of [["run"], ["tui"], ["sessions", "resume"]]) {
    let cmd = buildProgram(); for (const name of names) cmd = cmd.commands.find(child => child.name() === name)!;
    cmd.parseOptions(["--generated-skills", "--skills", generated]);
    const opts = await loadRunConfig(cmd, cmd.opts(), { ...f, env: {} });
    expect(opts.skills![0]).toBe(generated); expect(opts.skills!.filter(path => path === generated)).toHaveLength(1);
  }
});
