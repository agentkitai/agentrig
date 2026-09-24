import { readFile, readdir } from "node:fs/promises";
import { expect, it } from "vitest";
import * as core from "@agentkitai/agentrig-core";
import { createTrain } from "@agentkitai/agentrig-train";
import { harnessTrainRuntime } from "@agentkitai/agentrig-train/runtime";
import { shipTrainStages } from "@agentkitai/agentrig-ship/train";
it("core has no train code, exports or train/ship dependencies", async () => {
  expect(Object.keys(core).filter(name => /train/i.test(name))).toEqual([]);
  expect((await readdir(new URL("../../core/src/", import.meta.url))).filter(name => /train/i.test(name))).toEqual([]);
  const pkg = JSON.parse(await readFile(new URL("../../core/package.json", import.meta.url), "utf8"));
  expect(Object.keys(pkg.dependencies)).not.toContain("@agentkitai/agentrig-train");
  expect(Object.keys(pkg.dependencies)).not.toContain("@agentkitai/agentrig-ship");
  expect(createTrain(harnessTrainRuntime, shipTrainStages).runTrain).toBeTypeOf("function");
});
