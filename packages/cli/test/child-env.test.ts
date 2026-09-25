import { expect, it } from "vitest";
import { parseConfigText, resolveConfig } from "../src/config.js";
import { reviewerHome, reviewerLoginSummary } from "../src/child-env.js";

it("user profile childEnv accepts plain settings, literal quotes and absolute tool homes but is not runtime config", () => {
  const file = parseConfigText("fixture", JSON.stringify({ profiles: { personal: { childEnv: { CODEX_HOME: "/homes/codex", CLAUDE_CONFIG_DIR: "/homes/claude", LABEL: 'a "quoted" setting' } } } }));
  expect(file.profiles?.personal).toHaveProperty("childEnv.CODEX_HOME", "/homes/codex");
  expect(resolveConfig({ defaults: {}, user: file, profile: "personal" })).not.toHaveProperty("childEnv");
});
it.each([42, null, [], { A: 4 }, { SETTING: "sk-fixture" }, { ["A".repeat(129)]: "x" }, { A: "" }, { A: " \r\n" }, { A: "a\u001b" }, { CODEX_HOME: "relative" }, { CLAUDE_CONFIG_DIR: "~/home" }, { OPENAI_API_KEY: "do-not-print" }, { NODE_OPTIONS: "--require bad" }, { AGENTRIG_CHILD_PROFILE: "other" }, { "bad-name": "x" }, { A: "x".repeat(4097) }, Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`VAR_${i}`, "x"]))])("rejects malformed, credential or oversized childEnv %#", value => {
  expect(() => parseConfigText("fixture", JSON.stringify({ profiles: { personal: { childEnv: value } } }))).toThrow();
});
it("rejects reserved own keys without z.record silently dropping them and refuses base declarations", () => {
  expect(() => parseConfigText("fixture", '{"profiles":{"p":{"childEnv":{"__proto__":"x"}}}}')).toThrow();
  expect(() => parseConfigText("fixture", '{"childEnv":{"CODEX_HOME":"/x"}}')).toThrow();
});
it.each(["codex-cli", "claude-cli"])("requires an explicit absolute %s home, including blank/CRLF/refusal paths", adapter => {
  const variable = adapter === "codex-cli" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
  for (const value of [undefined, "", " ", "relative", "/x\r\n", "/x\u202e"]) expect(() => reviewerHome(adapter, { [variable]: value })).toThrow(variable);
  expect(reviewerHome(adapter, { [variable]: "/tools/a/../home" })).toEqual({ variable, path: "/tools/a/../home" });
  expect(reviewerHome("api:custom", {})).toBeNull();
  expect(() => reviewerHome("unknown", {})).toThrow("unknown reviewer");
});
it("doctor status projection reports only allowlisted login information, never key output", () => {
  expect(reviewerLoginSummary("codex-cli", "", "Logged in using ChatGPT\r\n")).toContain("ChatGPT");
  expect(reviewerLoginSummary("codex-cli", "", "Logged in using an API key - sk-do-not-print")).not.toContain("sk-do-not-print");
  expect(reviewerLoginSummary("codex-cli", "prose mentions Logged in using ChatGPT", "")).toBeUndefined();
  expect(reviewerLoginSummary("claude-cli", JSON.stringify({ loggedIn: true, email: "operator@example.com", accessToken: "do-not-print" }), "")).toBe("logged in as operator@example.com");
  for (const value of ["garbage", '{"loggedIn":false}', '{"loggedIn":true,"email":"bad\\ntext"}']) expect(reviewerLoginSummary("claude-cli", value, "do-not-print")).toBeUndefined();
});

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveChildEnvironment } from "../src/profile-child-env.js";
it("only the selected safe user profile overlays inherited environment; sibling/project profiles cannot redirect it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "child-env-"));
  try {
    const home = join(dir, "home"), cwd = join(dir, "repo");
    await mkdir(join(home, ".agentrig"), { recursive: true }); await mkdir(join(cwd, ".git"), { recursive: true });
    await writeFile(join(home, ".agentrig/config.json"), JSON.stringify({ profiles: { personal: { childEnv: { CODEX_HOME: "/personal", LABEL: 'literal "quote"' } }, work: { childEnv: { CODEX_HOME: "/work" } } } }));
    expect(await resolveChildEnvironment(cwd, "personal", { CODEX_HOME: "/inherited", KEEP: "yes" }, home)).toMatchObject({ CODEX_HOME: "/personal", KEEP: "yes", LABEL: 'literal "quote"' });
    expect(await resolveChildEnvironment(cwd, undefined, { CODEX_HOME: "/inherited" }, home)).toEqual({ CODEX_HOME: "/inherited" });
    expect(await resolveChildEnvironment(cwd, "work", {}, home)).toEqual({ CODEX_HOME: "/work" });
    await mkdir(join(home, ".git"));
    expect(await resolveChildEnvironment(home, "personal", { KEEP: "yes" }, home)).toEqual({ KEEP: "yes" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// @ts-expect-error skill-side ESM provenance boundary
import { receiptHome } from "../../../scripts/review-verdict.mjs";
it("posting binds path-only home provenance to the adapter and rejects malformed metadata", () => {
  expect(receiptHome({ adapter: "codex-cli", home: { variable: "CODEX_HOME", path: '/a "quoted" home' } })).toBe(' — home CODEX_HOME="/a \\"quoted\\" home"');
  expect(receiptHome({ adapter: "api:fixture", home: null })).toBe("");
  for (const home of [undefined, {}, { variable: "OTHER", path: "/x" }, { variable: "CODEX_HOME", path: "relative" }, { variable: "CODEX_HOME", path: "/x\r\n" }, { variable: "CODEX_HOME", path: "/" + "x".repeat(4096) }]) expect(() => receiptHome({ adapter: "codex-cli", home })).toThrow("home provenance");
  expect(() => receiptHome({ adapter: "api:fixture", home: {} })).toThrow("must be null");
});

import { buildProgram } from "../src/program.js";
import { execFileSync } from "node:child_process";
it("headless CLI descendants inherit the selected user profile and preserve literal string values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "child-env-run-"));
  const before = { CODEX_HOME: process.env.CODEX_HOME, AGENTRIG_CHILD_PROFILE: process.env.AGENTRIG_CHILD_PROFILE };
  try {
    const home = join(dir, "home"), cwd = join(dir, "project");
    await mkdir(join(home, ".agentrig"), { recursive: true }); await mkdir(cwd);
    await writeFile(join(home, ".agentrig/config.json"), JSON.stringify({ profiles: { personal: { childEnv: { CODEX_HOME: '/fixture/quoted "home"' } } } }));
    let seen = "";
    await buildProgram({ config: { cwd, home, env: {} }, run: async () => {
      seen = execFileSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify({home:process.env.CODEX_HOME,profile:process.env.AGENTRIG_CHILD_PROFILE}))"], { encoding: "utf8" });
    } }).parseAsync(["node", "agentrig", "run", "fixture", "--headless", "--profile", "personal"]);
    expect(JSON.parse(seen)).toEqual({ home: '/fixture/quoted "home"', profile: "personal" });
  } finally {
    for (const [name, value] of Object.entries(before)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    await rm(dir, { recursive: true, force: true });
  }
});

import { trainChildEnvironment, trainProfileTestTimeout } from "../src/profile-child-env.js";
it("train CLI validates every slot, rejects unknown profiles and project overrides, and resolves user-only launch profiles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "child-env-train-"));
  try {
    const home = join(dir, "home"), cwd = join(dir, "repo");
    await mkdir(join(home, ".agentrig"), { recursive: true }); await mkdir(join(cwd, ".agentrig"), { recursive: true }); await mkdir(join(cwd, ".git"));
    await writeFile(join(home, ".agentrig/config.json"), JSON.stringify({ profiles: { personal: { childEnv: { CODEX_HOME: "/personal/codex", CLAUDE_CONFIG_DIR: "/personal/claude" } } } }));
    const project = { checks: { bootstrap: "echo bootstrap", steps: [{ name: "test", command: "pnpm test", countsParser: "vitest", testTimeout: 15000 }] }, reviewers: { one: { adapter: "codex-cli", model: "pin" }, two: { adapter: "claude-cli", model: "pin" } } };
    await writeFile(join(cwd, ".agentrig/config.json"), JSON.stringify(project));
    expect(await trainChildEnvironment(cwd, "personal", {}, home)).toMatchObject({ CODEX_HOME: "/personal/codex", CLAUDE_CONFIG_DIR: "/personal/claude", AGENTRIG_CHILD_PROFILE: "personal" });
    expect(await trainProfileTestTimeout(cwd, "personal")).toBe(15000);
    await expect(trainChildEnvironment(cwd, undefined, { CODEX_HOME: "/only-one" }, home)).rejects.toThrow("CLAUDE_CONFIG_DIR");
    await expect(trainChildEnvironment(cwd, "misspelled", { CODEX_HOME: "/x", CLAUDE_CONFIG_DIR: "/y" }, home)).rejects.toThrow("unknown config profile");
    await writeFile(join(cwd, ".agentrig/config.json"), JSON.stringify({ ...project, profiles: { personal: { childEnv: { CODEX_HOME: "/project" } } } }));
    await expect(trainChildEnvironment(cwd, "personal", {}, home)).rejects.toThrow("only in operator-owned user profiles");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
