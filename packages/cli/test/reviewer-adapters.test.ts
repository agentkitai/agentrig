import { parseConfigText } from "../src/config.js";
import { expect, it } from "vitest";
// @ts-expect-error skill-side ESM adapter, intentionally outside the compiled CLI
import { cliAdapters, validateResult, runApi, normalizeReviewerHead } from "../../../scripts/reviewer-adapters.mjs";
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

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const runner = fileURLToPath(new URL("../../../scripts/reviewer-adapters.mjs", import.meta.url));
const usage = "usage: reviewer-adapters.mjs <config> <slot> <prompt-file> <owned-worktree> <absolute-output-prefix>";
it("wrong argument count exits EX_USAGE before launch", () => {
  const run = spawnSync(process.execPath, [runner, "only-a-config"], { encoding: "utf8" });
  expect(run.status).toBe(64);
  expect(run.stderr.trim()).toBe(usage);
});
it("relative output prefix exits EX_USAGE before vendor launch and writes no stdout artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-adapter-usage-"));
  try {
    spawnSync("git", ["init", "-q", dir]);
    spawnSync("git", ["-C", dir, "-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "--allow-empty", "-qm", "fixture"]);
    const binary = join(dir, "codex");
    const launched = join(dir, "vendor-launched");
    writeFileSync(binary, `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(launched)}, "yes")`);
    chmodSync(binary, 0o755);
    const config = join(dir, "config.json");
    const prompt = join(dir, "prompt");
    writeFileSync(config, JSON.stringify({ reviewers: { Codex: { adapter: "codex-cli", model: "gpt-5.6-sol" } } }));
    writeFileSync(prompt, "review");
    const run = spawnSync(process.execPath, [runner, config, "Codex", prompt, dir, "relative-prefix"], { encoding: "utf8", cwd: dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
    expect(run.status).toBe(64);
    expect(run.stderr.trim()).toBe(usage);
    expect(existsSync(launched)).toBe(false);
    expect(existsSync(join(dir, "relative-prefix.stdout"))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it.each(["claude-cli", "codex-cli"])("%s launch template, raw provenance and stale-artifact refusal", adapter => {
  const dir = mkdtempSync(join(tmpdir(), "review-adapter-"));
  const home = mkdtempSync(join(tmpdir(), "review-user-"));
  try {
    mkdirSync(join(home, ".agentrig"));
    writeFileSync(join(home, ".agentrig/config.json"), JSON.stringify({ profiles: { personal: { childEnv: { CODEX_HOME: "/fixture/codex", CLAUDE_CONFIG_DIR: "/fixture/claude" } } } }));
    const command = adapter === "claude-cli" ? "claude" : "codex";
    const binary = join(dir, command);
    spawnSync("git", ["init", "-q", dir]);
    spawnSync("git", ["-C", dir, "-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "--allow-empty", "-qm", "PR source"]);
    const head = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], {encoding:"utf8"}).stdout.trim();
    // M-PR-adapter: a tooling-changing PR must not execute its own adapter.
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts/reviewer-adapters.mjs"), 'throw new Error("PR adapter executed");');
    const finding = {severity:"LOW", heading:"Suggested receipt cleanup", location:"scripts/reviewer-adapters.mjs:124", blocking:false, scenario:"A reviewer includes an extra repair hint."};
    const verdict = {version:1, reviewedHead:head, slot:"custom", assertedModel:"pinned", modelSource:"fixture transport", verdict:"PASS", findings:[finding]};
    const wireVerdict = {...verdict, findings:[{...finding, fix:"Keep only protocol fields.", rank:1}]};
    const reviewText = `I independently reviewed de6915934d1ae98650b04f721b5568c9b4c9cdf1..cb8e779dcee47694d70f98674de870a76bdb630e\n${preservedReviews[1]}\n<!-- agentrig-verdict:v1 -->\n${JSON.stringify(wireVerdict)}\n<!-- /agentrig-verdict -->`;
    writeFileSync(binary, `#!${process.execPath}\nconst fs=require('node:fs'); fs.writeFileSync('${dir}/argv',JSON.stringify(process.argv.slice(2))); fs.writeFileSync('${dir}/env',JSON.stringify(process.env)); const prompt=fs.readFileSync(0,'utf8'); if(!prompt.includes('checks green')) process.exit(3); ${command === "claude" ? `console.log(JSON.stringify({subtype:'success',modelUsage:{pinned:{}},result:${JSON.stringify(reviewText)}}));` : `console.error('model: pinned'); fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message')+1], ${JSON.stringify(reviewText)});`}\n`);
    chmodSync(binary, 0o755);
    const config = join(dir, "config.json");
    writeFileSync(config, JSON.stringify({ reviewers: { custom: { adapter, model: "pinned" } } }));
    const prompt = join(dir, "prompt"); writeFileSync(prompt, "source bundle; checks green");
    const invoke = (prefix: string) => spawnSync(process.execPath, [runner, config, "custom", prompt, dir, prefix, "--profile", "personal"], { encoding: "utf8", env: { ...process.env, PATH: `${dirname(process.execPath)}:${dir}:${process.env.PATH}`, HOME: home, CODEX_HOME: "/wrong-shell", CLAUDE_CONFIG_DIR: "/wrong-shell", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ID: "parent", CLAUDE_CODE_CHILD_SESSION: "child", CLAUDE_CODE_MESSAGING_SOCKET: "/parent/socket", CLAUDE_CODE_MESSAGING_TOKEN: "parent-token", CLAUDE_CODE_BRIDGE_SESSION_ID: "bridge", CLAUDE_PID: "12345", TMPDIR: dir, GIT_TRACE2_EVENT: "0", KEEP_REVIEW_ENV: "kept" } });
    const prefix = join(dir, "out");
    const run = invoke(prefix);
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "argv"), "utf8"))).toEqual(cliAdapters[adapter].template.map((value: string) => value.replace("{model}", "pinned").replace("{lastMessage}", `${prefix}.last`)));
    const childEnv = JSON.parse(readFileSync(join(dir, "env"), "utf8"));
    for (const name of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_BRIDGE_SESSION_ID", "CLAUDE_PID"]) expect(childEnv).not.toHaveProperty(name);
    expect(childEnv).toMatchObject({ CODEX_HOME: "/fixture/codex", CLAUDE_CONFIG_DIR: "/fixture/claude", PATH: `${dirname(process.execPath)}:${dir}:${process.env.PATH}`, TMPDIR: dir, GIT_TRACE2_EVENT: "0", KEEP_REVIEW_ENV: "kept" });
    const provenance = JSON.parse(readFileSync(`${prefix}.provenance.json`, "utf8"));
    expect(provenance).toMatchObject({ resolvedHome: adapter === "codex-cli" ? "/fixture/codex" : "/fixture/claude", slot: "custom", adapter, model: "pinned", modelSource: cliAdapters[adapter].modelSource, cwd: dir, exit: 0 });
    expect(provenance.verdict).toEqual(verdict);
    expect(provenance.ignoredKeys).toEqual([{findingIndex:0, keys:["fix", "rank"]}]);
    expect(JSON.parse(readFileSync(`${prefix}.verdict.json`, "utf8"))).toEqual(verdict);
    expect(readFileSync(`${prefix}.md`, "utf8")).toBe(reviewText);
    expect(adapter === "claude-cli" ? JSON.parse(readFileSync(`${prefix}.stdout`, "utf8")).result : readFileSync(`${prefix}.last`, "utf8")).toBe(reviewText);
    expect(Date.parse(provenance.finished)).toBeGreaterThanOrEqual(Date.parse(provenance.started));
    expect(invoke(prefix).status).not.toBe(0);
    writeFileSync(binary, `#!${process.execPath}\nprocess.stdout.write('partial'); process.exit(1);\n`);
    const failed = join(dir, "failed");
    expect(invoke(failed).status).not.toBe(0);
    expect(existsSync(`${failed}.md`)).toBe(false);
    expect(existsSync(`${failed}.provenance.json`)).toBe(false);
    expect(readFileSync(`${failed}.stdout`, "utf8")).toBe("partial");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
}, 30_000);
it("M-cap-bypass: capped API entries fail before provider construction with an actionable diagnostic", async () => {
  let constructed = false;
  const config = parseConfigText("fixture", JSON.stringify({ dailyCap: "5", providers: { capped: { provider: "openai", model: "pinned" } } }));
  await expect(runApi(config, { adapter: "api:capped", model: "pinned" }, "bundle", () => { constructed = true; throw new Error("factory reached"); })).rejects.toThrow(/dailyCap.*not supported.*uncapped/i);
  expect(constructed).toBe(false);
});

// Preserved PR455 outputs are replayed verbatim; neither expected head nor prompts
// are supplied to the normalizer, so it cannot manufacture a binding.
import { preservedReviews } from "./preserved-review-455.js";
// @ts-expect-error standalone ESM tooling
import { reviewerVerdict } from "../../../scripts/review-finding-index.mjs";
it.each(["LF", "CRLF"])("preserved PR455 extraction, lossless suffix and provenance (%s)", eol => {
  for (const [i, original] of preservedReviews.entries()) {
    const raw = eol === "CRLF" ? original.replaceAll("\n", "\r\n") : original;
    const normalized = normalizeReviewerHead(raw);
    expect(normalized.text.split(/\r?\n/)[0]).toBe("Reviewed head: a45dc1f93db4a581371d0b94f0e7e518347fd890");
    expect(normalized.tolerances).toEqual([i ? "leading-cleanup-status" : "missing-head-colon"]);
    const start = raw.indexOf("Reviewed head");
    expect(normalized.text.slice(normalized.text.indexOf("\n"))).toBe(raw.slice(raw.indexOf("\n", start)));
    expect(reviewerVerdict(JSON.stringify({ type: "result", subtype: "success", modelUsage: { pinned: {} }, result: raw }), "claude-cli")).toBe(normalized.text);
  }
});
it.each([
  `Status commit ${"a".repeat(40)}\n`,
  `Reviewed at ${"b".repeat(40)}\n`,
  "# Review\n", "> ", "```text\n", "\n",
  "Review completeX Tree restored to the exact reviewed head with a clean tracked/index state, no background jobs outstanding.\n",
])("M-skip-first-sha: never skip arbitrary prefix %s", prefix => {
  const raw = `${prefix}Reviewed head: ${"a".repeat(40)}\nVERDICT: PASS\n`;
  expect(normalizeReviewerHead(raw)).toEqual({ text: raw, tolerances: [] });
});
it("M-overlong-head: no partial-token normalization", () => {
  const raw = `Reviewed head ${"a".repeat(41)}\nVERDICT: PASS\n`;
  expect(normalizeReviewerHead(raw)).toEqual({ text: raw, tolerances: [] });
});

it.each(["codex-cli", "claude-cli"])("M-adapter-home: %s refuses missing home before spawning or writing", adapter => {
  const dir = mkdtempSync(join(tmpdir(), "review-home-"));
  try {
    const config = join(dir, "config.json"), prompt = join(dir, "prompt"), prefix = join(dir, "out");
    writeFileSync(config, JSON.stringify({ reviewers: { Personal: { adapter, model: "pin" } } }));
    writeFileSync(prompt, "review");
    const env = { ...process.env, HOME: dir };
    delete env.CODEX_HOME; delete env.CLAUDE_CONFIG_DIR; delete env.AGENTRIG_CHILD_PROFILE;
    const run = spawnSync(process.execPath, ["scripts/reviewer-adapters.mjs", config, "Personal", prompt, dir, prefix], { env, encoding: "utf8" });
    expect(run.status).toBe(64);
    expect(run.stderr).toContain("REVIEWER_HOME_MISSING: reviewers:Personal");
    expect(existsSync(`${prefix}.stdout`)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("M-A3-invalid-profile: pre-launch profile errors use configuration exit 64", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-profile-"));
  try {
    writeFileSync(join(dir, "config"), JSON.stringify({ reviewers: { Personal: { adapter: "codex-cli", model: "pin" } } }));
    writeFileSync(join(dir, "prompt"), "review");
    const env = { ...process.env, HOME: dir, CODEX_HOME: dir, AGENTRIG_CHILD_PROFILE: "typo" };
    const run = spawnSync(process.execPath, ["scripts/reviewer-adapters.mjs", join(dir, "config"), "Personal", join(dir, "prompt"), dir, join(dir, "out")], { env, encoding: "utf8" });
    expect(run.status).toBe(64);
    expect(run.stderr).toContain("unknown config profile");
    expect(existsSync(join(dir, "out.stdout"))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
