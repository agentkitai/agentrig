import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { createTrain, type TrainStages } from "@agentkitai/agentrig-train";
it("replaces all four row stages without invoking ship policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "train-stages-"));
  try {
    await mkdir(join(root, "queue"));
    const row = { task: "custom", authorization: "fixture", scope: ["src"], environment: { checkout: root, repository: "owner/repo", baseBranch: "main", ciWorkflows: ["CI"] } };
    await writeFile(join(root, "queue", "custom.json"), JSON.stringify(row));
    const calls: string[] = [];
    const stages: TrainStages = {
      async preCheck() { calls.push("preCheck"); return "custom-base"; },
      prompt() { calls.push("prompt"); return "custom prompt"; },
      receipt: { schema: { custom: true }, parse(value) { calls.push("receipt"); expect(value).toEqual({ ticket: 7 }); return { pr: 7 }; } },
      async verify({ startingBase, state }) { calls.push("verify"); expect(startingBase).toBe("custom-base"); expect(state.pr).toBe(7); },
    };
    const usage = vi.fn(async () => []);
    const train = createTrain({ usage, assistantText: () => undefined }, stages);
    expect(await train.runTrain(root, { command: async request => {
      expect(request.argv.at(-1)).toBe("custom prompt");
      expect(JSON.parse(await readFile(join(root, "logs/custom.output-schema.json"), "utf8"))).toEqual({ custom: true });
      await writeFile(request.resultPath!, JSON.stringify({ ticket: 7 }));
      return { code: 0, stdout: "", stderr: "" };
    } })).toBe("empty");
    expect(calls).toEqual(["preCheck", "prompt", "receipt", "verify"]);
    expect((await train.trainStatus(root)).done).toBe(1);
    expect(usage).toHaveBeenCalledWith(root);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("preserves a custom wire receipt through real child transport for the row parser", async () => {
  const root = await mkdtemp(join(tmpdir(), "train-wire-"));
  try {
    const stages: TrainStages = {
      async preCheck() { return "base"; }, prompt() { return "prompt"; },
      receipt: { schema: {}, parse(value) { expect(value).toEqual({ ticket: 7 }); return { pr: 7 }; } },
      async verify() {},
    };
    const train = createTrain({ usage: async () => [], assistantText(value) { return typeof value === "string" ? value : undefined; } }, stages);
    const resultPath = join(root, "result.json");
    const events = [{ type: "message.append", message: '{"ticket":7}' }, { type: "output.validated", valid: true }];
    const child = `for (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));`;
    expect((await train.trainCommand({ executable: process.execPath, argv: ["-e", child], cwd: root, log: join(root, "log"), resultPath })).code).toBe(0);
    const wire = JSON.parse(await readFile(resultPath, "utf8")) as unknown;
    expect(stages.receipt.parse(wire)).toEqual({ pr: 7 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("releases the lock when command decoration throws before row execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "train-decoration-"));
  try {
    const row = JSON.stringify({ task: "custom", authorization: "fixture", scope: ["src"], environment: { checkout: root, repository: "owner/repo", baseBranch: "main", ciWorkflows: ["CI"] } });
    await mkdir(join(root, "queue"));
    await writeFile(join(root, "queue", "custom.json"), row);
    const preCheck = vi.fn(async () => "base");
    const command = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const failure = new Error("decorator construction failed");
    const stages: TrainStages = {
      command() { throw failure; }, preCheck, prompt: () => "prompt",
      receipt: { schema: {}, parse: () => ({ pr: 1 }) }, async verify() {},
    };
    const train = createTrain({ usage: async () => [], assistantText: () => undefined }, stages);
    await expect(train.runTrain(root, { command })).rejects.toBe(failure);
    await expect(readFile(join(root, ".lock"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, "queue", "custom.json"), "utf8")).toBe(row);
    expect(preCheck).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
    await writeFile(join(root, "STOP"), "");
    const retry = createTrain({ usage: async () => [], assistantText: () => undefined }, { ...stages, command: raw => raw });
    await expect(retry.runTrain(root, { command })).resolves.toBe("stopped");
  } finally { await rm(root, { recursive: true, force: true }); }
});
