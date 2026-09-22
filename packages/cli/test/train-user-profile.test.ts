import { cliEnv } from "./cli-env.js";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, realpath } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runTrain, trainStatus } from "@agentkitai/agentrig-core";
import { trainChildEnvironment } from "../src/child-env.js";
import { resolveTrainTestTimeout } from "../src/project-checks.js";
import { buildProgram } from "../src/program.js";
import { loadRunConfig } from "../src/config.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(profile = "personal") {
  const root = await mkdtemp(join(tmpdir(), "train-user-profile-")); roots.push(root);
  const home = join(root, "home"), checkout = join(root, "checkout"), queue = join(root, "train");
  await mkdir(join(home, ".agentrig"), { recursive: true });
  await mkdir(join(checkout, ".git"), { recursive: true });
  await mkdir(join(checkout, ".agentrig")); await mkdir(join(queue, "queue"), { recursive: true });
  vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home);
  await writeFile(join(home, ".agentrig/config.json"), JSON.stringify({ profiles: { personal: { childEnv: { CODEX_HOME: join(home, "codex") } } } }));
  await writeFile(join(checkout, ".agentrig/config.json"), JSON.stringify({ checks: { bootstrap: "pnpm install --frozen-lockfile", steps: [{ name: "test", command: "pnpm test", countsParser: "vitest", testTimeout: 12345 }] } }));
  await writeFile(join(queue, "queue/001.json"), JSON.stringify({ task: "Test", authorization: "Test only", scope: ["packages/cli"], environment: { checkout, repository: "owner/repo", baseBranch: "main", ciWorkflows: ["CI"], profile } }));
  await writeFile(join(home, ".agentrig/trust.json"), JSON.stringify({ projects: { [await realpath(checkout)]: true } }));
  return { home, checkout, queue };
}
const options = { childEnvironment: trainChildEnvironment, testTimeout: resolveTrainTestTimeout };
it("resolves a profile declared ONLY in user config", async () => {
  const { home, checkout } = await fixture();
  expect((await trainChildEnvironment(checkout, "personal")).CODEX_HOME).toBe(join(home, "codex"));
});
it("accepts user-only profiles while resolving the project-owned train test budget", async () => {
  const { checkout } = await fixture();
  expect(await resolveTrainTestTimeout(checkout, "personal")).toBe(12345);
});
it("a user-only profile row reaches checkout-validation", async () => {
  const { queue } = await fixture();
  const command = vi.fn(async (_spec: import("@agentkitai/agentrig-core").TrainCommand) => ({ code: 1, stdout: "", stderr: "checkout validation sentinel" }));
  expect(await runTrain(queue, { ...options, command })).toBe("halted");
  expect(command).toHaveBeenCalled();
  expect(command.mock.calls[0]?.[0]).toMatchObject({ executable: "git" });
});
it("reports unknown user profiles as invalidEntries without consuming a row", async () => {
  const { queue } = await fixture("missing");
  const status = await trainStatus(queue, options);
  expect(status.invalidEntries.join("\n")).toContain('unknown config profile "missing"');
  const command = vi.fn();
  expect(await runTrain(queue, { ...options, command })).toBe("halted");
  expect(command).not.toHaveBeenCalled();
  expect(await readdir(join(queue, "queue"))).toEqual(["001.json"]);
  expect(await readdir(join(queue, "halted"))).toEqual([]);
});

it("train --status wires profile validation without claiming the queued row", async () => {
  const { checkout, queue } = await fixture("missing");
  const output = execFileSync(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url)), "train", queue, "--status"], { cwd: checkout, env: cliEnv(), encoding: "utf8" });
  expect(JSON.parse(output)).toMatchObject({ queue: 1, active: 0, halted: 0, invalidEntries: [expect.stringContaining('unknown config profile "missing"')] });
  expect(await readdir(join(queue, "queue"))).toEqual(["001.json"]);
});

it("refuses an unknown builder provider before checkout validation and accepts active-profile names", async () => {
  const { home, queue } = await fixture();
  const path = join(queue, "queue/001.json");
  const row = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...row, builderProvider: "sol" }));
  const command = vi.fn(async () => ({ code: 1, stdout: "", stderr: "checkout sentinel" }));
  expect(await runTrain(queue, { ...options, command })).toBe("halted");
  expect(command).not.toHaveBeenCalled();
  expect((await trainStatus(queue, options)).invalidEntries.join("\n")).toContain('unknown builder provider entry "sol"');
  await writeFile(join(home, ".agentrig/config.json"), JSON.stringify({ profiles: { personal: { providers: { sol: { provider: "openai", model: "sol" } } } } }));
  expect(await runTrain(queue, { ...options, command })).toBe("halted");
  expect(command).toHaveBeenCalled();
});

// R1: the synthetic runtime entry is not a declared train builder provider.
it.each(["default", "constructor", "toString"])("rejects undeclared builder %s before queue movement or checkout", async builderProvider => {
  const { queue } = await fixture();
  const path = join(queue, "queue/001.json");
  const row = JSON.parse(await readFile(path, "utf8"));
  const original = JSON.stringify({ ...row, builderProvider });
  await writeFile(path, original);
  const command = vi.fn();
  expect((await trainStatus(queue, options)).invalidEntries.join("\n")).toContain("unknown builder provider");
  expect(await runTrain(queue, { ...options, command })).toBe("halted");
  expect(command).not.toHaveBeenCalled();
  expect(await readFile(path, "utf8")).toBe(original);
  expect(await readdir(join(queue, "active"))).toEqual([]);
});

// R3: lower-case environment keys are legal child environment, not config values.
it("validates the launched profile overlay without treating child environment as config", async () => {
  const { checkout, queue, home } = await fixture();
  await writeFile(join(home, ".agentrig/config.json"), JSON.stringify({ profiles: { personal: {
    providers: { sol: { provider: "openai", model: "fixture" } },
    childEnv: { providers: "x", model: "not-config", AGENTRIG_MODEL: "mapped-model" },
  } } }));
  const path = join(queue, "queue/001.json");
  const row = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...row, builderProvider: "sol" }));
  expect((await trainStatus(queue, options)).invalidEntries).toEqual([]);
  expect(await readdir(join(queue, "queue"))).toEqual(["001.json"]);
  expect(await readdir(queue)).not.toContain("active");
  expect(await trainChildEnvironment(checkout, "personal", "sol"))
    .toMatchObject({ providers: "x", model: "not-config", AGENTRIG_MODEL: "mapped-model" });
  const command = vi.fn(async () => ({ code: 1, stdout: "", stderr: "checkout sentinel" }));
  expect(await runTrain(queue, { ...options, command })).toBe("halted");
  expect(command).toHaveBeenCalled();
});

// R5: validate, then resolve the actual train child argv through run's config loader.
it.each([undefined, "row-profile"])("launches the validated builder profile (row profile: %s)", async profile => {
  const { checkout, queue, home } = await fixture();
  vi.stubEnv("AGENTRIG_CHILD_PROFILE", "personal");
  await writeFile(join(home, ".agentrig/config.json"), JSON.stringify({ profiles: {
    personal: { providers: { sol: { provider: "openai", model: "inherited-model" } } },
    "row-profile": { providers: { sol: { provider: "openai", model: "row-model" } } },
  } }));
  const path = join(queue, "queue/001.json");
  const row = JSON.parse(await readFile(path, "utf8"));
  delete row.environment.profile;
  if (profile !== undefined) row.environment.profile = profile;
  await writeFile(path, JSON.stringify({ ...row, builderProvider: "sol" }));
  expect((await trainStatus(queue, options)).invalidEntries).toEqual([]);
  const launches: Array<{ profile: unknown; model: unknown }> = [];
  const command: import("@agentkitai/agentrig-core").TrainCommand = async spec => {
    const argv = spec.argv;
    if (argv[0] === "run") {
      // Faithful fake launch: real run options/parser and loadRunConfig, no model or landing.
      const run = buildProgram().commands.find(cmd => cmd.name() === "run")!;
      run.parseOptions(argv.slice(1));
      const resolved = await loadRunConfig(run, run.optsWithGlobals(), { cwd: checkout, home, env: spec.env, interactive: false });
      launches.push({ profile: resolved.profile, model: resolved.providers?.sol?.model });
      return { code: 1, stdout: "", stderr: "intentional stop after child config resolution" };
    }
    let stdout = "";
    if (argv.includes("--show-toplevel")) stdout = checkout;
    else if (argv[0] === "rev-parse") stdout = "c".repeat(40);
    else if (argv.includes("--show-current")) stdout = "main";
    else if (argv[0] === "remote") stdout = "https://github.com/owner/repo.git";
    return { code: 0, stdout, stderr: "" };
  };
  expect(await runTrain(queue, { ...options, command })).toBe("halted");
  expect(launches).toEqual([{ profile: profile ?? "personal", model: profile === undefined ? "inherited-model" : "row-model" }]);
});

it("refuses a builder absent from the inherited profile before checkout or queue movement", async () => {
  const { queue } = await fixture();
  vi.stubEnv("AGENTRIG_CHILD_PROFILE", "personal");
  const path = join(queue, "queue/001.json");
  const row = JSON.parse(await readFile(path, "utf8"));
  delete row.environment.profile;
  const original = JSON.stringify({ ...row, builderProvider: "missing" });
  await writeFile(path, original);
  expect((await trainStatus(queue, options)).invalidEntries.join("\n")).toContain('unknown builder provider entry "missing"');
  const command = vi.fn();
  expect(await runTrain(queue, { ...options, command })).toBe("halted");
  expect(command).not.toHaveBeenCalled();
  expect(await readFile(path, "utf8")).toBe(original);
  expect(await readdir(join(queue, "active"))).toEqual([]);
  expect(await readdir(join(queue, "halted"))).toEqual([]);
});
