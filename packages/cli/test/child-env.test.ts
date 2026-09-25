import { expect, it } from "vitest";
import { parseConfigText, resolveConfig } from "../src/config.js";
import { ChildEnvSchema, reviewerHome, resolveChildEnv, installChildEnv } from "../src/child-env.js";

it("accepts user profile settings but never leaks them into provider configuration", () => {
  const user = parseConfigText("user", JSON.stringify({ profiles: { work: { childEnv: { CODEX_HOME: "/tools/work", LABEL: "plain string" } } } }));
  expect(user.profiles?.work?.childEnv?.CODEX_HOME).toBe("/tools/work");
  expect(resolveConfig({ defaults: {}, user, profile: "work" })).not.toHaveProperty("childEnv");
  expect(() => parseConfigText("user", '{"childEnv":{}}')).toThrow();
});
it.each([{ TOKEN: "secret" }, { OPENAI_API_KEY: "secret" }, { CODEX_HOME: "relative" }, { CLAUDE_CONFIG_DIR: "~/home" }, { LABEL: 42 }, { LABEL: "a\nb" }])("rejects unsafe childEnv %#", childEnv => {
  expect(() => ChildEnvSchema.parse(childEnv)).toThrow();
});
it("profile overrides inherited homes; absence refuses CLI but not API", () => {
  const env = resolveChildEnv({ CODEX_HOME: "/selected" }, { CODEX_HOME: "/wrong", PATH: "/node", GIT_TRACE2_EVENT: "bad" });
  expect(env).toEqual({ CODEX_HOME: "/selected", PATH: "/node", GIT_TRACE2_EVENT: "0" });
  expect(reviewerHome("codex-cli", env)).toEqual({ variable: "CODEX_HOME", path: "/selected" });
  expect(() => reviewerHome("codex-cli", {})).toThrow("CODEX_HOME");
  expect(() => reviewerHome("claude-cli", {})).toThrow("CLAUDE_CONFIG_DIR");
  expect(reviewerHome("api:review", {})).toBeNull();
});
it("command environment is inherited by children and restored", async () => {
  const { execFileSync } = await import("node:child_process");
  const old = process.env.CODEX_HOME;
  const restore = installChildEnv({ CODEX_HOME: "/selected" });
  try { expect(execFileSync(process.execPath, ["-e", "process.stdout.write(process.env.CODEX_HOME)"], { encoding: "utf8" })).toBe("/selected"); }
  finally { restore(); }
  expect(process.env.CODEX_HOME).toBe(old);
});
it("train resolves user profile homes and refuses missing homes despite project overrides", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { resolveTrainChildEnv } = await import("../src/train.js");
  const root = await mkdtemp(join(tmpdir(), "train-profile-"));
  const home = join(root, "home"), checkout = join(root, "checkout");
  try {
    for (const path of [join(home, ".agentrig"), join(checkout, ".agentrig"), join(checkout, ".git")]) await mkdir(path, { recursive: true });
    await writeFile(join(checkout, ".agentrig/config.json"), JSON.stringify({ reviewers: { audit: { adapter: "codex-cli", model: "pinned" } }, profiles: { work: { childEnv: { CODEX_HOME: "/project" } } } }));
    await expect(resolveTrainChildEnv(checkout, "work", home, {})).rejects.toThrow(/reviewers:audit.*CODEX_HOME/);
    await writeFile(join(home, ".agentrig/config.json"), JSON.stringify({ profiles: { work: { childEnv: { CODEX_HOME: "/selected", LABEL: "value" } } } }));
    expect(await resolveTrainChildEnv(checkout, "work", home, { CODEX_HOME: "/inherited" })).toMatchObject({ CODEX_HOME: "/selected", LABEL: "value", GIT_TRACE2_EVENT: "0" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
