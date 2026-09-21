import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
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
