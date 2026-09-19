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

// Bounded predicate grammar, not a general natural-language parser. Negation
// must govern the command's predicate, not merely occur earlier in its clause.
const actionClauses = (text: string) => text.split(/[.;!\n:—]|\s-\s|\b(?:but|however|instead)\b/i);
const prohibited = (prefix: string) => {
  // A coordinated command list shares its predicate ("never run X or Y").
  const predicate = prefix.replace(/`git\s+[^`]+`\s+or\s+/gi, "").replace(/`\s*$/, "").trim();
  if (/\b(?:never|do not|must not)\s+avoid(?:\s+(?:running|using))?\s*$/i.test(predicate)) return false;
  return /\b(?:(?:never|do not|must not)\s+(?:(?:run|use)\s*|change the author checkout's branch with\s*|be moved with\s*)?|avoid\s+(?:(?:running|using)\s+)?|(?:forbidden|prohibited) to (?:run|use)\s+|no builder may (?:run|use)\s+)$/i.test(predicate + " ");
};
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
    // Pronoun subjects still refer to these requirements; exempt only an
    // explicit conductor-only subject, never an inconvenient-builder carveout.
    if (/^\s*these (?:steps|rules|requirements) do not apply to (?:the )?conductors?(?: only)?\s*$/i.test(clause)) continue;
    if (!/\b(?:worktrees?|these (?:requirements|steps|rules)|(?:this|the) (?:rule|requirement)|it)\b/i.test(clause)) continue;
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
    "Never avoid logs and never run `git switch docs/task`.",
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
    "The owned worktree: optional.",
    "Owned worktrees are optional.",
    "Owned worktrees are advisory only.",
    "It is advisory only.",
    "The rule is optional.",
    "The requirement does not apply when inconvenient.",
    "These steps do not apply to conductors and builders.",
    "These steps do not apply to the conductor only when inconvenient for builders.",
    "These requirements are advisory only.",
    "This rule does not apply when inconvenient.",
    "These steps are optional.",
    "These rules need not apply.",
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
    "Builders never work on main, so in the author checkout run `git switch -c docs/task`.",
    "Never remove the proof TMPDIR, and builders run `git checkout -b docs/task` there.",
    "Never reuse a stale tree, so run `git switch -c docs/task` in the author checkout.",
    "Avoid deleting logs and builders must run `git checkout -b docs/task`.",
    "No builder may remove logs while maintainers run `git switch -c docs/task`.",
    "Never remove logs then the fixer should use `git checkout -b docs/task`.",
    "Never avoid running `git switch -c docs/task`.",
    "Do not avoid `git checkout -b docs/task`.",
    "Builders must not avoid using `git checkout docs/task`.",
    "Never forget to run `git switch -c docs/task`.",
    "Never refuse to use `git checkout -b docs/task`.",
    "Avoid failing to run `git switch -c docs/task`.",
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
  it.each(["These steps do not apply to the conductor.", "These steps do not apply to conductors.", "These steps do not apply to the conductor only."])(`${skill} accepts a conductor-only scope exemption: %s`, exemption => {
    const text = read(skill);
    const operative = text.split(start)[1]!.split(end)[0]!;
    expect(() => check(text.replace(operative, `${operative} ${exemption}`))).not.toThrow();
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
  // Fronted timing governs the following removals even with intervening
  // subjects. Strip only that timing adjunct before testing each predicate;
  // retain suffix timing and inspect every removal independently.
  const early = /\b(?:before (?:the )?handoff|prior to (?:the )?handoff)\b/i;
  for (const sentence of operative.split(/[.;!\n:—]|\s-\s/)) {
    const fronted = sentence.match(/^\s*(?:before|prior to) (?:the )?handoff[^,.;]*,/i);
    const remainder = fronted ? sentence.slice(fronted[0].length) : sentence;
    for (const actions of actionClauses(remainder)) {
      for (const removal of actions.matchAll(/\bremove\b/gi)) {
        const after = actions.slice(removal.index + removal[0].length).split(/\bremove\b/i)[0]!;
        if (fronted || early.test(after)) expect(prohibited(actions.slice(0, removal.index))).toBe(true);
      }
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
    "Builders finish fast; before handoff, builders remove the owned worktree.",
    "Builders finish fast; before handoff, they remove the owned worktree.",
    "Before handoff, each builder must remove the owned worktree and proof TMPDIR.",
    "Prior to the handoff, builders remove the owned worktree.",
    "Before handoff, never remove logs and builders remove the owned worktree.",
    "Before handoff, builders never remove logs but remove the owned worktree before handoff.",
    "Before handoff, builders never remove logs but remove the owned worktree.",
    "Builders finish fast: before handoff, remove the owned worktree.",
    "Builders finish fast — before handoff, remove the owned worktree.",
    "Builders finish fast - prior to the handoff, they remove the owned worktree.",
    "Never remove the author checkout: remove the owned worktree before handoff.",
    "Never remove the author checkout — remove the owned worktree before handoff.",
    "Never remove the author checkout - remove the owned worktree before handoff.",
    "Remove the owned worktree before the handoff is recorded in the PR body.",
    "Remove the owned worktree prior to handoff.",
    "Prior to the handoff, remove the owned worktree.",
    "Never remove logs while builders remove the owned worktree before the handoff.",
    "Remove the owned worktree before handoff is recorded in the PR body.",
    "Before handoff is recorded in the PR body, remove the owned worktree.",
    "Never remove the proof TMPDIR before handoff and remove the owned worktree before handoff.",
    "Do not remove the proof TMPDIR before handoff, remove the owned worktree before handoff.",
  ])(`${skill} rejects affirmative cleanup additions: %s`, instruction => {
    const text = read(skill).replace("## 1.", `${instruction}\n\n## 1.`);
    expect(() => checkCleanup(text)).toThrow();
  });
  it.each([
    "Before handoff, builders must never remove the owned worktree.",
    "Prior to the handoff, they do not remove the owned worktree.",
    "Builders must never remove the owned worktree before handoff.",
    "Do not remove the owned worktree before handoff.",
    "Never remove the owned worktree before the handoff.",
    "Do not remove the owned worktree prior to handoff.",
    "Before the handoff, never remove the owned worktree.",
    "Prior to handoff, do not remove the owned worktree.",
  ])(`${skill} accepts natural cleanup prohibitions: %s`, instruction => {
    expect(() => checkCleanup(read(skill).replace("## 1.", `${instruction}\n\n## 1.`))).not.toThrow();
  });
  it(`${skill} rejects premature cleanup with positive pointer removed`, () => {
    const text = read(skill).replace("after the branch is pushed and handoff is recorded in the PR body, remove", "before handoff, remove");
    expect(() => checkCleanup(text)).toThrow();
  });
}
