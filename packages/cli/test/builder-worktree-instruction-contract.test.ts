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

// Deliberately bounded prose guard, not a natural-language parser. Negation must
// govern this command clause, not an earlier sentence or a contrasting clause.
const checkPrescriptions = (text: string) => {
  for (const clause of text.split(/[.;!\n]|\b(?:but|however|instead)\b/i)) {
    if (/^\s*(?:never|do not)\s+(?:run|use)\b/i.test(clause)) continue;
    expect(clause).not.toMatch(/git\s+(?:switch|checkout)\s+(?!-{1,2}(?:detach|help)\b|--\s)\S+/);
  }
};
const checkForce = (operative: string) => {
  expect(operative).not.toMatch(/\b(?:advisory only|does not apply|do not apply|unless inconvenient)\b/i);
};
for (const { skill, start, end, phrases } of contracts) {
  const check = (text: string) => {
    const operative = section(text, start, end);
    for (const phrase of phrases) expect(operative).toContain(phrase);
    checkForce(operative);
    checkPrescriptions(text);
  };
  it(`${skill} pins owned builder worktrees at delegation/branch setup`, () => check(read(skill)));
  it.each([
    "Never run `git switch -c docs/task` or `git checkout -b docs/task` in the author checkout.",
    "Do not run `git switch docs/task` or `git checkout docs/task` in the author checkout.",
    "Never change the author checkout's branch; never run `git switch -c` or `git checkout -b` there.",
  ])(`${skill} accepts branch prohibitions: %s`, prohibition => {
    expect(() => check(read(skill) + `\n${prohibition}`)).not.toThrow();
  });
  it.each([
    "These worktree requirements are advisory only.",
    "The owned worktree rule does not apply when a worktree is inconvenient.",
    "These worktree requirements do not apply when a worktree is inconvenient.",
    "Use an owned worktree unless inconvenient.",
  ])(`${skill} rejects adjacent carveout: %s`, carveout => {
    const text = read(skill);
    const operative = text.split(start)[1]!.split(end)[0]!;
    expect(() => check(text.replace(operative, `${operative}\n${carveout}\n`))).toThrow();
  });
  it.each([
    "Never run `git switch -c forbidden`; run `git switch docs/task`.",
    "Do not run `git checkout -b forbidden`, but run `git checkout docs/task`.",
  ])(`${skill} rejects a prescription after a prohibition: %s`, prescription => {
    expect(() => check(read(skill) + `\n${prescription}`)).toThrow();
  });
  it.each(phrases)(`${skill} rejects removal of %s despite an out-of-section copy`, phrase => {
    const text = read(skill);
    check(text);
    const operative = text.split(start)[1]!.split(end)[0]!;
    const normalized = operative.replace(/\s+/g, " ");
    const mutant = normalized.replaceAll(phrase, "REMOVED");
    expect(mutant).not.toBe(normalized);
    expect(() => check(text.replace(operative, mutant) + `\n${operative}`)).toThrow();
  });
  it.each(["git switch -c docs/task origin/main", "git checkout -b docs/task origin/main", "git switch docs/task", "git checkout docs/task"])(`${skill} rejects author-tree prescription %s with positive rules intact`, command => {
    const text = read(skill);
    checkPrescriptions(text);
    expect(() => checkPrescriptions(text + `\nIn the author checkout, run \`${command}\`.\n`)).toThrow();
  });
}

const standalonePhrases = [
  "Standalone handoff is the recorded transition from builder to conductor, not a handoff to another agent",
  "At §7, after pushing and persisting proof, record this phase handoff in the PR body",
  "remove the owned builder worktree and proof TMPDIR under the same join/state/ownership checks above before starting §8",
  "Run conductor work from outside the removed tree; reviews use fresh reviewer-owned trees",
  "For each §9 repair, attach the existing branch in an owned worktree per §1",
  "push and record a new phase handoff, then repeat cleanup before resuming review",
  "Do not retain the builder tree while waiting for CI, merge authorization or landing",
];
function assertStandalone(text: string): void {
  const operative = section(text, "## 1.", "## 2.").replace(/\s+/g, " ");
  for (const phrase of standalonePhrases) expect(operative).toContain(phrase);
}
it("dogfood defines standalone phase handoff and repeated repair cleanup in branch setup", () => {
  assertStandalone(read("dogfood"));
});
it.each(standalonePhrases)("rejects standalone lifecycle deletion: %s", phrase => {
  const text = read("dogfood").replace(/\s+/g, " ");
  assertStandalone(text);
  expect(() => assertStandalone(`${text.replace(phrase, "")}\n${phrase}`)).toThrow();
});
function checkCleanup(text: string): void {
  const operative = section(text, "## Review scratch cleanup", "## 1.");
  expect(operative).toContain("after the branch is pushed and handoff is recorded in the PR body, remove their recorded owned worktree and proof TMPDIR under dogfood §1");
  expect(operative).not.toContain("remove only their recorded owned proof TMPDIR");
}
for (const skill of ["dogfood", "ship"]) {
  it(`${skill} removes both builder resources only after persisted handoff`, () => checkCleanup(read(skill)));
  it(`${skill} accepts negated premature cleanup`, () => {
    const text = read(skill).replace("## 1.", "Never remove the owned worktree before handoff is recorded in the PR body.\n\n## 1.");
    expect(() => checkCleanup(text)).not.toThrow();
  });
  it(`${skill} rejects premature cleanup with positive pointer removed`, () => {
    const text = read(skill).replace("after the branch is pushed and handoff is recorded in the PR body, remove", "before handoff, remove");
    expect(() => checkCleanup(text)).toThrow();
  });
}
