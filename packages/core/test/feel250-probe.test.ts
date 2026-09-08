import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const source = fileURLToPath(new URL("../../../docs/plans/feel250-provider-omission-probe.mjs", import.meta.url));

function run(args: string[], mode: string) {
  const root = mkdtempSync(join(tmpdir(), "agentrig-feel250-probe-"));
  try {
    const scripts = join(root, "docs", "plans");
    const providers = join(root, "packages", "core", "dist", "providers");
    mkdirSync(scripts, { recursive: true });
    mkdirSync(providers, { recursive: true });
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    const script = join(scripts, "feel250-provider-omission-probe.mjs");
    copyFileSync(source, script);
    writeFileSync(join(providers, "openai-chatgpt.js"), `
      if (process.env.FEEL250_TEST_MODE === 'no-import') throw new Error('provider imported without opt-in');
      export class OpenAIChatGPTProvider {
        constructor(opts) { this.opts = opts; }
        async *stream() {
          globalThis.fetch = async (_url, init) => ({clone: () => ({text: async () => {
            if (process.env.FEEL250_TEST_MODE !== 'success') throw new Error('capture disconnected');
            const strict = JSON.parse(init.body).tools[0].strict !== false;
            return 'data: ' + JSON.stringify({type:'response.completed',response:{tools:[{
              name:'record_choice', strict, parameters:{required:strict?['task','label','provider']:['task']}
            }]}}) + '\\n';
          }})});
          await this.opts.fetchFn('https://inert.invalid', {body: JSON.stringify({tools:[{strict:false}]})});
          yield {type:'tool_use', name:'record_choice', input:{task:'probe',model:this.opts.model}};
          yield {type:'usage', usage:{input:7,output:3}};
          await new Promise(resolve => setTimeout(resolve, 20));
          if (process.env.FEEL250_TEST_MODE === 'both') throw new Error('stream disconnected');
          yield {type:'stop', reason:'tool_use'};
        }
      }
    `);
    return spawnSync(process.execPath, ["--unhandled-rejections=strict", script, ...args], {
      encoding: "utf8", timeout: 10_000,
      env: { ...process.env, FEEL250_TEST_MODE: mode, FEEL250_MODEL: "fixture-model" },
    });
  } finally {
    // spawnSync joins the child before fixture cleanup, including its failure path.
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

it.each([{ args: [] }, { args: ["--help"] }])("probe $args is offline before provider import", ({ args }) => {
  const result = run(args, "no-import");
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Usage:");
  expect(result.stderr).toBe("");
});

it.each(["capture-only", "both"])("probe retains structured evidence on %s failure", mode => {
  const result = run(["--live"], mode);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  const lines = result.stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  const record = JSON.parse(lines[0]!);
  expect(record).toMatchObject({
    mode: "omitted", model: "fixture-model", captureError: "Error: capture disconnected",
    toolCalls: [{ name: "record_choice", input: { task: "probe" } }],
    usage: [{ input: 7, output: 3 }],
  });
  if (mode === "both") expect(record.error).toBe("Error: stream disconnected");
  else expect(record).not.toHaveProperty("error");
  expect(result.stderr).toBe("");
});

it("probe replays both distinct wire controls and selected model without network", () => {
  const result = run(["--live"], "success");
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  const records = result.stdout.trim().split("\n").map(line => JSON.parse(line));
  expect(records).toHaveLength(2);
  expect(records.map(record => record.mode)).toEqual(["omitted", "false"]);
  expect(records.map(record => record.echoes[0].tools[0])).toEqual([
    { name: "record_choice", strict: true, required: ["task", "label", "provider"] },
    { name: "record_choice", strict: false, required: ["task"] },
  ]);
  for (const record of records) {
    expect(record.model).toBe("fixture-model");
    expect(record.toolCalls[0].input.model).toBe("fixture-model");
    expect(record).not.toHaveProperty("error");
    expect(record).not.toHaveProperty("captureError");
  }
});
