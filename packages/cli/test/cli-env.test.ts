import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { cliEnv } from "./cli-env.js";
it("isolates real CLI spawn environment without mutating launcher", () => {
  const source = { ...process.env, AGENTRIG_CHILD_PROFILE: "personal", CODEX_HOME: "/operator/codex", CLAUDE_CONFIG_DIR: "/operator/claude", KEEP: "yes" };
  const env = cliEnv(source);
  const child = spawnSync(process.execPath, ["-p", 'JSON.stringify([process.env.AGENTRIG_CHILD_PROFILE, process.env.CODEX_HOME, process.env.CLAUDE_CONFIG_DIR, process.env.KEEP])'], { env, encoding: "utf8" });
  expect(child.status).toBe(0); expect(JSON.parse(child.stdout)).toEqual([null, null, null, "yes"]);
  expect(source.AGENTRIG_CHILD_PROFILE).toBe("personal"); expect(source.CODEX_HOME).toBe("/operator/codex");
});
