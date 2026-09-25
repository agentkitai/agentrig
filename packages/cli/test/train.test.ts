import { mkdtemp, realpath, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { buildProgram } from "../src/program.ts";

it("registers train <dir> and routes STOP without starting a model", async () => {
  expect(buildProgram().commands.find(command => command.name() === "train")?.registeredArguments[0]?.name()).toBe("dir");
  const root = await mkdtemp(join(tmpdir(), "train-cli-"));
  try {
    await mkdir(join(root, "queue")); await writeFile(join(root, "STOP"), "");
    const output = execFileSync(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url)), "train", root], { encoding: "utf8" });
    expect(JSON.parse(output)).toEqual({ type: "train.end", reason: "stopped" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

import { trainChildEnvironment } from "../src/train.js";
it("train resolves trusted profile CLI homes and refuses missing required home", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "train-env-")));
  try {
    const home = join(root, "home"), checkout = join(root, "repo");
    await mkdir(join(home, ".agentrig"), { recursive: true });
    await mkdir(join(checkout, ".git"), { recursive: true });
    await mkdir(join(checkout, ".agentrig"));
    await writeFile(join(home, ".agentrig/trust.json"), JSON.stringify({ projects: { [checkout]: true } }));
    await writeFile(join(checkout, ".agentrig/config.json"), JSON.stringify({ profiles: { personal: { childEnv: { CODEX_HOME: "/profile/codex" } } }, reviewers: { slot: { adapter: "codex-cli", model: "pinned" } } }));
    expect((await trainChildEnvironment(checkout, "personal", { home, env: {} })).CODEX_HOME).toBe("/profile/codex");
    await expect(trainChildEnvironment(checkout, undefined, { home, env: {} })).rejects.toThrow("CODEX_HOME");
    expect((await trainChildEnvironment(checkout, undefined, { home, env: { CODEX_HOME: "/shell/codex" } })).CODEX_HOME).toBe("/shell/codex");
  } finally { await rm(root, { recursive: true, force: true }); }
});
