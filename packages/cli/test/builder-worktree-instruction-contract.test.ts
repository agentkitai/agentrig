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

// Bounded prose grammar, not a general natural-language parser. A fresh action
// after a conjunction/comma or temporal lead-in starts its own negation scope.
// In particular, an unrelated earlier "never run" cannot excuse a later command.
const actionClauses = (text: string) => text.split(
  /[.;!\n]|\b(?:but|however|instead)\b|(?:,|\b(?:and(?: then)?|then)\b|\b(?:before|until)\s+you\b)\s*(?=(?:must\s+)?(?:run|use|remove)\b)/i,
);
const prohibited = (prefix: string) => /\b(?:never|do not|must not|avoid|forbidden to|prohibited to|no builder may)\b/i.test(prefix);
const checkPrescriptions = (text: string) => {
  for (const clause of actionClauses(text)) {
    for (const command of clause.matchAll(/git\s+(?:switch|checkout)\s+(?!-{1,2}(?:detach|help)\b|--\s)\S+/g)) {
      expect(prohibited(clause.slice(0, command.index))).toBe(true);
    }
  }
};
const checkForce = (operative: string) => {
  for (const clause of operative.split(/[.;!]/)) {
    // Scoping the steps away from conductors is not a builder-rule exception.
    // Require the worktree subject in the same sentence, not elsewhere in §1.
    if (!/\bworktree\b/i.test(clause)) continue;
    expect(clause).not.toMatch(/\b(?:advisory[ -]only|optional|(?:does not|do not|need not) apply|unless inconvenient|where practical|is a recommendation)\b/i);
  }
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
    "Never change the author checkout's branch with `git switch docs/task`.",
    "Builders must never run `git switch docs/task` in the author checkout.",
    "Avoid `git checkout docs/task` in the author checkout.",
    "No builder may run `git checkout docs/task` there.",
    "The author checkout must not be moved with `git switch docs/task`.",
    "It is forbidden to run `git switch docs/task` in the author checkout.",
    "Never run `git switch -c docs/task` or `git checkout -b docs/task` in the author checkout.",
    "Do not run `git switch docs/task` or `git checkout docs/task` in the author checkout.",
    "Never change the author checkout's branch; never run `git switch -c` or `git checkout -b` there.",
  ])(`${skill} accepts branch prohibitions: %s`, prohibition => {
    expect(() => check(read(skill) + `\n${prohibition}`)).not.toThrow();
  });
  it.each([
    "These worktree requirements are advisory only.",
    "These worktree requirements are advisory-only.",
    "The owned worktree rule is optional.",
    "The owned worktree rule need not apply.",
    "Use an owned worktree where practical.",
    "The owned worktree rule is a recommendation.",
    "The owned worktree rule does not apply when a worktree is inconvenient.",
    "These worktree requirements do not apply when a worktree is inconvenient.",
    "Use an owned worktree unless inconvenient.",
  ])(`${skill} rejects adjacent carveout: %s`, carveout => {
    const text = read(skill);
    const operative = text.split(start)[1]!.split(end)[0]!;
    expect(() => check(text.replace(operative, `${operative}\n${carveout}\n`))).toThrow();
  });
  it.each([
    "Never run the builder loop before you run `git checkout -b docs/task` in the author checkout.",
    "Never run the builder loop and then run `git switch docs/task` in the author checkout.",
    "Do not use the author tree, run `git switch -c docs/task` first.",
    "Never run `git switch -c forbidden` in the author checkout and run `git switch docs/task` there.",
    "Builders must never run `git checkout forbidden` and must run `git checkout docs/task` there.",
    "Never run `git switch -c forbidden`; run `git switch docs/task`.",
    "Do not run `git checkout -b forbidden`, but run `git checkout docs/task`.",
  ])(`${skill} rejects a prescription after a prohibition: %s`, prescription => {
    expect(() => check(read(skill) + `\n${prescription}`)).toThrow();
  });
  it(`${skill} accepts a conductor-only scope exemption`, () => {
    const text = read(skill);
    const operative = text.split(start)[1]!.split(end)[0]!;
    expect(() => check(text.replace(operative, `${operative} These steps do not apply to the conductor.`))).not.toThrow();
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
  // Keep a fronted timing condition attached to its removal action.
  const cleanup = operative.replace(/(^|[.;!])\s*before handoff([^,.;]*),\s*remove\b/gi, "$1 remove before handoff$2");
  for (const clause of actionClauses(cleanup)) {
    const removal = /\bremove\b/i.exec(clause);
    if (removal && /\bbefore handoff\b/i.test(clause)) {
      expect(prohibited(clause.slice(0, removal.index))).toBe(true);
    }
  }
}
for (const skill of ["dogfood", "ship"]) {
  it(`${skill} removes both builder resources only after persisted handoff`, () => checkCleanup(read(skill)));
  it(`${skill} accepts negated premature cleanup`, () => {
    const text = read(skill).replace("## 1.", "Never remove the owned worktree before handoff is recorded in the PR body.\n\n## 1.");
    expect(() => checkCleanup(text)).not.toThrow();
  });
  it.each([
    "Remove the owned worktree before handoff is recorded in the PR body.",
    "Before handoff is recorded in the PR body, remove the owned worktree.",
    "Never remove the proof TMPDIR before handoff and remove the owned worktree before handoff.",
    "Do not remove the proof TMPDIR before handoff, remove the owned worktree before handoff.",
  ])(`${skill} rejects affirmative cleanup additions: %s`, instruction => {
    const text = read(skill).replace("## 1.", `${instruction}\n\n## 1.`);
    expect(() => checkCleanup(text)).toThrow();
  });
  it.each([
    "Builders must never remove the owned worktree before handoff.",
    "Do not remove the owned worktree before handoff.",
  ])(`${skill} accepts natural cleanup prohibitions: %s`, instruction => {
    expect(() => checkCleanup(read(skill).replace("## 1.", `${instruction}\n\n## 1.`))).not.toThrow();
  });
  it(`${skill} rejects premature cleanup with positive pointer removed`, () => {
    const text = read(skill).replace("after the branch is pushed and handoff is recorded in the PR body, remove", "before handoff, remove");
    expect(() => checkCleanup(text)).toThrow();
  });
}
