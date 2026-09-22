import { expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
// @ts-expect-error standalone base tooling
import { parseVerdict, verdictPrompt, receiptTransport } from "../../../scripts/review-verdict.mjs";
const head = "a".repeat(40);
const block = (assertedModel: string) => `<!-- agentrig-verdict:v1 -->\n${JSON.stringify({ version: 1, reviewedHead: head, slot: "Codex", assertedModel, modelSource: "system identity", verdict: "PASS", findings: [] })}\n<!-- /agentrig-verdict -->`;
it("M-no-family: family assertion needs exact independent transport; preserves assertion", () => {
  expect(parseVerdict(block("gpt-5"), { assertedModel: "gpt-5.5", transportModel: "gpt-5.5" }).assertedModel).toBe("gpt-5");
});
it.each([undefined, "gpt-5", "gpt-5.4"])("M-no-transport: family with transport %s fails", transportModel => {
  expect(() => parseVerdict(block("gpt-5"), { assertedModel: "gpt-5.5", transportModel })).toThrow(/assertedModel mismatch/);
});
it.each(["gpt-4.1", "claude-opus-5", "gpt-5.4", "gpt-5.5-extra", "GPT-5"])("M-any-family: %s cannot stand in for pinned model", asserted => {
  expect(() => parseVerdict(block(asserted), { assertedModel: "gpt-5.5", transportModel: "gpt-5.5" })).toThrow(/assertedModel mismatch/);
});
it("model prompt supplies pin and transport source without overriding conflicting identity", () => {
  const prompt = verdictPrompt({ reviewedHead: head, slot: "Codex", assertedModel: "gpt-5.5", modelSource: "stderr banner model: line (exactly one)" });
  expect(prompt).toContain("gpt-5.5");
  expect(prompt).toContain("stderr banner model: line (exactly one)");
  expect(prompt).toContain("unless your own identity contradicts the family");
});
it.each(["gpt-5", "gpt-4.1", "claude-opus-5"])("adapter transport and receipt integration: %s", asserted => {
  const dir = mkdtempSync(join(tmpdir(), "model-assertion-"));
  try {
    const git = (...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    expect(git("init", "-q").status).toBe(0);
    expect(git("-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "--allow-empty", "-qm", "fixture").status).toBe(0);
    const actualHead = git("rev-parse", "HEAD").stdout.trim();
    const text = block(asserted).replace(head, actualHead);
    const binary = join(dir, "codex");
    writeFileSync(binary, `#!${process.execPath}\nconst fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(join(dir, "prompt-seen"))},fs.readFileSync(0,'utf8')); console.error('model: gpt-5.5'); fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message')+1],${JSON.stringify(text)});`);
    chmodSync(binary, 0o755);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ reviewers: { Codex: { adapter: "codex-cli", model: "gpt-5.5" } } }));
    writeFileSync(join(dir, "prompt"), "source bundle and checks green");
    const prefix = join(dir, "out");
    const runner = fileURLToPath(new URL("../../../scripts/reviewer-adapters.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [runner, join(dir, "config.json"), "Codex", join(dir, "prompt"), dir, prefix], { encoding: "utf8", env: { ...process.env, PATH: `${dirname(process.execPath)}:${dir}:${process.env.PATH}`, GIT_TRACE2_EVENT: "0" } });
    if (asserted !== "gpt-5") {
      expect(result.status).not.toBe(0);
      expect(existsSync(`${prefix}.provenance.json`)).toBe(false);
    } else {
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(`${prefix}.provenance.json`, "utf8"))).toMatchObject({ assertedModel: "gpt-5", transportModel: "gpt-5.5", model: "gpt-5.5", verdict: { assertedModel: "gpt-5" } });
      expect(readFileSync(`${prefix}.md`, "utf8")).toBe(text);
      expect(readFileSync(`${prefix}.model.txt`, "utf8")).toBe("gpt-5.5\n");
      expect(readFileSync(join(dir, "prompt-seen"), "utf8")).toContain("gpt-5.5");
      const index = fileURLToPath(new URL("../../../scripts/review-finding-index.mjs", import.meta.url));
      const args = [index, "--validate", `${prefix}.md`, actualHead, "Codex", "gpt-5.5"];
      expect(spawnSync(process.execPath, args).status).not.toBe(0);
      expect(spawnSync(process.execPath, [...args, `${prefix}.provenance.json`]).status).toBe(0);
      writeFileSync(join(dir, "gh"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(dir, "gh"), 0o755);
      const post = fileURLToPath(new URL("../../../scripts/post-review-comment.mjs", import.meta.url));
      const postArgs = [post, "123", "Codex", `${prefix}.model.txt`, `${prefix}.md`, actualHead, actualHead, `${prefix}.comment.md`, "--config", join(dir, "config.json")];
      const options = { encoding: "utf8" as const, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GIT_TRACE2_EVENT: "0" } };
      expect(spawnSync(process.execPath, postArgs, options).status).not.toBe(0);
      const posted = spawnSync(process.execPath, [...postArgs, "--provenance", `${prefix}.provenance.json`], options);
      expect(posted.status, posted.stderr).toBe(0);
      expect(readFileSync(`${prefix}.comment.md`, "utf8")).toContain("Codex (gpt-5.5)");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each(["exit", "reviewedHead", "slot", "model", "transportModel", "assertedModel", "verdict", "adapter"])("M-unbound-receipt: rejects mismatched %s", key => {
  const verdict = parseVerdict(block("gpt-5"));
  const expected = { reviewedHead:head, slot:"Codex", assertedModel:"gpt-5.5" };
  const receipt = { exit:0, reviewedHead:head, slot:"Codex", model:"gpt-5.5", transportModel:"gpt-5.5", assertedModel:"gpt-5", verdict, adapter:"codex-cli" };
  expect(receiptTransport(receipt, expected, verdict, "codex-cli")).toBe("gpt-5.5");
  expect(() => receiptTransport({ ...receipt, [key]: "wrong" }, expected, verdict, "codex-cli")).toThrow(/provenance binding mismatch/);
});
it("reviewer-authored transport field is not adapter evidence", () => {
  const verdict = parseVerdict(block("gpt-5"));
  expect(() => parseVerdict(`<!-- agentrig-verdict:v1 -->\n${JSON.stringify({ ...verdict, transportModel:"gpt-5.5" })}\n<!-- /agentrig-verdict -->`, { assertedModel:"gpt-5.5" })).toThrow();
});
