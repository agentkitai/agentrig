import { readFileSync } from "node:fs";
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
    phrases: ["conductor trio is the Codex trio evidence", "docs/TESTING.md", "denied sockets", "npm cache", "GitHub", "environment limitation", "author's trio", "exact-head CI", "Never halt solely because Codex cannot run the suite", "does not erase", "Real test failures"],
  },
  {
    path: ".agentrig/skills/land/SKILL.md", start: "## 1.", end: "## 2.",
    phrases: ["conductor trio is the Codex trio evidence", "shipping policy §3", "docs/TESTING.md", "denied sockets", "npm cache", "GitHub", "environment limitation", "author's trio", "exact-head CI", "Never halt solely because Codex cannot run the suite", "does not erase", "Real test failures"],
  },
  ...["ship", "dogfood"].map(skill => ({
    path: `.agentrig/skills/${skill}/SKILL.md`, start: skill === "ship" ? "## 2." : "## 8.", end: skill === "ship" ? "## 3." : "## 9.",
    phrases: ["topic §2 step 4's conductor trio", "shipping policy §3", "Codex trio evidence", "environment limitation", "Never halt solely because Codex cannot run the suite"],
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
  const posting = section(read(".agentrig/skills/topic/SKILL.md"), "CODEX_MODEL=$(cat", "The conductor posts");
  expect(posting).toContain('cat "<OUT>/codex-trio.md"');
});
