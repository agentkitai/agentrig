import { expect, it } from "vitest";
import { parseConfigText, resolveConfig } from "../src/config.js";

it("accepts profile-only childEnv plain strings and absolute tool homes without runtime config leakage", () => {
  const project = parseConfigText("fixture", JSON.stringify({ profiles: { personal: { childEnv: { CODEX_HOME: "/tool home", CLAUDE_CONFIG_DIR: "/claude", LANG: "en_US.UTF-8" } } } }));
  expect(project.profiles?.personal?.childEnv).toEqual({ CODEX_HOME: "/tool home", CLAUDE_CONFIG_DIR: "/claude", LANG: "en_US.UTF-8" });
  expect(resolveConfig({ defaults: {}, project, profile: "personal" })).not.toHaveProperty("childEnv");
});
it.each([{ CODEX_HOME: "relative" }, { CODEX_HOME: "~/home" }, { CLAUDE_CONFIG_DIR: "" }, { LANG: 5 }, { LANG: "a\nb" }, { "BAD=KEY": "value" }, { OPENAI_API_KEY: "do-not-print" }, { SERVICE_TOKEN: "do-not-print" }])("rejects unsafe childEnv %j", childEnv => {
  expect(() => parseConfigText("fixture", JSON.stringify({ profiles: { personal: { childEnv } } }))).toThrow();
});
it("refuses base-level childEnv", () => {
  expect(() => parseConfigText("fixture", JSON.stringify({ childEnv: { LANG: "C" } }))).toThrow();
});

import { profileChildEnv, reviewerHome, requireReviewerHomes } from "../src/child-env.js";
it("M-home-fallback: explicit inherited home accepted, API needs none, maps replace", () => {
  expect(reviewerHome("slot", { adapter: "codex-cli", model: "pinned" }, { CODEX_HOME: "/shell/tool" })).toEqual({ variable: "CODEX_HOME", path: "/shell/tool" });
  expect(reviewerHome("slot", { adapter: "api:one", model: "pinned" }, {})).toBeNull();
  expect(() => requireReviewerHomes({ slot: { adapter: "claude-cli", model: "pinned" } }, {})).toThrow("CLAUDE_CONFIG_DIR");
  expect(profileChildEnv({ profiles: { p: { childEnv: { LANG: "C" } } } }, { profiles: { p: { childEnv: {} } } }, "p")).toEqual({});
});
