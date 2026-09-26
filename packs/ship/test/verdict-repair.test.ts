import { expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error standalone helper
import { parseVerdict, verdictBlock, verdictPrompt } from "../../../scripts/review-verdict.mjs";
// @ts-expect-error standalone helper
import { findingIndex } from "../../../scripts/review-finding-index.mjs";
const script = (name: string) => fileURLToPath(new URL(`../../../scripts/${name}.mjs`, import.meta.url));
const binding = { reviewedHead: "a".repeat(40), assertedModel: "pinned", slot: "Codex", modelSource: "fixture" };
const valid = { version: 1, ...binding, verdict: "PASS", findings: [] };
it("C-F1 exact generated prompt echo fails schema", () => {
  expect(() => parseVerdict(verdictPrompt(binding), binding)).toThrow();
});
it("the verdict prompt shows the exact finding object shape once and states blocking is a boolean", () => {
  const prompt = verdictPrompt(binding);
  const shape = '{"severity":"<CRITICAL|HIGH|MEDIUM|LOW>","heading":"<exact verbatim heading>","location":"<file:line>","blocking":<true|false>,"scenario":"<concrete failure scenario>"}';
  expect(prompt.split(shape)).toHaveLength(2);
  expect(prompt).toContain(`Use this exact finding object shape once per finding, with no other keys: ${shape}.`);
  expect(prompt).toContain("The `blocking` field is a boolean.");
});
it("C-F1 real adapter and posting reject exact prompt echo without gh", () => {
  const dir = mkdtempSync(join(tmpdir(), "echo-review-"));
  try {
    mkdirSync(join(dir, "codex-home"));
    writeFileSync(join(dir, "codex-home", "auth.json"), "{}");
    const env = { ...process.env, HOME: dir, AGENTRIG_CHILD_PROFILE: undefined, AGENTRIG_REVIEW_REPOSITORY: "owner/repo", AGENTRIG_REVIEW_PR: "547", AGENTRIG_REVIEW_PASS: "initial", CODEX_HOME: join(dir, "codex-home"), PATH: `${dir}:${process.env.PATH}` };
    const run = (name: string, args: string[]) => spawnSync(process.execPath, [script(name), ...args], { cwd: dir, env, encoding: "utf8" });
    spawnSync("git", ["init", "-q", dir]);
    spawnSync("git", ["-C", dir, "-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "--allow-empty", "-qm", "fixture"]);
    const head = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(join(dir, "config"), JSON.stringify({ reviewers: { Codex: { adapter: "codex-cli", model: "pinned" } } }));
    writeFileSync(join(dir, "prompt"), "Review this change independently.");
    writeFileSync(join(dir, "codex"), `#!${process.execPath}\nconst fs=require('node:fs'); const p=fs.readFileSync(0,'utf8'); fs.writeFileSync('echo',p); fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message')+1],p); console.error('model: pinned');`);
    writeFileSync(join(dir, "gh"), `#!${process.execPath}\nrequire('node:fs').writeFileSync('gh-called','yes');`);
    for (const name of ["codex", "gh"]) chmodSync(join(dir, name), 0o755);
    const adapter = run("reviewer-adapters", [join(dir, "config"), "Codex", join(dir, "prompt"), dir, join(dir, "out")]);
    const echo = readFileSync(join(dir, "echo"), "utf8");
    expect(echo).toBe(`Review this change independently.\n\n${verdictPrompt({ ...binding, reviewedHead: head, modelSource: "stderr banner model: line (exactly one)" })}`);
    writeFileSync(join(dir, "model"), "pinned");
    const post = run("post-review-comment", ["489", "Codex", join(dir, "model"), join(dir, "echo"), head, binding.reviewedHead, join(dir, "posted"), "--config", join(dir, "config")]);
    expect.soft(adapter.status, adapter.stderr).not.toBe(0);
    expect.soft(existsSync(join(dir, "out.verdict.json"))).toBe(false);
    expect.soft(post.status, post.stderr).not.toBe(0);
    expect.soft(existsSync(join(dir, "gh-called"))).toBe(false);
    expect.soft(existsSync(join(dir, "posted.receipt.json"))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it.each(["\n", "\r\n"])("C-F2 live index warns for every omitted heading and conflicting verdict (%j)", eol => {
  const headings = ["### HIGH: Unsanitized tool emit reaches the event log", "F2: [MEDIUM] Another omitted finding", "### HIGH unsupported opening"];
  const body = ["**Verdict: FAIL** — blocking findings", ...headings, verdictBlock(valid)].join(eol);
  const url = "https://github.com/agentkitai/agentrig/pull/489#issuecomment-1";
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(findingIndex(url, { html_url: url, body })).toEqual([]);
    const logs = warn.mock.calls.flat().join("\n");
    for (const line of ["**Verdict: FAIL** — blocking findings", ...headings]) expect(logs).toContain(line);
    expect(warn).toHaveBeenCalledTimes(4);
    expect(logs).toContain("nonfatal");
  } finally { warn.mockRestore(); }
});
it("C-F2 schema stays authoritative; matched headings and code/data do not warn", () => {
  const heading = "### HIGH: Genuine supported finding";
  const finding = { heading, severity: "HIGH", location: "file.ts:1", blocking: true, scenario: "Failure" };
  const body = ["VERDICT: FAIL", heading, "```text", "### HIGH: fenced example", "VERDICT: PASS", "```", "> ### HIGH: quoted example", "    ### HIGH: indented code", "    VERDICT: PASS", "`VERDICT: PASS`", verdictBlock({ ...valid, verdict: "FAIL", findings: [finding] })].join("\n");
  const url = "https://github.com/agentkitai/agentrig/pull/489#issuecomment-1";
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(findingIndex(url, { html_url: url, body })).toEqual([{ comment: url, heading }]);
    expect(warn).not.toHaveBeenCalled();
  } finally { warn.mockRestore(); }
});
