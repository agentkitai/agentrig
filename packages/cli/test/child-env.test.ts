import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { parseConfigText, resolveConfig } from "../src/config.js";
import { ChildEnvSchema, profileChildEnvironment, reviewerHome, trainChildEnvironment } from "../src/child-env.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it("profile childEnv validates only bounded non-secret plain strings and absolute tool homes", () => {
  const childEnv = { CODEX_HOME: "/profiles/with spaces", CLAUDE_CONFIG_DIR: "/profiles/claude", LANG: "en_US.UTF-8" };
  const config = parseConfigText("fixture", JSON.stringify({ profiles: { personal: { childEnv } } }));
  expect(config.profiles?.personal?.childEnv).toEqual(childEnv);
  expect(resolveConfig({ defaults: {}, user: config, profile: "personal" })).not.toHaveProperty("childEnv");
  for (const bad of [{ CODEX_HOME: "relative" }, { CLAUDE_CONFIG_DIR: "~/profile" }, { A: "" }, { A: " " }, { A: "line\r\nline" }, { A: "\u202ehidden" }, { A: 3 }, { A: "x".repeat(4097) }, { OPENAI_API_KEY: "secret" }, { PATH: "/tmp" }, { HOME: "/tmp" }, { NODE_OPTIONS: "--require x" }, { "bad-name": "x" }, { A: "sk-secret" }, Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`V${i}`, "x"]))]) {
    expect(() => parseConfigText("fixture", JSON.stringify({ profiles: { personal: { childEnv: bad } } })), JSON.stringify(bad)).toThrow();
  }
  expect(() => parseConfigText("fixture", JSON.stringify({ childEnv }))).toThrow();
  expect(ChildEnvSchema.parse({ LABEL: 'plain "quoted" \\ value' })).toEqual({ LABEL: 'plain "quoted" \\ value' });
});
it("reviewer homes fail closed with the exact variable and API slots need no CLI home", () => {
  for (const [adapter, key] of [["codex-cli", "CODEX_HOME"], ["claude-cli", "CLAUDE_CONFIG_DIR"]] as const) {
    for (const value of [undefined, "", "relative", "/path\nspoof"]) expect(() => reviewerHome(adapter, { [key]: value })).toThrow(key);
    expect(reviewerHome(adapter, { [key]: "/chosen home" })).toBe("/chosen home");
  }
  expect(reviewerHome("api:local", {})).toBeUndefined();
  expect(() => reviewerHome("unknown", {})).toThrow("unknown");
});
it("user profile overrides inherited homes without changing caller state or loading project overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "child-env-")); roots.push(root);
  const home = join(root, "home"), cwd = join(root, "project");
  await mkdir(join(home, ".agentrig"), { recursive: true }); await mkdir(cwd);
  await writeFile(join(home, ".agentrig/config.json"), JSON.stringify({ profiles: { personal: { childEnv: { CODEX_HOME: "/personal" } } } }));
  const env = { CODEX_HOME: "/wrong", KEEP: "yes" };
  expect(await profileChildEnvironment(cwd, "personal", env, home)).toEqual({ CODEX_HOME: "/personal", KEEP: "yes" });
  expect(env.CODEX_HOME).toBe("/wrong");
  expect(await profileChildEnvironment(cwd, undefined, env, home)).toEqual(env);
  await mkdir(join(root, ".git"));
  expect(await profileChildEnvironment(cwd, "personal", env, home)).toEqual(env);
});
it("train refuses a declared reviewer slot before dispatch when its home is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "child-env-train-")); roots.push(root);
  await mkdir(join(root, ".agentrig"));
  await writeFile(join(root, ".agentrig/config.json"), JSON.stringify({ reviewers: { slot: { adapter: "codex-cli", model: "pinned" } } }));
  const old = process.env.CODEX_HOME; delete process.env.CODEX_HOME;
  try {
    let reason = ""; try { await trainChildEnvironment(root); } catch (error) { reason = (error as Error).message; }
    expect(reason).toContain("CODEX_HOME");
  }
  finally { if (old !== undefined) process.env.CODEX_HOME = old; }
});

import { chmod } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
it.each(["codex-cli", "claude-cli"])("real CLI profile reaches %s login-status without shell exports", async adapter => {
  const root = await mkdtemp(join(tmpdir(), "profile-cli-")); roots.push(root);
  const home = join(root, "home"), cwd = join(root, "project"), selected = join(root, "selected");
  await mkdir(join(home, ".agentrig"), { recursive: true }); await mkdir(join(cwd, ".agentrig"), { recursive: true }); await mkdir(join(cwd, ".git"));
  await writeFile(join(home, ".agentrig/config.json"), JSON.stringify({ profiles: { personal: { childEnv: { CODEX_HOME: selected, CLAUDE_CONFIG_DIR: selected } } } }));
  await writeFile(join(home, ".agentrig/trust.json"), JSON.stringify({ projects: { [cwd]: true } }));
  await writeFile(join(cwd, ".agentrig/config.json"), JSON.stringify({ reviewers: { slot: { adapter, model: "pinned" } } }));
  const binary = join(root, adapter === "codex-cli" ? "codex" : "claude");
  const args = adapter === "codex-cli" ? "login status" : "auth status --json";
  const output = adapter === "codex-cli" ? "Logged in using ChatGPT" : JSON.stringify({ loggedIn: true, email: "fixture@example.test", accessToken: "secret-never-print" });
  await writeFile(binary, `#!${process.execPath}\nif (process.env.AGENTRIG_CHILD_PROFILE !== "personal" || process.env.CODEX_HOME !== ${JSON.stringify(selected)} || process.argv.slice(2).join(' ') !== ${JSON.stringify(args)}) process.exit(2); console.log(${JSON.stringify(output)});`);
  await chmod(binary, 0o755);
  const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: `${root}:${process.env.PATH}`, CODEX_HOME: "", AGENTRIG_CHILD_PROFILE: "" };
  const run = spawnSync(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url)), "--profile", "personal", "doctor"], { cwd, env, encoding: "utf8" });
  expect(run.stdout + run.stderr).toContain(`pass reviewers:slot — home "${selected}"; logged in; account ${adapter === "codex-cli" ? "identity unavailable" : '\"fixture@example.test\"'}`);
  expect(run.stdout + run.stderr).not.toContain("secret-never-print");
  await writeFile(binary, `#!${process.execPath}\nconsole.log(${JSON.stringify(adapter === "codex-cli" ? "unexpected status" : JSON.stringify({ loggedIn: false, accessToken: "secret-never-print" }))});`);
  const bad = spawnSync(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url)), "--profile", "personal", "doctor"], { cwd, env, encoding: "utf8" });
  expect(bad.stdout + bad.stderr).toContain("login status failed");
  expect(bad.stdout + bad.stderr).not.toContain("secret-never-print");
}, 30_000);
