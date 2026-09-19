import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const read = (skill: string) => readFileSync(new URL(`../../../.agentrig/skills/${skill}/SKILL.md`, import.meta.url), "utf8");
const section = (text: string, start: string, end: string) => text.split(start)[1]?.split(end)[0]?.replace(/\s+/g, " ") ?? "";
const contracts = [
  { skill: "dogfood", start: "## 1.", end: "## 2.", phrases: [
    "Builders, continuation builders and fixers", "owned worktree", "git fetch origin main",
    "git worktree add <path> -b <branch> origin/main", "git worktree add <path> <branch>",
    "Never change the author checkout's branch", "Record the owned worktree path in the PR body",
    "remove their owned worktree after handoff is recorded", "join every job", "restored tracked/index state",
    "conductor removes any recorded owned leftovers after landing", "never remove the author checkout",
  ] },
  ...["ship", "topic"].map(skill => ({ skill, start: skill === "ship" ? "## 1." : "## 2.", end: skill === "ship" ? "## 2." : "## 3.", phrases: [
    "dogfood §1", "builders, continuation builders and fixers", "owned worktree", "Never change the author checkout's branch",
    "worktree path in the PR body", "remove it after recording handoff", "conductor removes recorded owned leftovers after landing",
  ] })),
];

// No branch-creation prescriptions belong in these skills: use worktree add instead.
const checkPrescriptions = (text: string) => expect(text).not.toMatch(/git\s+(?:switch\s+-c|checkout\s+-b)\b/);
for (const { skill, start, end, phrases } of contracts) {
  const check = (text: string) => {
    const operative = section(text, start, end);
    for (const phrase of phrases) expect(operative).toContain(phrase);
    checkPrescriptions(text);
  };
  it(`${skill} pins owned builder worktrees at delegation/branch setup`, () => check(read(skill)));
  it.each(phrases)(`${skill} rejects removal of %s despite an out-of-section copy`, phrase => {
    const text = read(skill);
    check(text);
    const operative = text.split(start)[1]!.split(end)[0]!;
    const normalized = operative.replace(/\s+/g, " ");
    const mutant = normalized.replaceAll(phrase, "REMOVED");
    expect(mutant).not.toBe(normalized);
    expect(() => check(text.replace(operative, mutant) + `\n${operative}`)).toThrow();
  });
  it.each(["git switch -c docs/task origin/main", "git checkout -b docs/task origin/main"])(`${skill} rejects author-tree prescription %s with positive rules intact`, command => {
    const text = read(skill);
    checkPrescriptions(text);
    expect(() => checkPrescriptions(text + `\nIn the author checkout, run \`${command}\`.\n`)).toThrow();
  });
}
