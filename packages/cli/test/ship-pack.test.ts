import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const scripts = readdirSync(new URL("scripts/", root)).filter(name => name.endsWith(".mjs"));
it("source ship manifest and compatibility config register the reserved ship namespace", async () => {
  const manifest = JSON.parse(read("packs/ship/pack.json"));
  expect(manifest).toMatchObject({ name: "ship", configNamespace: "ship", apiVersion: 1 });
  expect(manifest.scripts).toEqual(scripts);
  const config = JSON.parse(read(".agentrig/config.json"));
  expect(config.packs.ship).toEqual({ checks: config.checks, reviewers: config.reviewers });
  // @ts-expect-error source pack module
  const { shipPack } = await import("../../../packs/ship/index.mjs");
  const { buildProgram } = await import("../src/program.js");
  const program = buildProgram({ packs: [shipPack] });
  expect(program.commands.find(command => command.name() === "ship")).toBeDefined();
});
it.each(scripts)("%s preserves import identity and direct-execution failure behavior", async name => {
  const legacy = new URL(`scripts/${name}`, root);
  const moved = new URL(`packs/ship/scripts/${name}`, root);
  const oldModule = await import(legacy.href);
  const newModule = await import(moved.href);
  expect(Object.keys(oldModule).sort()).toEqual(Object.keys(newModule).sort());
  for (const key of Object.keys(newModule)) expect(oldModule[key]).toBe(newModule[key]);
  const run = (url: URL) => {
    const result = spawnSync(process.execPath, [fileURLToPath(url)], { encoding: "utf8" });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  expect(run(legacy)).toEqual(run(moved));
});
it("dispatch extension re-exports identical hooks and preserves manifest", async () => {
  const legacy = await import(new URL(".agentrig/extensions/dispatch-record.mjs", root).href);
  const moved = await import(new URL("packs/ship/extensions/dispatch-record.mjs", root).href);
  expect(legacy.activate).toBe(moved.activate);
  expect(legacy.createDispatchHook).toBe(moved.createDispatchHook);
  expect(read(".agentrig/extensions/dispatch-record.json")).toBe(read("packs/ship/extensions/dispatch-record.json"));
});
it("pack scripts use the package-root public API, never private CLI dist", () => {
  for (const name of scripts) expect(read(`packs/ship/scripts/${name}`)).not.toMatch(/packages\/cli\/dist\//);
  expect(read("packages/cli/pack-api.mjs")).toContain('from "@agentkitai/agentrig-cli"');
});

it("successful direct extraction preserves output and provenance through both paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "ship-parity-"));
  try {
    const input = join(dir, "input.md"), output = join(dir, "output.md");
    writeFileSync(input, "VERDICT: PASS\nReviewed head: " + "a".repeat(40) + "\nNo findings.\n");
    const run = (path: string) => {
      const result = spawnSync(process.execPath, [fileURLToPath(new URL(path, root)), "--extract", "codex-cli", input, output], { encoding: "utf8" });
      expect(result.status).toBe(0);
      return { stdout: result.stdout, stderr: result.stderr, body: readFileSync(output, "utf8"), receipt: readFileSync(`${output}.provenance.json`, "utf8") };
    };
    const legacy = run("scripts/review-finding-index.mjs");
    rmSync(output); rmSync(`${output}.provenance.json`);
    expect(run("packs/ship/scripts/review-finding-index.mjs")).toEqual(legacy);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it("source bootstrap exposes callable public config, environment and provider APIs", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const api = await import(${JSON.stringify(new URL("packs/ship/public-api.mjs", root).href)});
    for (const name of ["parseConfigText", "readConfigFile", "resolveChildEnvironment", "reviewerHome", "buildRoleProvider", "resolveProjectChecks"]) {
      if (typeof api[name] !== "function") throw new Error(name);
    }
    const config = api.parseConfigText("test", JSON.stringify({ packs: { ship: { reviewers: { Codex: { adapter: "codex-cli", model: "pin" } } } } }));
    if (config.reviewers.Codex.model !== "pin") throw new Error("ship namespace bridge missing");
  `], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});
