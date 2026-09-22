import { expect, it } from "vitest";
import { parseConfigText } from "../src/config.js";
const parse = (childEnv: unknown) => parseConfigText("fixture", JSON.stringify({ profiles: { personal: { childEnv } } }));
it("childEnv accepts nonsecret strings and absolute tool homes", () => {
  expect(parse({ CODEX_HOME: "/accounts/personal", CLAUDE_CONFIG_DIR: "/accounts/claude", LANG: "en_US.UTF-8" }).profiles?.personal?.childEnv).toEqual({ CODEX_HOME: "/accounts/personal", CLAUDE_CONFIG_DIR: "/accounts/claude", LANG: "en_US.UTF-8" });
});
it.each([{ CODEX_HOME: 1 }, { CODEX_HOME: "relative" }, { OPENAI_API_KEY: "do-not-echo" }, { FOO: "line\nbreak" }])("rejects invalid or credential environment without echoing values", value => {
  expect(() => parse(value)).toThrow();
  try { parse(value); } catch (error) { expect(String(error)).not.toContain("do-not-echo"); }
});

it("M-home-guard: each CLI slot refuses missing homes; APIs need no home", async () => {
  const { reviewerHome } = await import("../src/child-env.js");
  for (const adapter of ["codex-cli", "claude-cli"]) expect(() => reviewerHome("Primary", adapter, {})).toThrow(/REVIEWER_HOME_MISSING: reviewers:Primary/);
  expect(reviewerHome("API", "api:remote", {})).toBeUndefined();
  expect(reviewerHome("Primary", "codex-cli", { CODEX_HOME: "/personal" })).toEqual({ variable: "CODEX_HOME", home: "/personal" });
});

it("M-profile-precedence: only selected safe user profile overrides inherited values; project cannot set environment", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { resolveChildEnvironment } = await import("../src/child-env.js");
  const dir = await mkdtemp(join(tmpdir(), "child-env-")), cwd = join(dir, "project"), home = join(dir, "home");
  try {
    for (const root of [cwd, home]) await mkdir(join(root, ".agentrig"), { recursive: true });
    await writeFile(join(home, ".agentrig/config.json"), JSON.stringify({ profiles: { personal: { childEnv: { CODEX_HOME: "/personal", LANG: "plain" } }, work: { childEnv: { CODEX_HOME: "/work" } } } }));
    await writeFile(join(cwd, ".agentrig/config.json"), JSON.stringify({ profiles: { personal: { childEnv: { CODEX_HOME: "/project-attack" } } } }));
    const env = { CODEX_HOME: "/shell", CLAUDE_CONFIG_DIR: "/shell-claude" };
    expect(await resolveChildEnvironment({ cwd, home, env, profile: "personal" })).toEqual({ ...env, CODEX_HOME: "/personal", LANG: "plain", AGENTRIG_CHILD_PROFILE: "personal" });
    expect((await resolveChildEnvironment({ cwd, home, env, profile: "work" })).CODEX_HOME).toBe("/work");
    expect(await resolveChildEnvironment({ cwd, home, env })).toEqual(env);
    await expect(resolveChildEnvironment({ cwd, home, env, profile: "typo" })).rejects.toThrow(/unknown config profile/);
    expect((await resolveChildEnvironment({ cwd, home, env, profile: "personal", validateProfile: true })).CODEX_HOME).toBe("/personal");
    await expect(resolveChildEnvironment({ cwd: home, home, env, profile: "personal" })).rejects.toThrow(/unknown config profile/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("M-dispatch-env: the CLI preAction makes the selected home visible to spawned processes", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const { buildProgram } = await import("../src/program.js");
  const home = await mkdtemp(join(tmpdir(), "dispatch-home-"));
  const original = { ...process.env };
  try {
    await mkdir(join(home, ".agentrig"));
    await writeFile(join(home, ".agentrig/config.json"), JSON.stringify({ profiles: { personal: { childEnv: { CODEX_HOME: "/dispatch/personal" } } } }));
    process.env.HOME = home;
    process.env.CODEX_HOME = "/wrong-shell";
    delete process.env.AGENTRIG_CHILD_PROFILE;
    const refused = buildProgram();
    let launched = false;
    refused.command("env-proof").action(() => { launched = true; });
    await expect(refused.parseAsync(["--profile", "persoanl", "env-proof"], { from: "user" })).rejects.toThrow(/unknown config profile/);
    expect(launched).toBe(false);
    const program = buildProgram();
    let observed = "";
    program.command("env-proof").action(() => { observed = spawnSync(process.execPath, ["-p", "process.env.CODEX_HOME"], { encoding: "utf8" }).stdout.trim(); });
    await program.parseAsync(["--profile", "personal", "env-proof"], { from: "user" });
    expect(observed).toBe("/dispatch/personal");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    await rm(home, { recursive: true, force: true });
  }
});

it("M-train-slot-config: trusted checkout slots fail fast under the selected user environment", async () => {
  const { mkdtemp, mkdir, writeFile, rm, realpath } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { trainChildEnvironment } = await import("../src/child-env.js");
  const dir = await realpath(await mkdtemp(join(tmpdir(), "train-child-env-"))), cwd = join(dir, "project"), home = join(dir, "home");
  const original = { ...process.env };
  try {
    for (const root of [cwd, home]) await mkdir(join(root, ".agentrig"), { recursive: true });
    process.env.HOME = home; delete process.env.CODEX_HOME; delete process.env.AGENTRIG_CHILD_PROFILE;
    await writeFile(join(home, ".agentrig/trust.json"), JSON.stringify({ projects: { [cwd]: true } }));
    await writeFile(join(cwd, ".agentrig/config.json"), JSON.stringify({ reviewers: { Personal: { adapter: "codex-cli", model: "pin" } } }));
    await expect(trainChildEnvironment(cwd)).rejects.toThrow(/REVIEWER_HOME_MISSING: reviewers:Personal/);
    await writeFile(join(home, ".agentrig/config.json"), JSON.stringify({ profiles: { personal: { childEnv: { CODEX_HOME: "/train/personal" } } } }));
    expect((await trainChildEnvironment(cwd, "personal")).CODEX_HOME).toBe("/train/personal");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(["AWS_CREDENTIALS", "credentials", "MY_CREDENTIALS_FILE", "GITHUB_PAT", "GH_PAT", "PASSWD", "PASSWD_FILE", "AWS_CREDS", "NPM_AUTH_TOKEN", "ApiKey"]) ("M-C1-secret-alias: rejects %s without value disclosure", key => {
  expect(() => parse({ [key]: "do-not-echo" })).toThrow();
  try { parse({ [key]: "do-not-echo" }); } catch (error) { expect(String(error)).not.toContain("do-not-echo"); }
});

it("M-C2-trusted-project: only trusted project profile names participate in validation", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { resolveChildEnvironment } = await import("../src/child-env.js");
  const dir = await mkdtemp(join(tmpdir(), "project-profile-")), home = join(dir, "home"), cwd = join(dir, "project");
  try {
    for (const root of [home, cwd]) await mkdir(join(root, ".agentrig"), { recursive: true });
    await writeFile(join(cwd, ".agentrig", "config.json"), JSON.stringify({ profiles: { work: { childEnv: { CODEX_HOME: "/untrusted-override" } } } }));
    const env = { CODEX_HOME: "/inherited" };
    await expect(resolveChildEnvironment({ cwd, home, env, profile: "work", explicitTrust: false })).rejects.toThrow(/unknown config profile/);
    expect((await resolveChildEnvironment({ cwd, home, env, profile: "work", explicitTrust: true })).CODEX_HOME).toBe("/inherited");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
