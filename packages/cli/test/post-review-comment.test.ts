import { readSkillText } from "../../../test/skill-text.js";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
// @ts-expect-error standalone helper
import { findingIndex } from "../../../scripts/review-finding-index.mjs";

function fixtureConfig(dir: string) {
  mkdirSync(join(dir, ".agentrig"), { recursive: true });
  writeFileSync(join(dir, "large-ledger"), "Conductor ledger: lossless Unicode and multi-chunk fixture evidence requires this size.");
  writeFileSync(join(dir, ".agentrig/config.json"), JSON.stringify({ reviewers: { Codex: { adapter: "codex-cli", model: "gpt-5.5" }, "Claude Code": { adapter: "claude-cli", model: "claude-opus-5" } } }));
}
const helper = fileURLToPath(new URL("../../../scripts/post-review-comment.mjs", import.meta.url));
const head = "a".repeat(40), main = "b".repeat(40);
const heading = `## External review — Codex (gpt-5.5) — head ${head} — merged with origin/main ${main} — full`;
function run(body: string, model = "gpt-5.5\n", sha = head, base = main, source?: string, damage = false, ghExit = 0, reviewer = "Codex", reviewers?: object, sizeReason?: string) {
  const dir = mkdtempSync(join(tmpdir(), "post-review-"));
  fixtureConfig(dir);
  if (sizeReason !== undefined) writeFileSync(join(dir, "size-ledger"), sizeReason);
  if (reviewers) writeFileSync(join(dir, ".agentrig/config.json"), JSON.stringify({ reviewers }));
  try {
    writeFileSync(join(dir, "body"), body);
    writeFileSync(join(dir, "model"), model);
    writeFileSync(join(dir, "gh"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${dir}/args'\ncat "$5" > '${dir}/posted'\nexit ${ghExit}\n`);
    chmodSync(join(dir, "gh"), 0o755);
    if (damage) {
      writeFileSync(join(dir, "head"), "#!/bin/sh\nprintf 'damaged\\n'\n");
      chmodSync(join(dir, "head"), 0o755);
    }
    if (source !== undefined) writeFileSync(join(dir, "helper.mjs"), source.replaceAll('"./review-finding-index.mjs"', JSON.stringify(new URL("../../../scripts/review-finding-index.mjs", import.meta.url).href)));
    const result = spawnSync(process.execPath, [source === undefined ? helper : join(dir, "helper.mjs"), "372", reviewer, join(dir, "model"), join(dir, "body"), sha, base, join(dir, "comment")], {
      cwd: dir, encoding: "utf8", env: { ...process.env, REVIEW_LARGE_BODY_LEDGER: sizeReason === undefined ? "" : join(dir, "size-ledger"), PATH: `${dir}:${process.env.PATH}` },
    });
    return { status: result.status, stderr: result.stderr,
      posts: Array.from({ length: 20 }, (_, i) => join(dir, `comment.${i + 1}`)).filter(existsSync).map(p => readFileSync(p, "utf8")),
      receipt: existsSync(join(dir, "comment.receipt.json")) ? readFileSync(join(dir, "comment.receipt.json"), "utf8") : "",
      posted: existsSync(join(dir, "posted")) ? readFileSync(join(dir, "posted"), "utf8") : undefined,
      args: existsSync(join(dir, "args")) ? readFileSync(join(dir, "args"), "utf8") : undefined };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const regression = `\n\n## External review — Codex (GPT-5) — head \`${head}\` — merged with origin/main \`${main}\` — full\n\n## External review — duplicate\n\nVERDICT: PASS\nReviewed head ${head}\n`;
it("M1/M2 #370 replaces backticked SHAs and generic GPT-5 with model-file gpt-5.5", () => {
  const result = run(regression);
  expect(result.status, result.stderr).toBe(0);
  expect(result.posted).toBe(`${heading}\n\nVERDICT: PASS\nReviewed head ${head}\n`);
  expect(result.args).toMatch(/^pr\ncomment\n372\n--body-file\n[^\n]+\n$/);
});
it.each(["verdict\n", "\n\nverdict\n", "\r\n \t\r\n## External review — old\r\n\r\nverdict\n"])("normalizes leading blanks/headings: %j", body => {
  expect(run(body).posted).toBe(`${heading}\n\nverdict\n`);
});
it("preserves non-leading headings inside the review", () => {
  const body = "verdict\n\n## External review — quoted later\nfindings\n";
  expect(run(body).posted).toBe(`${heading}\n\n${body}`);
});
it.each([
  ["empty model", "verdict", " \n", head, main],
  ["multiline model", "verdict", "gpt-5.5\ngpt-5", head, main],
  ["invalid head", "verdict", "gpt-5.5", "`" + head + "`", main],
  ["newline head", "verdict", "gpt-5.5", head + "\n", main],
  ["short head", "verdict", "gpt-5.5", head.slice(0, 7), main],
  ["invalid main", "verdict", "gpt-5.5", head, "x".repeat(40)],
  ["empty body", " \n", "gpt-5.5", head, main],
  ["heading-only body", "## External review — old\n\n", "gpt-5.5", head, main],
])("M3/M4 fails closed without gh: %s", (_name, body, model, sha, base) => {
  const result = run(body!, model!, sha!, base!);
  expect(result.status).not.toBe(0);
  expect(result.args).toBeUndefined();
});
it("M5 exact head -1 assertion runs before gh", () => {
  const result = run("verdict", undefined, undefined, undefined, undefined, true);
  expect(result.status).not.toBe(0);
  expect(result.args).toBeUndefined();
});
it("uses the Claude model file without guessing from verdict", () => {
  const result = run(regression, "claude-opus-5", undefined, undefined, undefined, false, 0, "Claude Code");
  expect(result.status).toBe(0);
  expect(result.posted?.split("\n")[0]).toBe(heading.replace("Codex (gpt-5.5)", "Claude Code (claude-opus-5)"));
});
it("propagates posting failure", () => expect(run("verdict", undefined, undefined, undefined, undefined, false, 7).status).toBe(7));

it.each([
  ["M1 quoted SHA", '— head ${head} —', '— head \\`${head}\\` —'],
  ["M2 guessed model", 'const model = readFileSync(modelFile, "utf8").trim();', 'const model = "GPT-5";'],
  ["M6 no stripping", 'const body = raw.replace(/^(?:[ \\t]*\\r?\\n|## External review[^\\n]*(?:\\n|$))*/, "");', 'const body = raw;'],
])("kills %s on #370 regression", (_name, before, after) => {
  const source = readFileSync(helper, "utf8");
  expect(source).toContain(before);
  const mutant = run(regression, undefined, undefined, undefined, source.replace(before, after));
  expect(mutant.posted).not.toBe(`${heading}\n\nVERDICT: PASS\nReviewed head ${head}\n`);
});

it.each([
  ["M3 model guard", 'if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model)) throw new Error("empty or invalid model file");', "verdict", "", head, main, false],
  ["M4 head guard", 'if (![head, main].every(sha => sha.length === 40 && /^[a-fA-F0-9]{40}$/.test(sha))) throw new Error("HEAD and MAIN must be unquoted 40-hex SHAs");', "verdict", "gpt-5.5", "bad", main, false],
  ["M4 main guard", 'if (![head, main].every(sha => sha.length === 40 && /^[a-fA-F0-9]{40}$/.test(sha))) throw new Error("HEAD and MAIN must be unquoted 40-hex SHAs");', "verdict", "gpt-5.5", head, "bad", false],
  ["M4 empty body guard", 'if (!body.trim()) throw new Error("empty reviewer body");', "", "gpt-5.5", head, main, false],
  ["M5 first-line guard", 'if (first.status !== 0 || first.stdout !== `${heading}\n`) throw new Error("canonical first-line assertion failed");'.replace('${heading}\n', '${heading}\\n'), "verdict", "gpt-5.5", head, main, true],
] as const)("kills %s: missing gate permits forbidden gh call", (_name, gate, body, model, sha, base, damage) => {
  const source = readFileSync(helper, "utf8");
  expect(source).toContain(gate);
  expect(run(body, model, sha, base, undefined, damage).args).toBeUndefined();
  expect(run(body, model, sha, base, source.replace(gate, "").replace(_name === "M3 model guard" ? 'if (model !== slots[reviewer].model) throw new Error("asserted model differs from slot pin");' : "NEVER", ""), damage).args).toBeDefined();
});

it.each(["topic", "ship", "dogfood"])("M7 %s delegates canonical composition", skill => {
  const text = readSkillText(new URL(`../../../.agentrig/skills/${skill}/SKILL.md`, import.meta.url), "utf8");
  expect(text).toContain("scripts/post-review-comment.mjs");
  expect(text).not.toContain("CLAUDE_HEADING=");
  expect(text).toContain("head -1");
});
it("declared custom slot is accepted; zero slots, undeclared name and pin mismatch fail closed", () => {
  const custom = { "Peer A": { adapter: "api:existing", model: "gpt-5.5" } };
  const accepted = run("PASS", "gpt-5.5", head, main, undefined, false, 0, "Peer A", custom);
  expect(accepted.status, accepted.stderr).toBe(0);
  expect(accepted.posted).toContain("## External review — Peer A (gpt-5.5)");
  for (const [slot, model, declaration] of [["Peer A", "wrong", custom], ["Codex", "gpt-5.5", custom], ["Peer A", "gpt-5.5", {}]] as const) {
    const result = run("PASS", model, head, main, undefined, false, 0, slot, declaration);
    expect(result.status).not.toBe(0);
    expect(result.args).toBeUndefined();
  }
});

it("B2 splits long review plus proof into bounded lossless canonical comments", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-chunks-"));
  fixtureConfig(dir);
  try {
    // Six-digit payload length reserves the actual marker width. The first
    // nominal cut is deliberately between the emoji's UTF-16 surrogates.
    const capacity = 60000 - heading.length - 2 - (2 * 6 + 7);
    const body = "X".repeat(capacity - 1) + "😀".repeat(5000) + "Y".repeat(200000);
    const proof = "PROOF\n" + "evidence\n".repeat(9000);
    expect(String(`${body}\n${proof}`.length).length).toBe(6);
    expect(/[\uD800-\uDBFF]/.test(body[capacity - 1]!)).toBe(true);
    expect(/[\uDC00-\uDFFF]/.test(body[capacity]!)).toBe(true);
    writeFileSync(join(dir, "body"), body);
    writeFileSync(join(dir, "proof"), proof);
    writeFileSync(join(dir, "model"), "gpt-5.5");
    writeFileSync(join(dir, "gh"), `#!/bin/sh\nnode -e 'const fs=require("fs");fs.appendFileSync("${dir}/posts",JSON.stringify(fs.readFileSync(process.argv[1],"utf8"))+"\\n")' "$5"\n`);
    chmodSync(join(dir, "gh"), 0o755);
    const result = spawnSync(process.execPath, [helper, "372", "Codex", join(dir,"model"), join(dir,"body"), head, main, join(dir,"comment"), join(dir,"proof")], {cwd: dir, encoding:"utf8", env:{...process.env, REVIEW_LARGE_BODY_LEDGER:join(dir,"large-ledger"), PATH:`${dir}:${process.env.PATH}`}});
    expect(result.status, result.stderr).toBe(0);
    const posts = readFileSync(join(dir,"posts"),"utf8").trim().split("\n").map(s => JSON.parse(s) as string);
    expect(posts.length).toBeGreaterThan(1);
    const restored = posts.map((post, i) => {
      expect(post.length).toBeLessThanOrEqual(60000);
      const prefix = `${heading}\n\n(${i+1}/${posts.length})\n\n`;
      expect(post.startsWith(prefix)).toBe(true);
      if (i === 0) expect(post.length - prefix.length).toBe(capacity - 1);
      return post.slice(prefix.length);
    }).join("");
    expect(restored).not.toContain("\uFFFD");
    expect(restored).toBe(`${body}\n${proof}`);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

 it("R379 records partial indices and refuses rerun even when gh would now succeed", () => {
  const dir = mkdtempSync(join(tmpdir(), "partial-review-"));
  fixtureConfig(dir);
  try {
    writeFileSync(join(dir, "body"), "X".repeat(200000));
    writeFileSync(join(dir, "model"), "gpt-5.5");
    writeFileSync(join(dir, "gh"), `#!/bin/sh
printf '%s\\n' "$5" >> '${dir}/attempts'
case "$5" in *.2) exit 7;; esac
exit 0
`);
    chmodSync(join(dir, "gh"), 0o755);
    const invoke = () => spawnSync(process.execPath, [helper, "372", "Codex", join(dir,"model"), join(dir,"body"), head, main, join(dir,"comment")], {cwd: dir, encoding:"utf8", env:{...process.env, REVIEW_LARGE_BODY_LEDGER:join(dir,"large-ledger"), PATH:`${dir}:${process.env.PATH}`}});
    const first = invoke();
    expect(first.status).toBe(7);
    expect(first.stderr).toContain("partial post: 1/4; successful chunk indices [1]");
    const receiptPath = join(dir, "comment.receipt.json");
    const receipt = readFileSync(receiptPath, "utf8");
    expect(JSON.parse(receipt)).toMatchObject({ pr: "372", heading, total: 4, successful: [1], pending: 2, status: "failed" });
    const attempts = readFileSync(join(dir, "attempts"), "utf8");
    expect(attempts.trim().split("\n")).toEqual([join(dir,"comment.1"), join(dir,"comment.2")]);
    writeFileSync(join(dir, "gh"), `#!/bin/sh\nprintf 'unexpected retry' >> '${dir}/attempts'\nexit 0\n`);
    const retry = invoke();
    expect(retry.status).not.toBe(0);
    expect(retry.stderr).toContain("refusing rerun");
    expect(retry.stderr).toContain(receiptPath);
    expect(retry.stderr).toContain(receipt.trim());
    expect(readFileSync(receiptPath, "utf8")).toBe(receipt);
    expect(readFileSync(join(dir,"attempts"),"utf8")).toBe(attempts);
  } finally { rmSync(dir, {recursive:true, force:true}); }
});


it.each(["complete", "unattempted", "interrupted"])("R379 atomic receipt and safe %s refusal", state => {
  const dir = mkdtempSync(join(tmpdir(), "receipt-state-"));
  fixtureConfig(dir);
  try {
    writeFileSync(join(dir, "body"), "verdict");
    writeFileSync(join(dir, "model"), "gpt-5.5");
    writeFileSync(join(dir, "gh"), `#!/bin/sh\nprintf 'post\\n' >> '${dir}/attempts'\n`);
    chmodSync(join(dir, "gh"), 0o755);
    if (state === "unattempted") {
      writeFileSync(join(dir, "head"), "#!/bin/sh\nexit 1\n");
      chmodSync(join(dir, "head"), 0o755);
    }
    // Interrupt the successful-result save after truncating its write target.
    // R379-nonatomic-save loses the receipt; atomic replacement retains pending=1.
    writeFileSync(join(dir, "interrupt.cjs"), `
const fs = require('node:fs');
const original = fs.writeFileSync;
let writes = 0;
fs.writeFileSync = function(path, ...args) {
  if (String(path).includes('receipt.json') && ++writes === 3) {
    original(path, '{');
    throw new Error('injected interrupted receipt write');
  }
  return original(path, ...args);
};
require('node:module').syncBuiltinESMExports();
`);
    const invoke = (interrupt = false) => spawnSync(process.execPath,
      [...(interrupt ? ["--require", join(dir, "interrupt.cjs")] : []), helper, "372", "Codex", join(dir, "model"), join(dir, "body"), head, main, join(dir, "comment")],
      { cwd: dir, encoding: "utf8", env: { ...process.env, REVIEW_LARGE_BODY_LEDGER: join(dir, "large-ledger"), PATH: `${dir}:${process.env.PATH}` } });
    const first = invoke(state === "interrupted");
    expect(first.status).toBe(state === "complete" ? 0 : 2);
    const receiptPath = join(dir, "comment.receipt.json");
    const saved = readFileSync(receiptPath, "utf8");
    expect(JSON.parse(saved)).toMatchObject(state === "complete"
      ? { status: "complete", successful: [1], pending: null }
      : { status: "posting", successful: [], pending: state === "interrupted" ? 1 : null });
    const attempts = existsSync(join(dir, "attempts")) ? readFileSync(join(dir, "attempts"), "utf8") : undefined;
    const retry = invoke();
    expect(retry.status).toBe(2);
    expect(retry.stderr).toContain("refusing rerun");
    expect(retry.stderr).toContain(state === "complete" ? "already complete; no retry needed"
      : state === "unattempted" ? "no posting attempt recorded; inspect receipt before manual recovery"
      : "reconcile prior attempt");
    expect(readFileSync(receiptPath, "utf8")).toBe(saved);
    expect(existsSync(join(dir, "attempts")) ? readFileSync(join(dir, "attempts"), "utf8") : undefined).toBe(attempts);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each(["chunk-write", "head-assertion", "pending-save", "success-save", "failure-save"])("N1 reports known state despite %s failure and preserves durable retry lock", failure => {
  const dir = mkdtempSync(join(tmpdir(), "partial-crash-"));
  fixtureConfig(dir);
  try {
    writeFileSync(join(dir, "body"), "X".repeat(200000));
    writeFileSync(join(dir, "model"), "gpt-5.5");
    writeFileSync(join(dir, "gh"), `#!/bin/sh\nprintf '%s\\n' "$5" >> '${dir}/attempts'\n${failure === "failure-save" ? 'case "$5" in *.2) exit 7;; esac' : ''}\nexit 0\n`);
    chmodSync(join(dir, "gh"), 0o755);
    writeFileSync(join(dir, "interrupt.cjs"), `
const fs = require('node:fs'), cp = require('node:child_process');
const write = fs.writeFileSync, spawn = cp.spawnSync;
const failure = ${JSON.stringify(failure)};
fs.writeFileSync = function(path, data, ...args) {
  const p = String(path);
  let trip = failure === 'chunk-write' && p.endsWith('comment.2');
  if (p.includes('receipt.json')) {
    const state = JSON.parse(data);
    trip ||= failure === 'pending-save' && state.pending === 2;
    trip ||= failure === 'success-save' && state.successful.length === 2;
    trip ||= failure === 'failure-save' && state.status === 'failed';
  }
  if (trip) { write(path, '{'); throw new Error('injected ' + failure); }
  return write(path, data, ...args);
};
cp.spawnSync = function(command, args, ...rest) {
  if (failure === 'head-assertion' && command === 'head' && args[1].endsWith('comment.2'))
    return {status: 1, stdout: ''};
  return spawn(command, args, ...rest);
};
require('node:module').syncBuiltinESMExports();
`);
    const invoke = (interrupt = false) => spawnSync(process.execPath,
      [...(interrupt ? ["--require", join(dir, "interrupt.cjs")] : []), helper, "372", "Codex", join(dir, "model"), join(dir, "body"), head, main, join(dir, "comment")],
      { cwd: dir, encoding: "utf8", env: { ...process.env, REVIEW_LARGE_BODY_LEDGER: join(dir, "large-ledger"), PATH: `${dir}:${process.env.PATH}` } });
    const first = invoke(true);
    expect(first.status).toBe(2);
    expect(first.stderr).toContain(failure === "head-assertion" ? "canonical first-line assertion failed" : `injected ${failure}`);
    const successful = failure === "success-save" ? [1, 2] : [1];
    expect(first.stderr).toContain(`partial post: ${successful.length}/4; successful chunk indices ${JSON.stringify(successful)}`);
    const receiptPath = join(dir, "comment.receipt.json");
    expect(first.stderr).toContain(`receipt ${receiptPath}`);
    const known = JSON.parse(first.stderr.split("in-memory receipt (durable receipt may lag): ")[1]!.split("\n")[0]!);
    expect(known).toMatchObject({ successful, total: 4, pending: ["pending-save", "failure-save"].includes(failure) ? 2 : null });
    const saved = readFileSync(receiptPath, "utf8");
    expect(JSON.parse(saved)).toMatchObject({ successful: [1], pending: ["success-save", "failure-save"].includes(failure) ? 2 : null, status: "posting" });
    const attempts = readFileSync(join(dir, "attempts"), "utf8");
    expect(attempts.trim().split("\n")).toHaveLength(["success-save", "failure-save"].includes(failure) ? 2 : 1);
    const retry = invoke();
    expect(retry.status).toBe(2);
    expect(retry.stderr).toContain("refusing rerun; reconcile prior attempt");
    expect(retry.stderr).toContain(saved.trim());
    expect(readFileSync(receiptPath, "utf8")).toBe(saved);
    expect(readFileSync(join(dir, "attempts"), "utf8")).toBe(attempts);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each(["head", "model"])("R390 refuses a complete receipt for a different %s without current-completion advice", changed => {
  const dir = mkdtempSync(join(tmpdir(), "receipt-heading-"));
  fixtureConfig(dir);
  try {
    writeFileSync(join(dir, "body"), `Reviewed head ${head}\nOK`);
    writeFileSync(join(dir, "model"), "gpt-5.5");
    writeFileSync(join(dir, "gh"), `#!/bin/sh\ntouch '${dir}/posted'\n`);
    chmodSync(join(dir, "gh"), 0o755);
    const priorHeading = changed === "head" ? heading.replace(head, "c".repeat(40)) : heading.replace("gpt-5.5", "another-model");
    const saved = JSON.stringify({ heading: priorHeading, status: "complete", successful: [1], pending: null, total: 1 });
    writeFileSync(join(dir, "comment.receipt.json"), saved);
    const r = spawnSync(process.execPath, [helper, "2", "Codex", join(dir, "model"), join(dir, "body"), head, main, join(dir, "comment")], { cwd: dir, encoding: "utf8", env: { ...process.env, REVIEW_LARGE_BODY_LEDGER: join(dir, "large-ledger"), PATH: `${dir}:${process.env.PATH}` } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("receipt heading differs from current review");
    expect(r.stderr).not.toContain("already complete; no retry needed");
    expect(existsSync(join(dir, "posted"))).toBe(false);
    expect(readFileSync(join(dir, "comment.receipt.json"), "utf8")).toBe(saved);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it("R393 zero-publication failure does not claim a partial post", () => {
  const r = run(`Reviewed head ${head}\nOK`, undefined, head, main, undefined, true);
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("no confirmed posts: 0/1");
  expect(r.stderr).not.toContain("partial post:");
  expect(r.stderr).toContain("in-memory receipt");
});
it("R393 all-publication receipt failure does not claim a partial post", () => {
  const source = readFileSync(helper, "utf8").replace("receipt.successful.push(index + 1);", 'receipt.successful.push(index + 1); throw new Error("final receipt fault");');
  const r = run(`Reviewed head ${head}\nOK`, undefined, head, main, source);
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("all posts confirmed, receipt finalization failed: 1/1");
  expect(r.stderr).not.toContain("partial post:");
  expect(r.stderr).toContain("in-memory receipt");
  expect(JSON.parse(r.receipt)).toMatchObject({ successful: [], pending: 1, status: "posting" });
});

it("R401 refuses a complete receipt for a different PR with the same canonical heading", () => {
  const dir = mkdtempSync(join(tmpdir(), "receipt-pr-"));
  fixtureConfig(dir);
  try {
    writeFileSync(join(dir, "body"), `Reviewed head ${head}\nOK`);
    writeFileSync(join(dir, "model"), "gpt-5.5");
    writeFileSync(join(dir, "gh"), `#!/bin/sh\ntouch '${dir}/posted'\n`);
    chmodSync(join(dir, "gh"), 0o755);
    const saved = JSON.stringify({ pr: "1", heading, status: "complete", successful: [1], pending: null, total: 1 });
    writeFileSync(join(dir, "comment.receipt.json"), saved);
    const r = spawnSync(process.execPath, [helper, "2", "Codex", join(dir, "model"), join(dir, "body"), head, main, join(dir, "comment")], { cwd: dir, encoding: "utf8", env: { ...process.env, REVIEW_LARGE_BODY_LEDGER: join(dir, "large-ledger"), PATH: `${dir}:${process.env.PATH}` } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("receipt PR differs from current review");
    expect(r.stderr).not.toContain("already complete; no retry needed");
    expect(existsSync(join(dir, "posted"))).toBe(false);
    expect(readFileSync(join(dir, "comment.receipt.json"), "utf8")).toBe(saved);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("keeps boundary findings whole and indexed in oversized posts", () => {
  const capacity = 60000 - heading.length - 2 - (2 * 5 + 7);
  const finding = "### HIGH: Boundary finding";
  const body = "x\n".repeat(Math.floor((capacity - 10) / 2)) + finding + "\n" + "tail\n".repeat(100);
  const result = run(body, undefined, undefined, undefined, undefined, false, 0, "Codex", undefined, "Conductor ledger: boundary probe fixture is deliberately large.");
  expect(result.status, result.stderr).toBe(0);
  const indexed = result.posts.flatMap((body, i) => {
    const url = `https://github.com/agentkitai/agentrig/pull/1#issuecomment-${i + 1}`;
    expect(body.length).toBeLessThanOrEqual(60000);
    return findingIndex(url, { html_url: url, body });
  });
  expect(indexed.map((f: { heading: string }) => f.heading)).toEqual([finding]);
  expect(result.posts.map((p, i) => p.slice(`${heading}\n\n(${i + 1}/${result.posts.length})\n\n`.length)).join("")).toBe(body);
});

const echoPhrases = [
  "You are the reviewer of record, not the author and not the merger.",
  "A pass verdict lists what you probed and which mutants you ran",
  "Report which of the PR body's claims you verified, and any you could not.",
];
it("M-contract-drift: pins literal echo phrases to current review skill", () => {
  const contract = readSkillText(new URL("../../../.agentrig/skills/review/SKILL.md", import.meta.url));
  for (const phrase of echoPhrases) expect(contract).toContain(phrase);
});
it.each(echoPhrases)("M-echo-gate: rejects instruction echo before gh: %s", phrase => {
  const result = run(`VERDICT: PASS\nReviewed head ${head}\n${phrase}\n`);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("reviewer body echoes instructions; not a verdict");
  expect(result.args).toBeUndefined();
});
it("M-quoted-contract: allows explicit contract quotation inside a real finding only", () => {
  const body = `VERDICT: FAIL\nReviewed head ${head}\n### LOW: Missing evidence\nscripts/post-review-comment.mjs:30 lacks evidence; fix the receipt. Contract quotation:\n> ${echoPhrases[1]}\n`;
  expect(run(body).posted).toBe(`${heading}\n\n${body}`);
  expect(run(`VERDICT: PASS\n> ${echoPhrases[1]}\n`).args).toBeUndefined();
  expect(run(body + echoPhrases[0]).args).toBeUndefined();
});
it("M-size-gate: large genuine review requires nonempty conductor ledger before gh", () => {
  const body = `VERDICT: PASS\nReviewed head ${head}\n` + "Evidence from targeted probe.\n".repeat(2000);
  for (const reason of [undefined, " \n"]) {
    const result = run(body, undefined, undefined, undefined, undefined, false, 0, "Codex", undefined, reason);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("conductor ledger size explanation");
    expect(result.args).toBeUndefined();
  }
  const result = run(body, undefined, undefined, undefined, undefined, false, 0, "Codex", undefined, "Conductor ledger: 2000 targeted probe results justify size.");
  expect(result.status, result.stderr).toBe(0);
  expect(result.posts.map(post => post.replace(/^## External review[^\n]*\n\n(?:\(\d+\/\d+\)\n\n)?/, "")).join("")).toBe(body);
});
it("M-markerless-provenance: preserves Full review comments prefix verdict and stale-head evidence", () => {
  const body = `VERDICT: FAIL\nReviewed head ${"c".repeat(40)}\nFull review comments:\n### HIGH: Broken gate\ncodex\nTail finding evidence.\n`;
  expect(run(body).posted).toBe(`${heading}\n\n${body}`);
});
it("M-codex-tail: extracts transcript verdict without truncating standalone codex within it", () => {
  const verdict = `VERDICT: PASS\nReviewed head ${head}\ncodex\nFinal evidence.\n`;
  const result = run(`OpenAI Codex\nuser\n${echoPhrases[0]}\nthinking\nprobe\ncodex\n${verdict}`);
  expect(result.status, result.stderr).toBe(0);
  expect(result.posted).toBe(`${heading}\n\n${verdict}`);
});
it("counts UTF-8 bytes at the 40 KiB body boundary and records the size rationale", () => {
  const body = "x".repeat(40 * 1024);
  expect(run(body).status).toBe(0);
  expect(run(body + "x").stderr).toContain("conductor ledger size explanation");
  expect(run("😀".repeat(11000)).stderr).toContain("conductor ledger size explanation");
  const result = run(body + "x", undefined, undefined, undefined, undefined, false, 0, "Codex", undefined, "Conductor ledger: intentional 40 KiB boundary fixture.");
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.receipt!).sizeExplanation).toBe("Conductor ledger: intentional 40 KiB boundary fixture.");
});

it.each([
  "LOW risk overall; no blocking defects.",
  "P1 follow-ups tracked separately.",
  "MEDIUM confidence in the claimed counts.",
])("F1: posts legitimate severity-opening prose without synthetic provenance: %s", prose => {
  const body = `VERDICT: PASS\nReviewed head ${head}\n${prose}\n`;
  const result = run(body);
  expect(result.status, result.stderr).toBe(0);
  expect(result.posted).toBe(`${heading}\n\n${body}`);
  expect(result.args).toBeDefined();
  expect(result.stderr).not.toContain("pull/1#issuecomment-1");
  const url = "https://github.com/agentkitai/agentrig/pull/452#issuecomment-5752094526";
  expect(() => findingIndex(url, { html_url: url, body })).not.toThrow();
  expect(findingIndex(url, { html_url: url, body })).toEqual([]);
  const atx = `### ${prose.replace(/^(LOW|P1|MEDIUM) /, "$1: ")}`;
  expect(findingIndex(url, { html_url: url, body: `${body}${atx}\n` })).toEqual([
    { comment: url, heading: atx },
  ]);
  // Prose must neither disable the echo guard nor discard a supported finding's escape.
  expect(run(body + echoPhrases[0]).stderr).toContain("reviewer body echoes instructions; not a verdict");
  const citation = `### LOW: Missing evidence\nFix the receipt. Contract quotation:\n> ${echoPhrases[1]}\n`;
  expect(run(body + citation).posted).toBe(`${heading}\n\n${body}${citation}`);
});

const quoteForms = [
  (s: string) => `> ${s.replace('probed and', 'probed\n> and')}`,
  (s: string) => `Citation: \`${s.replace('probed and', 'probed\nand')}\``,
  (s: string) => `\`\`Citation: ${s}\`\``,
  (s: string) => `\`\`\`text\n${s}\n\`\`\``,
  (s: string) => `~~~~\n${s}\n~~~~`,
  (s: string) => `    ${s.replace('probed and', 'probed\n    and')}`,
];
it.each(quoteForms.flatMap((quote, i) => ['\n', '\r\n'].map(eol => ({ quote, i, eol }))))('M-quote-format $i: only finding citations escape', ({ quote, eol }) => {
  const citation = quote(echoPhrases[1]!).replaceAll('\n', eol);
  const body = `VERDICT: FAIL\n### LOW: Receipt missing\nThe receipt lacks probes; fix the evidence.\n${citation}\n`;
  const result = run(body);
  expect(result.status, result.stderr).toBe(0);
  expect(result.posted).toBe(`${heading}\n\n${body}`);
  const outside = run(`VERDICT: PASS\n${citation}\n`);
  expect(outside.status).not.toBe(0);
  expect(outside.stderr).toContain('reviewer body echoes instructions');
  expect(outside.args).toBeUndefined();
});
it.each(['\n\nUnheaded summary\n', '\n## Summary\n', '\n---\n'])('M-section-leak: ends finding scope at %j', boundary => {
  const result = run(`### LOW: Receipt missing\nFix the evidence.${boundary}> ${echoPhrases[0]}\n`);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('reviewer body echoes instructions');
  expect(result.args).toBeUndefined();
});
it.each(echoPhrases)('M-wrapped-echo: rejects normalized literal %s', phrase => {
  for (const eol of ['\n', '\r\n']) {
    const result = run(`VERDICT: PASS${eol}${phrase.split(' ').join(` \t${eol}`)}`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('reviewer body echoes instructions');
    expect(result.args).toBeUndefined();
  }
});
it.each(['`', '\\`', '```\n'])('M-malformed-quote: no escape for unclosed/escaped %j', open => {
  const result = run(`### LOW: Receipt missing\nFix evidence.\n${open}${echoPhrases[0]}`);
  expect(result.status).not.toBe(0);
  expect(result.args).toBeUndefined();
});
it('M-blank-citation: blank lines do not end an explicitly quoted finding citation', () => {
  expect(run(`### LOW: Receipt missing\nFix evidence.\n\n> ${echoPhrases[0]}\n`).status).toBe(0);
});

it.each([
  (s: string) => `\`\`\`\`\n${s}\n\`\`\``,
  (s: string) => `~~~\n${s}\n\`\`\``,
  (s: string) => `\`\`\n${s}\n\``,
  (s: string) => `\\\`${s}\\\``,
])('M-malformed-pair: malformed quotations do not grant an escape', quote => {
  const result = run(`### LOW: Missing proof\nFix evidence.\n${quote(echoPhrases[0]!)}`);
  expect(result.status).not.toBe(0);
  expect(result.args).toBeUndefined();
});
it('M-fence-heading: a heading inside a citation cannot create finding scope', () => {
  const result = run(`\`\`\`md\n### LOW: Example\n\`\`\`\n> ${echoPhrases[0]}`);
  expect(result.status).not.toBe(0);
  expect(result.args).toBeUndefined();
});
it('M-escaped-close: an escaped closing backtick does not close a citation', () => {
  const result = run(`### LOW: Missing proof\nFix evidence.\n\`${echoPhrases[0]}\\\``);
  expect(result.status).not.toBe(0);
  expect(result.args).toBeUndefined();
});
it('M-nested-quote: wrapped nested blockquotes outside findings still refuse', () => {
  const result = run(`VERDICT: PASS\n> > ${echoPhrases[1]!.replace('probed and', 'probed\n> > and')}`);
  expect(result.status).not.toBe(0);
  expect(result.args).toBeUndefined();
});
