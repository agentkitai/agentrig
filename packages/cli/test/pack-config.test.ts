import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { validateEvaluationProfile } from "../src/evaluation-fixtures.js";
import { parseConfigText, readConfigFile, resolveConfig, type ConfigReadOptions } from "../src/config.js";
import { buildProgram } from "../src/program.js";

const parseConfig = (value: unknown, options?: ConfigReadOptions) => parseConfigText("fixture", JSON.stringify(value), options);
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const fixture = { name: "fixture", summary: "Fixture", configSchema: z.object({ greeting: z.string() }).strict(),
  commands: [{ name: "echo", summary: "Echo", run: vi.fn() }] };
const options = { packs: [fixture], onWarning: vi.fn() };
it("registers strict namespaced schemas at the in-memory and file boundaries", async () => {
  const value = { packs: { fixture: { greeting: "hello" } } };
  expect(parseConfig(value, options).packs).toEqual(value.packs);
  const root = await mkdtemp(join(tmpdir(), "pack-config-")); roots.push(root);
  const path = join(root, "config.json"); await writeFile(path, JSON.stringify(value));
  expect((await readConfigFile(path, options))?.packs).toEqual(value.packs);
  await writeFile(path, JSON.stringify({ packs: { fixture: { greeting: 1 } } }));
  await expect(readConfigFile(path, options)).rejects.toThrow(/invalid config/);
});
it.each([{ fixture: { greeting: 1 } }, { fixture: { greeting: "ok", typo: true } }, { unknown: {} }])("rejects invalid and unregistered namespaces", packs => {
  expect(() => parseConfig({ packs }, options)).toThrow();
});
it("rejects catchall schemas that bypass strict unknown-key rejection", () => {
  expect(() => parseConfig({}, { packs: [{ ...fixture, configSchema: z.object({ greeting: z.string() }).strict().catchall(z.unknown()) }] })).toThrow(/strict/);
});
it("rejects non-strict schema registration", () => {
  expect(() => parseConfig({}, { packs: [{ ...fixture, configSchema: z.object({ greeting: z.string() }) }] })).toThrow(/strict/);
});
it("keeps legacy keys and warns with exact migration paths, including profiles", () => {
  const onWarning = vi.fn();
  const checks = { bootstrap: "pnpm install", steps: [{ name: "build", command: "pnpm build" }] };
  const reviewers = { critic: { adapter: "codex-cli", model: "gpt-5.4" } };
  const config = parseConfig({ checks, reviewers, profiles: { personal: { checks } } }, { onWarning });
  expect(config.checks).toEqual(checks); expect(config.reviewers).toEqual(reviewers);
  expect(config.profiles?.personal?.checks).toEqual(checks);
  expect(onWarning.mock.calls.flat().join("\n")).toMatch(/packs.ship.reviewers/);
  expect(onWarning.mock.calls.flat().join("\n")).toMatch(/profiles.personal.packs.ship.checks/);
});
it("accepts ship namespaces without warnings and lets namespace win over legacy", () => {
  const onWarning = vi.fn(); const checks = { bootstrap: "pnpm install", steps: [{ name: "test", command: "pnpm test" }] };
  expect(parseConfig({ packs: { ship: { checks } }, profiles: { personal: { packs: { ship: { checks } } } } }, { onWarning }).checks).toEqual(checks);
  expect(onWarning).not.toHaveBeenCalled();
  expect(parseConfig({ checks: { bootstrap: "pnpm install", steps: [{ name: "old", command: "old" }] }, packs: { ship: { checks } } }, { onWarning }).checks).toEqual(checks);
});
it("loads fixture command config and refuses invalid files before handler dispatch", async () => {
  vi.stubEnv("AGENTRIG_CHILD_PROFILE", undefined);
  const root = await mkdtemp(join(tmpdir(), "pack-command-")); roots.push(root);
  const home = join(root, "home"); const cwd = join(root, "project");
  await mkdir(join(home, ".agentrig"), { recursive: true }); await mkdir(cwd);
  const path = join(home, ".agentrig", "config.json");
  const run = vi.fn();
  const program = () => buildProgram({ packs: [{ ...fixture, commands: [{ ...fixture.commands[0]!, run }] }], config: { home, cwd, env: {} } });
  await writeFile(path, JSON.stringify({ packs: { fixture: { greeting: "hello" } } }));
  await program().parseAsync(["fixture", "echo"], { from: "user" });
  expect(run).toHaveBeenCalledWith([], expect.objectContaining({ config: { greeting: "hello" } }));
  run.mockClear(); await writeFile(path, JSON.stringify({ packs: { fixture: { greeting: false } } }));
  await expect(program().parseAsync(["fixture", "echo"], { from: "user" })).rejects.toThrow(/invalid config/);
  expect(run).not.toHaveBeenCalled();
});
it("preserves reviewer validation and rejects malformed ship config and registration", () => {
  expect(() => parseConfig({ packs: { ship: { typo: true } } })).toThrow(/invalid config/);
  expect(() => parseConfig({ packs: { ship: { reviewers: { critic: { adapter: "missing", model: "x" } } } } })).toThrow(/invalid config/);
  expect(() => parseConfig({ packs: { ship: { reviewers: { critic: { adapter: "api:missing", model: "x" } } } } })).toThrow(/existing providers entry/);
  expect(() => parseConfig({}, { packs: [fixture, fixture] })).toThrow(/duplicate/);
  expect(() => buildProgram({ packs: [{ ...fixture, configSchema: z.object({ greeting: z.string() }) }] })).toThrow(/strict/);
  expect(() => parseConfig({ profiles: { x: { packs: { fixture: { greeting: false } } } } }, options)).toThrow(/invalid config/);
  expect(() => parseConfig({ packs: { fixture: {} } }, { packs: [{ name: "fixture" }] })).toThrow(/invalid config/);
});
it("keeps legacy and namespaced ship consumers equivalent", async () => {
  const { resolveProjectChecks } = await import("../src/project-checks.js");
  const root = await mkdtemp(join(tmpdir(), "pack-ship-")); roots.push(root);
  const home = join(root, "home"), cwd = join(root, "project");
  await mkdir(home); await mkdir(join(cwd, ".agentrig"), { recursive: true });
  const checks = { bootstrap: "pnpm install", steps: [{ name: "build", command: "pnpm build" }] };
  const reviewers = { critic: { adapter: "codex-cli", model: "gpt-5.4" } };
  const path = join(cwd, ".agentrig", "config.json");
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    for (const config of [{ checks, reviewers }, { packs: { ship: { checks, reviewers }, fixture: { greeting: "hello" } } }]) {
      await writeFile(path, JSON.stringify(config));
      expect(await resolveProjectChecks(cwd, undefined, {}, { packs: [fixture] })).toMatchObject(checks);
      expect((await readConfigFile(path, { packs: [fixture] }))?.reviewers).toEqual(reviewers);
    }
    expect(warning.mock.calls.flat().join("\n")).toContain("packs.ship.reviewers");
  } finally { warning.mockRestore(); }
});
it("uses whole-namespace profile precedence and ignores untrusted project config", async () => {
  vi.stubEnv("AGENTRIG_CHILD_PROFILE", undefined);
  const root = await mkdtemp(join(tmpdir(), "pack-precedence-")); roots.push(root);
  const home = join(root, "home"), cwd = join(root, "project");
  await mkdir(join(home, ".agentrig"), { recursive: true }); await mkdir(join(cwd, ".agentrig"), { recursive: true });
  const wrap = (greeting: string) => ({ packs: { fixture: { greeting } } });
  await writeFile(join(home, ".agentrig", "config.json"), JSON.stringify({ ...wrap("user"), profiles: { personal: wrap("user-profile") } }));
  const path = join(cwd, ".agentrig", "config.json");
  const run = vi.fn();
  const program = () => buildProgram({ packs: [{ ...fixture, commands: [{ ...fixture.commands[0]!, run }] }], config: { home, cwd, env: {}, notice: () => {} } });
  await writeFile(path, "{invalid");
  await program().parseAsync(["--profile", "personal", "fixture", "echo"], { from: "user" });
  expect(run).toHaveBeenLastCalledWith([], expect.objectContaining({ config: { greeting: "user-profile" } }));
  await expect(program().parseAsync(["fixture", "--trust", "echo"], { from: "user" })).rejects.toThrow(/invalid config/);
  await writeFile(path, JSON.stringify({ ...wrap("project"), profiles: { personal: wrap("project-profile") } }));
  await program().parseAsync(["--profile", "personal", "fixture", "--trust", "echo"], { from: "user" });
  expect(run).toHaveBeenLastCalledWith([], expect.objectContaining({ config: { greeting: "project-profile" } }));
});

describe("legacy validation and effective namespace boundaries", () => {
  const parse = (value: unknown) => parseConfig(value, options);
  const checks = { bootstrap: "pnpm install", steps: [{ name: "test", command: "pnpm test" }] };
  const providers = { pinned: { provider: "openai", model: "pin-1" } };
  const valid = { primary: { adapter: "api:pinned", model: "pin-1" } };
  it.each([
    { primary: { adapter: "api:missing", model: "pin-1" } },
    { primary: { adapter: "api:pinned", model: "wrong" } },
  ])("rejects invalid legacy bindings even beside winning valid namespaces: %j", reviewers => {
    expect(() => parse({ providers, reviewers, packs: { ship: { reviewers: valid } } }))
      .toThrow(/API adapter must reference/);
  });
  it("retains namespace precedence after both reviewer bindings validate", () => {
    const reviewers = { legacy: { adapter: "codex-cli", model: "pin-2" } };
    expect(parse({ providers, reviewers, packs: { ship: { reviewers: valid } } }).reviewers).toEqual(valid);
  });
  it.each([
    ["user", undefined], ["user", "personal"],
    ["project", undefined], ["project", "personal"],
  ] as const)("keeps namespaces out of %s effective evaluation values (profile %s)", (source, profile) => {
    const declaration = { model: "pin-1", packs: { fixture: { greeting: "base" }, ship: { checks } } };
    const file = parse(profile ? { profiles: { personal: declaration } } : declaration);
    const resolved = resolveConfig({ defaults: {}, [source]: file, profile });
    expect(resolved).toEqual({ model: "pin-1" });
    expect(() => validateEvaluationProfile(resolved)).not.toThrow();
  });
});
