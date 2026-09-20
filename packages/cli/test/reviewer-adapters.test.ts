import { parseConfigText } from "../src/config.js";
import { expect, it } from "vitest";
// @ts-expect-error skill-side ESM adapter, intentionally outside the compiled CLI
import { cliAdapters, validateResult, runApi } from "../../../scripts/reviewer-adapters.mjs";
const cli = { adapter: "claude-cli", model: "pinned" };
it("CLI templates pin models and assertion sources", () => {
  for (const adapter of Object.values(cliAdapters) as Array<{template: string[]; modelSource: string}>) {
    expect(adapter.template).toContain("--model");
    expect(adapter.template).toContain("{model}");
    expect(adapter.modelSource).toBeTruthy();
  }
});
it("JSON assertion rejects failure, ambiguity and wrong pin; empty/failed outputs cannot pass", () => {
  const extract = (data: object) => cliAdapters["claude-cli"].extract(JSON.stringify(data));
  const good = { subtype: "success", modelUsage: { pinned: {} }, result: "VERDICT: PASS" };
  expect(validateResult(cli, extract(good), 0).model).toBe("pinned");
  for (const change of [{ is_error: true }, { subtype: "error" }, { modelUsage: {} }, { modelUsage: { a: {}, b: {} } }]) expect(() => extract({ ...good, ...change })).toThrow();
  for (const [model, text, status] of [["wrong", "PASS", 0], ["pinned", "", 0], ["pinned", "PASS", 1], ["pinned", "PASS", null]]) expect(() => validateResult(cli, { model, text }, status)).toThrow();
});
it.each(["", "model: \n", "model:\npinned\n", "model: pin extra\n", "model: pinned\nmodel: pinned\n", "model: a\nmodel: b\n"])("banner assertion fails closed: %j", banner => {
  expect(() => cliAdapters["codex-cli"].extract("", banner, "PASS")).toThrow();
});
it("banner extraction uses stderr, never verdict identity", () => {
  const result = cliAdapters["codex-cli"].extract("model: wrong", "banner\nmodel: pinned\n", "PASS");
  expect(validateResult(cli, result, 0)).toEqual({ model: "pinned", text: "PASS" });
});
it.each(["first", "second"])("API %s reuses provider entry and has no tools/check routing", async name => {
  const config = { providers: { first: { provider: "openai", model: "one", baseUrl: "https://first.example" }, second: { provider: "anthropic", model: "two" } } };
  const entry = config.providers[name as keyof typeof config.providers];
  const binding = { adapter: `api:${name}`, model: entry.model };
  const factory = (options: {providers: unknown; roles: object}, role: string) => {
    expect(options.providers).toBe(config.providers);
    expect(options.roles).toEqual({ main: name });
    expect(role).toBe("main");
    return { model: entry.model, async *stream(request: {tools: unknown[]}) {
      expect(request.tools).toEqual([]);
      yield { type: "text_delta", text: "VERDICT: PASS" };
      yield { type: "stop", reason: "end_turn" };
    } };
  };
  const result = await runApi(config, binding, "source bundle and conductor receipts", factory);
  expect(result.model).toBe(entry.model);
  expect(result.modelSource).toContain(`providers.${name}.model`);
  await expect(runApi(config, { ...binding, model: "wrong" }, "prompt", factory)).rejects.toThrow();
});
it.each(["max_tokens", "error", undefined])("API incomplete run %s fails closed", async reason => {
  await expect(runApi({ providers: { one: { model: "pinned" } } }, { adapter: "api:one", model: "pinned" }, "bundle", () => ({ model: "pinned", async *stream() { yield { type: "text_delta", text: "partial" }; yield { type: "stop", reason }; } }))).rejects.toThrow();
});

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const runner = fileURLToPath(new URL("../../../scripts/reviewer-adapters.mjs", import.meta.url));
it.each(["claude-cli", "codex-cli"])("%s launch template, raw provenance and stale-artifact refusal", adapter => {
  const dir = mkdtempSync(join(tmpdir(), "review-adapter-"));
  try {
    const command = adapter === "claude-cli" ? "claude" : "codex";
    const binary = join(dir, command);
    writeFileSync(binary, `#!${process.execPath}\nconst fs=require('node:fs'); fs.writeFileSync('${dir}/argv',JSON.stringify(process.argv.slice(2))); fs.writeFileSync('${dir}/env',JSON.stringify(process.env)); const prompt=fs.readFileSync(0,'utf8'); if(!prompt.includes('checks green')) process.exit(3); ${command === "claude" ? `console.log(JSON.stringify({subtype:'success',modelUsage:{pinned:{}},result:'VERDICT: PASS'}));` : `console.error('model: pinned'); fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message')+1], 'VERDICT: PASS');`}\n`);
    chmodSync(binary, 0o755);
    const config = join(dir, "config.json");
    writeFileSync(config, JSON.stringify({ reviewers: { custom: { adapter, model: "pinned" } } }));
    const prompt = join(dir, "prompt"); writeFileSync(prompt, "source bundle; checks green");
    const invoke = (prefix: string) => spawnSync(process.execPath, [runner, config, "custom", prompt, dir, prefix], { encoding: "utf8", env: { ...process.env, PATH: `${dirname(process.execPath)}:${dir}:${process.env.PATH}`, CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ID: "parent", CLAUDE_CODE_CHILD_SESSION: "child", CLAUDE_CODE_MESSAGING_SOCKET: "/parent/socket", CLAUDE_CODE_MESSAGING_TOKEN: "parent-token", CLAUDE_CODE_BRIDGE_SESSION_ID: "bridge", CLAUDE_PID: "12345", TMPDIR: dir, GIT_TRACE2_EVENT: "0", KEEP_REVIEW_ENV: "kept" } });
    const prefix = join(dir, "out");
    const run = invoke(prefix);
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "argv"), "utf8"))).toEqual(cliAdapters[adapter].template.map((value: string) => value.replace("{model}", "pinned").replace("{lastMessage}", `${prefix}.last`)));
    const childEnv = JSON.parse(readFileSync(join(dir, "env"), "utf8"));
    for (const name of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_BRIDGE_SESSION_ID", "CLAUDE_PID"]) expect(childEnv).not.toHaveProperty(name);
    expect(childEnv).toMatchObject({ PATH: `${dirname(process.execPath)}:${dir}:${process.env.PATH}`, TMPDIR: dir, GIT_TRACE2_EVENT: "0", KEEP_REVIEW_ENV: "kept" });
    const provenance = JSON.parse(readFileSync(`${prefix}.provenance.json`, "utf8"));
    expect(provenance).toMatchObject({ slot: "custom", adapter, model: "pinned", modelSource: cliAdapters[adapter].modelSource, cwd: dir, exit: 0 });
    expect(Date.parse(provenance.finished)).toBeGreaterThanOrEqual(Date.parse(provenance.started));
    expect(invoke(prefix).status).not.toBe(0);
    writeFileSync(binary, `#!${process.execPath}\nprocess.stdout.write('partial'); process.exit(1);\n`);
    const failed = join(dir, "failed");
    expect(invoke(failed).status).not.toBe(0);
    expect(existsSync(`${failed}.md`)).toBe(false);
    expect(existsSync(`${failed}.provenance.json`)).toBe(false);
    expect(readFileSync(`${failed}.stdout`, "utf8")).toBe("partial");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it("M-cap-bypass: capped API entries fail before provider construction with an actionable diagnostic", async () => {
  let constructed = false;
  const config = parseConfigText("fixture", JSON.stringify({ dailyCap: "5", providers: { capped: { provider: "openai", model: "pinned" } } }));
  await expect(runApi(config, { adapter: "api:capped", model: "pinned" }, "bundle", () => { constructed = true; throw new Error("factory reached"); })).rejects.toThrow(/dailyCap.*not supported.*uncapped/i);
  expect(constructed).toBe(false);
});
