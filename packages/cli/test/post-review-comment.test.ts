import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const helper = fileURLToPath(new URL("../../../scripts/post-review-comment.mjs", import.meta.url));
const head = "a".repeat(40), main = "b".repeat(40);
const heading = `## External review — Codex (gpt-5.5) — head ${head} — merged with origin/main ${main} — full`;
function run(body: string, model = "gpt-5.5\n", sha = head, base = main, source?: string, damage = false, ghExit = 0, reviewer = "Codex") {
  const dir = mkdtempSync(join(tmpdir(), "post-review-"));
  try {
    writeFileSync(join(dir, "body"), body);
    writeFileSync(join(dir, "model"), model);
    writeFileSync(join(dir, "gh"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${dir}/args'\ncat "$5" > '${dir}/posted'\nexit ${ghExit}\n`);
    chmodSync(join(dir, "gh"), 0o755);
    if (damage) {
      writeFileSync(join(dir, "head"), "#!/bin/sh\nprintf 'damaged\\n'\n");
      chmodSync(join(dir, "head"), 0o755);
    }
    if (source !== undefined) writeFileSync(join(dir, "helper.mjs"), source);
    const result = spawnSync(process.execPath, [source === undefined ? helper : join(dir, "helper.mjs"), "372", reviewer, join(dir, "model"), join(dir, "body"), sha, base, join(dir, "comment")], {
      cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    return { status: result.status, stderr: result.stderr,
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
  ["M3 model guard", 'if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model)) throw new Error("empty or invalid model file");', "verdict", "", head, main, false],
  ["M4 head guard", 'if (![head, main].every(sha => sha.length === 40 && /^[a-fA-F0-9]{40}$/.test(sha))) throw new Error("HEAD and MAIN must be unquoted 40-hex SHAs");', "verdict", "gpt-5.5", "bad", main, false],
  ["M4 main guard", 'if (![head, main].every(sha => sha.length === 40 && /^[a-fA-F0-9]{40}$/.test(sha))) throw new Error("HEAD and MAIN must be unquoted 40-hex SHAs");', "verdict", "gpt-5.5", head, "bad", false],
  ["M4 empty body guard", 'if (!body.trim()) throw new Error("empty reviewer body");', "", "gpt-5.5", head, main, false],
  ["M5 first-line guard", 'if (first.status !== 0 || first.stdout !== `${heading}\n`) throw new Error("canonical first-line assertion failed");'.replace('${heading}\n', '${heading}\\n'), "verdict", "gpt-5.5", head, main, true],
] as const)("kills %s: missing gate permits forbidden gh call", (_name, gate, body, model, sha, base, damage) => {
  const source = readFileSync(helper, "utf8");
  expect(source).toContain(gate);
  expect(run(body, model, sha, base, undefined, damage).args).toBeUndefined();
  expect(run(body, model, sha, base, source.replace(gate, ""), damage).args).toBeDefined();
});

const calls = [
  'cd "<WT>" && node scripts/post-review-comment.mjs NN "Claude Code" "<OUT>/claude-model.txt" "<OUT>/claude-validated.md" "HEAD" "MAIN" "<OUT>/claude-comment.md" || exit 2',
  'cd "<WT>" && node scripts/post-review-comment.mjs NN "Codex" "<OUT>/codex-model.txt" "<OUT>/codex-validated.md" "HEAD" "MAIN" "<OUT>/codex-comment.md" "<OUT>/codex-trio.md" || exit 2',
];
function contract(text: string) {
  for (const call of calls) expect(text).toContain(call);
  expect(text).not.toContain("CLAUDE_HEADING=");
  expect(text).toContain("head -1");
}
it.each(["topic", "ship", "dogfood"])("M7 %s pins helper calls and forbids inline heading composition", skill => {
  const text = readFileSync(new URL(`../../../.agentrig/skills/${skill}/SKILL.md`, import.meta.url), "utf8");
  contract(text);
  for (const call of calls) expect(() => contract(text.replace(call, ""))).toThrow();
  expect(() => contract(text + '\nCLAUDE_HEADING="alternate"')).toThrow();
});

it.each(["claude", "codex"])("M8 %s topic gate blocks stale/empty verdicts before helper posting", reviewer => {
  const dir = mkdtempSync(join(tmpdir(), "posting-gates-"));
  try {
    const text = readFileSync(new URL("../../../.agentrig/skills/topic/SKILL.md", import.meta.url), "utf8");
    const marker = `# ${reviewer === "claude" ? "Claude" : "Codex"} posting gate\n`;
    const snippet = text.slice(text.indexOf(marker) + marker.length).split("```")[0]!
      .replaceAll("<OUT>", dir).replaceAll("<WT>", fileURLToPath(new URL("../../../", import.meta.url))).replace('mjs NN', 'mjs 372').replaceAll('"HEAD"', `"${head}"`).replaceAll('"MAIN"', `"${main}"`);
    // Start with the actual CLI artifact, never a fabricated intermediate models file.
    writeFileSync(join(dir, "claude.json"), JSON.stringify({modelUsage: {"claude-opus-5": {inputTokens: 1}}, result: regression}));
    const extraction = text.split("**Assert the model and extract the Claude review:**")[1]!.split("```")[1]!
      .replaceAll("<OUT>", dir);
    const extracted = spawnSync("/bin/sh", ["-c", extraction], { encoding: "utf8", cwd: dir });
    expect(extracted.status, extracted.stderr).toBe(0);
    writeFileSync(join(dir, "codex-model.txt"), "gpt-5.5");
    writeFileSync(join(dir, "codex-trio.md"), "Conductor trio: all exits 0");
    writeFileSync(join(dir, "gh"), `#!/bin/sh\ncat "$5" > '${dir}/posted'\n`);
    chmodSync(join(dir, "gh"), 0o755);
    const invoke = () => spawnSync("/bin/sh", ["-c", snippet], {
      cwd: dir, encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    for (const body of ["", "# verdict heading only", "Reviewed head HEAD\nverdict", `Reviewed head ${main}\nverdict`, `## External review — stale — head ${main}\n\nverdict`]) {
      writeFileSync(join(dir, `${reviewer}.md`), body);
      expect(invoke().status).not.toBe(0);
      expect(existsSync(join(dir, "posted"))).toBe(false);
    }
    writeFileSync(join(dir, `${reviewer}.md`), regression);
    const result = invoke();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(dir, "posted"), "utf8").split("\n")[0]).toBe(reviewer === "codex" ? heading : heading.replace("Codex (gpt-5.5)", "Claude Code (claude-opus-5)"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("B2 splits long review plus proof into bounded lossless canonical comments", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-chunks-"));
  try {
    const body = "VERDICT: PASS\n" + "😀long line".repeat(15000);
    const proof = "PROOF\n" + "evidence\n".repeat(9000);
    writeFileSync(join(dir, "body"), body);
    writeFileSync(join(dir, "proof"), proof);
    writeFileSync(join(dir, "model"), "gpt-5.5");
    writeFileSync(join(dir, "gh"), `#!/bin/sh\nnode -e 'const fs=require("fs");fs.appendFileSync("${dir}/posts",JSON.stringify(fs.readFileSync(process.argv[1],"utf8"))+"\\n")' "$5"\n`);
    chmodSync(join(dir, "gh"), 0o755);
    const result = spawnSync(process.execPath, [helper, "372", "Codex", join(dir,"model"), join(dir,"body"), head, main, join(dir,"comment"), join(dir,"proof")], {cwd: dir, encoding:"utf8", env:{...process.env, PATH:`${dir}:${process.env.PATH}`}});
    expect(result.status, result.stderr).toBe(0);
    const posts = readFileSync(join(dir,"posts"),"utf8").trim().split("\n").map(s => JSON.parse(s) as string);
    expect(posts.length).toBeGreaterThan(1);
    const restored = posts.map((post, i) => {
      expect(post.length).toBeLessThanOrEqual(60000);
      const prefix = `${heading}\n\n(${i+1}/${posts.length})\n\n`;
      expect(post.startsWith(prefix)).toBe(true);
      return post.slice(prefix.length);
    }).join("");
    expect(restored).toBe(`${body}\n${proof}`);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
