import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const section = (text: string, start: string, end: string) => text.split(start)[1]?.split(end)[0] ?? "";
const requirements = [
  {
    path: ".agentrig/skills/topic/SKILL.md", start: "   - **Conductor trio", end: "   - **Wait**",
    phrases: ["initial pass", "Codex reviewer worktree", "second fresh worktree at the same commit", "independent install", "outside Git ancestry", "fixture preflight", "pnpm build", "pnpm test", "pnpm typecheck", "separately", "exit code", "UTC start/end times", "test/file counts", "reviewed SHA", "Codex comment's provenance", "not the author", "Join the Codex job", "unchanged HEAD", "restored tracked/index state"],
  },
  {
    path: "docs/SHIPPING-WORKFLOW.md", start: "## 3.", end: "## 4.",
    phrases: ["runs independently of the author on the same reviewed head", "conductor trio is the Codex trio evidence", "docs/TESTING.md", "denied sockets", "npm cache", "GitHub", "environment limitation", "author's trio", "exact-head CI", "Never halt solely because Codex cannot run the suite", "does not erase", "Real test failures"],
  },
  {
    path: ".agentrig/skills/land/SKILL.md", start: "## 1.", end: "## 2.",
    phrases: ["runs independently of the author on the same reviewed head", "conductor trio is the Codex trio evidence", "shipping policy §3", "docs/TESTING.md", "denied sockets", "npm cache", "GitHub", "environment limitation", "author's trio", "exact-head CI", "Never halt solely because Codex cannot run the suite", "does not erase", "Real test failures"],
  },
  ...["ship", "dogfood"].map(skill => ({
    path: `.agentrig/skills/${skill}/SKILL.md`, start: skill === "ship" ? "## 2." : "## 8.", end: skill === "ship" ? "## 3." : "## 9.",
    phrases: ["author-tree proof is not independent evidence", "the independent trio", "topic §2 step 4's conductor trio", "shipping policy §3", "Codex trio evidence", "environment limitation", "Never halt solely because Codex cannot run the suite"],
  })),
];

for (const { path, start, end, phrases } of requirements) {
  const check = (text: string) => {
    const operative = section(text, start, end).replace(/\s+/g, " ");
    for (const phrase of phrases) expect(operative).toContain(phrase);
  };
  it(`${path} pins initial trio execution, acceptance or delegation at its operative section`, () => check(read(path)));
  it.each(phrases)(`${path} rejects removal of %s even with an out-of-section copy`, phrase => {
    const text = read(path);
    check(text);
    const operative = section(text, start, end);
    const expression = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"), "g");
    const changed = operative.replace(expression, "REMOVED");
    expect(changed).not.toBe(operative);
    expect(() => check(text.replace(operative, changed) + `\n${operative}`)).toThrow();
  });
}

it("topic posts conductor provenance with the initial Codex verdict", () => {
  const posting = section(read(".agentrig/skills/topic/SKILL.md"), "# Codex posting gate\n", "The conductor posts");
  const guard = '[ -s "<OUT>/codex-trio.md" ] || exit 2';
  expect(posting).toContain(guard);
  expect(posting.indexOf(guard)).toBeLessThan(posting.indexOf("node scripts/post-review-comment.mjs"));
  expect(posting).toContain('"<OUT>/codex-comment.md" "<OUT>/codex-trio.md"');
});

it.each(["missing", "empty", "present"])("topic posting guard handles %s trio evidence", state => {
  const out = mkdtempSync(join(tmpdir(), "initial-trio-"));
  try {
    writeFileSync(join(out, "codex-model.txt"), "gpt-test");
    writeFileSync(join(out, "codex.md"), "verdict");
    if (state !== "missing") writeFileSync(join(out, "codex-trio.md"), state === "present" ? "independent trio proof" : "");
    const text = read(".agentrig/skills/topic/SKILL.md");
    const snippet = section(text, "# Codex posting gate\n", "```")
      .replace('mjs NN', 'mjs 372').replaceAll('"HEAD"', `"${"a".repeat(40)}"`).replaceAll('"MAIN"', `"${"b".repeat(40)}"`);
    writeFileSync(join(out, "gh"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(out, "gh"), 0o755);
    const result = spawnSync("/bin/sh", ["-c", snippet.replaceAll("<OUT>", out)], { encoding: "utf8", cwd: new URL("../../../", import.meta.url), env: { ...process.env, PATH: `${out}:${process.env.PATH}` } });
    expect(result.status).toBe(state === "present" ? 0 : 2);
    const comment = join(out, "codex-comment.md");
    expect(existsSync(comment)).toBe(state === "present");
    if (state === "present") {
      expect(readFileSync(comment, "utf8")).toContain("verdict\nindependent trio proof");
      expect(readFileSync(comment, "utf8")).toMatch(/^## External review — Codex/);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
