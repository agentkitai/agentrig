import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
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
    const link = join(dir, "checkout");
    symlinkSync(fileURLToPath(root), link, "junction");
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
    for (const prefix of ["scripts", "packs/ship/scripts"]) {
      rmSync(output); rmSync(`${output}.provenance.json`);
      expect(run(pathToFileURL(join(link, prefix, "review-finding-index.mjs")).href)).toEqual(legacy);
    }
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

// Node canonicalizes import.meta.url but preserves symlink spelling in argv[1].
it.each(scripts)("%s keeps symlinked legacy/new direct execution and inert imports", name => {
  const dir = mkdtempSync(join(tmpdir(), "ship-symlink-"));
  try {
    const link = join(dir, "checkout");
    symlinkSync(fileURLToPath(root), link, "junction");
    const run = (path: string) => {
      const result = spawnSync(process.execPath, [path], { encoding: "utf8" });
      expect(result.error).toBeUndefined();
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    };
    for (const prefix of ["scripts", "packs/ship/scripts"]) {
      const canonical = fileURLToPath(new URL(`${prefix}/${name}`, root));
      const linked = join(link, prefix, name);
      const expected = run(canonical);
      if (name !== "review-verdict.mjs") expect(expected.status).not.toBe(0);
      expect(run(linked)).toEqual(expected);
      // Importing with unrelated argv must not execute either entry point.
      const safe = spawnSync(process.execPath, ["--input-type=module", "-e",
        `await import(${JSON.stringify(pathToFileURL(linked).href)}); console.log("import-only");`, join(link, "packs/ship/index.mjs")], { encoding: "utf8" });
      expect(safe.status).toBe(0);
      expect(safe.stdout).toBe("import-only\n");
      expect(safe.stderr).toBe("");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const prefix of ["scripts", "packs/ship/scripts"]) {
  for (const argv of [[], ["definitely-not-a-file"]]) {
    it.each(scripts)(`${prefix}/%s imports inertly with ${argv.length ? "nonexistent" : "absent"} argv entry`, name => {
      const url = new URL(`${prefix}/${name}`, root);
      const result = spawnSync(process.execPath, ["--input-type=module", "-e",
        `const module = await import(${JSON.stringify(url.href)}); if (!Object.keys(module).length) throw new Error("missing exports"); console.log("import-only");`, ...argv],
      { encoding: "utf8", cwd: fileURLToPath(root) });
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("import-only\n");
    });
  }
}
