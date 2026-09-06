import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { type ModelProvider } from "@agentkitai/agentrig-core";
import { buildProgram } from "../src/program.ts";
import { buildAgent, type BuiltAgent } from "../src/agent-builder.ts";
import { addPackage, inspectPackages } from "../src/packages.ts";
import { diagnose } from "../src/doctor.ts";
import { parseConfigText, resolveConfig } from "../src/config.ts";

const provider: ModelProvider = { id: "fixture", model: "none", capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100000 },
  async *stream() { yield { type: "text_delta", text: "done" }; yield { type: "stop", reason: "end_turn" }; } };
vi.mock("../src/provider.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/provider.ts")>();
  return { ...actual, buildProviders: () => ({ main: provider, memory: provider, supervisor: provider, subagents: provider,
    names: ["fixture"], roleNames: { main: "fixture", memory: "fixture", supervisor: "fixture", subagents: "fixture" }, get: () => provider }) };
});
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agentrig-package-cli-")); roots.push(root);
  const cwd = join(root, "project"); const home = join(root, "home"); const source = join(root, "bundle");
  await mkdir(cwd); await mkdir(home); await mkdir(source);
  const sentinel = join(root, "imported");
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "fixture", version: "1", agentrig: { apiVersion: 1 } }));
  await mkdir(join(source, "skills")); await writeFile(join(source, "skills", "guide.md"), "---\nname: guide\n---\nPackage guide");
  await mkdir(join(source, "extensions"));
  await writeFile(join(source, "extensions", "greet.json"), JSON.stringify({ name: "greet", version: "1", apiVersion: 1, surfaces: ["commands"] }));
  await writeFile(join(source, "extensions", "greet.mjs"), `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(sentinel)},'imported');export function activate(ctx){ctx.registerCommand({name:'greet',summary:'Greet',run(args,io){io.print('package '+args)}})}`);
  return { root, cwd, home, source, sentinel };
}
async function build(f: Awaited<ReturnType<typeof fixture>>, flags: string[] = [], notices: string[] = []) {
  let built: BuiltAgent | undefined;
  await buildProgram({ config: { cwd: f.cwd, home: f.home, env: {} }, run: async (_task, opts) => {
    built = await buildAgent(opts, { onNotice: message => notices.push(message), onHookError: message => notices.push(message) });
  } }).parseAsync(["run", "fixture", "--root", join(f.root, "logs"), "--no-repo-map", ...flags], { from: "user" });
  return built!;
}

it("actual package CLI requires trust; installation and readonly doctor do not import code", async () => {
  const f = await fixture(); vi.spyOn(console, "log").mockImplementation(() => {});
  const program = () => buildProgram({ config: { cwd: f.cwd, home: f.home, env: {} } });
  await expect(program().parseAsync(["package", "add", f.source], { from: "user" })).rejects.toThrow(/trusted project/);
  await program().parseAsync(["package", "add", f.source, "--trust"], { from: "user" });
  await expect(readFile(f.sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  await mkdir(join(f.home, ".agentrig"), { recursive: true });
  await writeFile(join(f.home, ".agentrig", "trust.json"), JSON.stringify({ projects: { [f.cwd]: true } }));
  const before = await readdir(join(f.cwd, ".agentrig", "packages"));
  const report = await diagnose({ cwd: f.cwd, home: f.home, env: {}, stdinTTY: false, stdoutTTY: false });
  expect(report.lines.some(line => line.includes("package:fixture") && line.includes("integrity matches"))).toBe(true);
  expect(await readdir(join(f.cwd, ".agentrig", "packages"))).toEqual(before);
  await expect(readFile(f.sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  const notices: string[] = []; const built = await build(f, [], notices);
  expect(built.skills.map(skill => skill.name)).toContain("guide");
  expect(built.commands?.map(command => command.name)).toContain("greet");
  expect(notices.some(message => message.includes("ambient Node host code"))).toBe(true);
  const messages: string[] = []; await built.commands![0]!.run("user", { print: text => messages.push(text) });
  expect(messages).toEqual(["package user"]);
  expect(await readFile(f.sentinel, "utf8")).toBe("imported");
});

it("untrusted/disabled/tampered packages never load and sandbox refusal happens before import", async () => {
  const f = await fixture(); const result = await addPackage({ projectRoot: f.cwd, source: f.source });
  expect((await build(f)).commands).toEqual([]);
  expect((await build(f, ["--trust", "--no-packages"])).skills).toEqual([]);
  expect((await build(f, ["--no-packages"])).commands).toEqual([]);
  const disabled = await build(f, ["--trust", "--no-skill-discovery", "--no-extension-discovery"]);
  expect(disabled.skills).toEqual([]); expect(disabled.commands).toEqual([]);
  await expect(build(f, ["--trust", "--sandbox", "workspace-write", "--yolo"])).rejects.toThrow(/ambient host code/);
  await expect(readFile(f.sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(join(result.destination, "skills", "guide.md"), "tampered");
  const notices: string[] = []; const tampered = await build(f, ["--trust"], notices);
  expect(tampered.skills).toEqual([]); expect(tampered.commands).toEqual([]);
  expect(notices.join()).toContain("integrity mismatch");
  await expect(readFile(f.sentinel)).rejects.toMatchObject({ code: "ENOENT" });
});

it("equal package names fail closed across packages while project roots win before home", async () => {
  const f = await fixture(); await addPackage({ projectRoot: f.cwd, source: f.source });
  await writeFile(join(f.source, "package.json"), JSON.stringify({ name: "second", version: "1", agentrig: { apiVersion: 1 } }));
  await addPackage({ projectRoot: f.cwd, source: f.source });
  const notices: string[] = []; const ambiguous = await build(f, ["--trust"], notices);
  expect(ambiguous.skills).toEqual([]); expect(ambiguous.commands).toEqual([]);
  expect(notices.join()).toContain("equal precedence");
  await expect(readFile(f.sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  await mkdir(join(f.cwd, ".agentrig", "skills"), { recursive: true });
  await writeFile(join(f.cwd, ".agentrig", "skills", "guide.md"), "Project wins");
  await mkdir(join(f.home, ".agentrig", "skills"), { recursive: true });
  await writeFile(join(f.home, ".agentrig", "skills", "guide.md"), "Home loses");
  expect((await build(f, ["--trust"])).skills[0]?.body).toBe("Project wins");
  expect(resolveConfig({ defaults: {}, user: { packages: true }, cli: { packages: false } }).packages).toBe(false);
  expect(() => parseConfigText("fixture", '{"packages":"true"}')).toThrow();
});

it("accepts actual npm pack --ignore-scripts output with identical selected content", async () => {
  const f = await fixture();
  const run = promisify(execFile);
  const result = process.platform === "win32"
    ? await run("cmd.exe", ["/d", "/s", "/c", "npm pack --ignore-scripts --json --pack-destination .."], { cwd: f.source })
    : await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", ".."], { cwd: f.source });
  const packed = JSON.parse(result.stdout) as Array<{ filename: string }>;
  const installed = await addPackage({ projectRoot: f.cwd, source: join(f.root, packed[0]!.filename) });
  expect(await readFile(join(installed.destination, "skills", "guide.md"))).toEqual(await readFile(join(f.source, "skills", "guide.md")));
  expect((await inspectPackages(f.cwd)).errors).toEqual([]);
  await expect(readFile(f.sentinel)).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);

it.each(["relative", "absolute"])("keeps package skills before home after an explicit alias (%s) is deduplicated", async kind => {
  const f = await fixture(); await addPackage({ projectRoot: f.cwd, source: f.source });
  await mkdir(join(f.cwd, ".agentrig", "skills"), { recursive: true });
  await mkdir(join(f.home, ".agentrig", "skills"), { recursive: true });
  await writeFile(join(f.home, ".agentrig", "skills", "guide.md"), "Home fallback");
  const notices: string[] = [];
  const alias = kind === "relative" ? relative(process.cwd(), join(f.cwd, ".agentrig", "skills")) : `${join(f.cwd, ".agentrig")}/./skills`;
  const built = await build(f, ["--trust", "--skills", alias], notices);
  expect(built.skills.find(skill => skill.name === "guide")?.body).toBe("Package guide");
  expect(notices.some(message => message.includes("equal precedence"))).toBe(false);
  await writeFile(join(f.cwd, ".agentrig", "skills", "guide.md"), "Project wins");
  expect((await build(f, ["--trust", "--skills", alias])).skills.find(skill => skill.name === "guide")?.body).toBe("Project wins");
});
