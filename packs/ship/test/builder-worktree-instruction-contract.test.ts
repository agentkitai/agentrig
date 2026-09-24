import { readSkillText } from "../../../test/skill-text.js";
/**
 * Corpus-defined instruction guards, not a natural-language grammar. A phrasing
 * not in the corpus is, by definition, a coverage addition and not a regression,
 * provided all listed sentences still classify correctly. Review new phrasings
 * as corpus additions. Unknown sentences are accepted, not guessed at.
 *
 * Sources: PR #358 initial Claude/Codex reviews and focused comments 5744838658,
 * 5744898965, 5745001396; issues #359, #360, #362. Retains all prior fixtures;
 * abbreviated review probes are expanded to concrete sentences below.
 * Prescription and prohibition share one branch corpus (opposite sides of the
 * same decision); carve-out and premature-cleanup use their own corpora.
 * Semicolons, colons, dashes and conjunctions stay inside a sentence: their
 * scoping was precisely where the old predicate heuristics exceeded coverage.
 */
import { expect, it } from "vitest";

const read = (skill: string) => readSkillText(new URL(`../../../.agentrig/skills/${skill}/SKILL.md`, import.meta.url), "utf8");
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

type Corpus = { accepted: readonly string[]; rejected: readonly string[] };
const branchCorpus: Corpus = {
  accepted: [
    "Never run `git switch -c docs/task`.",
    "Do not run `git checkout -b docs/task`.",
    "Never avoid logs and never run `git switch docs/task`.",
    "Never change the author checkout's branch with `git switch docs/task`.",
    "Builders must never run `git switch docs/task` in the author checkout.",
    "Avoid `git checkout docs/task` in the author checkout.",
    "No builder may run `git checkout docs/task` there.",
    "The author checkout must not be moved with `git switch docs/task`.",
    "It is forbidden to run `git switch docs/task` in the author checkout.",
    "Never run `git switch -c docs/task` or `git checkout -b docs/task` in the author checkout.",
    "Do not run `git switch docs/task` or `git checkout docs/task` in the author checkout.",
    "Never change the author checkout's branch; never run `git switch -c` or `git checkout -b` there."
  ],
  rejected: [
    "Builders never work on main, so in the author checkout run `git switch -c docs/task`.",
    "Never remove the proof TMPDIR, and builders run `git checkout -b docs/task` there.",
    "Never reuse a stale tree, so run `git switch -c docs/task` in the author checkout.",
    "Avoid deleting logs and builders must run `git checkout -b docs/task`.",
    "No builder may remove logs while maintainers run `git switch -c docs/task`.",
    "Never remove logs then the fixer should use `git checkout -b docs/task`.",
    "Never avoid running git switch docs/task.",
    "Never avoid running git switch -c docs/task.",
    "Never avoid running `git switch docs/task`.",
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
    "In the author checkout, run `git switch -c docs/task origin/main`.",
    "In the author checkout, run `git checkout -b docs/task origin/main`.",
    "In the author checkout, run `git switch docs/task`.",
    "In the author checkout, run `git checkout docs/task`.",
    "Never run the loop, so maintainers run git switch -c docs/task.",
    "Never work on main while builders use git checkout -b docs/task.",
    "Never run the loop, so maintainers run `git switch -c docs/task`.",
    "Never work on main while builders use `git checkout -b docs/task`.",
    "Avoid stale trees; in the author checkout run `git switch -c docs/task`.",
    "Never neglect to run `git switch -c docs/task`.",
    "Do not ever avoid running `git switch docs/task`.",
    "Never ever avoid `git checkout docs/task`.",
    "Do not ever avoid running git switch docs/task."
  ]
};
const forceCorpus: Corpus = {
  accepted: [
    "These steps do not apply to the conductor.",
    "These steps do not apply to conductors.",
    "These steps do not apply to the conductor only.",
    "Recording the PR body ordering is optional as long as it is present.",
    "Builders record the path; restating it is optional.",
    "Builders record the path; restating it is a recommendation."
  ],
  rejected: [
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
    "Those requirements are advisory only.",
    "The owned worktree is optional.",
    "These worktree requirements are optional.",
    "They are advisory only.",
    "Those requirements are optional.",
    "That rule is optional."
  ]
};
const cleanupCorpus: Corpus = {
  accepted: [
    "Before handoff, builders must never remove the owned worktree.",
    "Prior to the handoff, they do not remove the owned worktree.",
    "Builders must never remove the owned worktree before handoff.",
    "Do not remove the owned worktree before handoff.",
    "Never remove the owned worktree before the handoff.",
    "Do not remove the owned worktree prior to handoff.",
    "Before the handoff, never remove the owned worktree.",
    "Prior to handoff, do not remove the owned worktree.",
    "Never remove the owned worktree before handoff is recorded in the PR body.",
    "Before handoff, builders must never remove the owned worktree, and after handoff builders remove the proof TMPDIR.",
    "Before handoff, builders must never remove the owned worktree, but after handoff builders remove the proof TMPDIR.",
    "Never remove the owned worktree before handoff; after handoff remove the proof TMPDIR."
  ],
  rejected: [
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
    "Builders finish fast, before handoff, builders remove the owned worktree.",
    "Builders finish fast, before handoff, remove the owned worktree.",
    "Before handoff, builders should remove the owned worktree.",
    "Before the handoff, builders remove the owned worktree.",
    "Before handoff, however, builders remove the owned worktree.",
    "Before handoff, when the PR is green, remove the owned worktree.",
    "Before handoff, instead remove the owned worktree.",
    "Shortly before handoff, remove the owned worktree.",
    "The fixer removes the owned worktree before handoff.",
    "Before handoff, remove the owned worktree."
  ]
};

// Independent preservation oracle (#375): literal floors and review/issue seeds,
// never computed from the corpora above. Keep these when extending a corpus;
// changing this manifest requires an explicit contract change, not regeneration.
// Distinct-content floors also prevent duplicate entries from padding a bucket.
const corpusManifest = [
  {
    name: "branch accepted", actual: branchCorpus.accepted, minimum: 12,
    seeds: [
      // #360; #358 focused F1 / round-2 G4 control.
      "Never run `git switch -c docs/task`.",
      "Do not run `git checkout -b docs/task`.",
      "Never avoid logs and never run `git switch docs/task`.",
      "Never run `git switch -c docs/task` or `git checkout -b docs/task` in the author checkout.",
      "Do not run `git switch docs/task` or `git checkout docs/task` in the author checkout."
    ]
  },
  {
    name: "branch rejected", actual: branchCorpus.rejected, minimum: 35,
    seeds: [
      // #362; #358 focused F1, G4 and N4 (expanded concrete probes).
      "Builders never work on main, so in the author checkout run `git switch -c docs/task`.",
      "Never remove the proof TMPDIR, and builders run `git checkout -b docs/task` there.",
      "Never reuse a stale tree, so run `git switch -c docs/task` in the author checkout.",
      "Never run the builder loop before you run `git checkout -b docs/task` in the author checkout.",
      "Never run the builder loop and then run `git switch docs/task` in the author checkout.",
      "Do not use the author tree, run `git switch -c docs/task` first.",
      "Never run `git switch -c forbidden` in the author checkout and run `git switch docs/task` there.",
      "Builders must never run `git checkout forbidden` and must run `git checkout docs/task` there.",
      "Never forget to run `git switch -c docs/task`.",
      "Never refuse to use `git checkout -b docs/task`.",
      "Avoid failing to run `git switch -c docs/task`.",
      "Never run the loop, so maintainers run `git switch -c docs/task`.",
      "Never work on main while builders use `git checkout -b docs/task`.",
      "Avoid stale trees; in the author checkout run `git switch -c docs/task`.",
      "Never neglect to run `git switch -c docs/task`.",
      "Never avoid running `git switch -c docs/task`.",
      "Do not avoid `git checkout -b docs/task`.",
      "Never avoid running `git switch docs/task`.",
      "Do not ever avoid running `git switch docs/task`.",
      "Never ever avoid `git checkout docs/task`."
    ]
  },
  {
    name: "carve-out accepted", actual: forceCorpus.accepted, minimum: 6,
    seeds: [
      // #360; #358 focused G2 and N2.
      "These steps do not apply to the conductor.",
      "These steps do not apply to conductors.",
      "These steps do not apply to the conductor only.",
      "Recording the PR body ordering is optional as long as it is present.",
      "Builders record the path; restating it is optional."
    ]
  },
  {
    name: "carve-out rejected", actual: forceCorpus.rejected, minimum: 27,
    seeds: [
      // #360/#362; #358 focused F2, G3 and N4; #375 deletion repro.
      "The owned worktree: optional.",
      "Owned worktrees are optional.",
      "Owned worktrees are advisory only.",
      "It is advisory only.",
      "The rule is optional.",
      "The requirement does not apply when inconvenient.",
      "These requirements are advisory only.",
      "This rule does not apply when inconvenient.",
      "Those requirements are advisory only.",
      "The owned worktree is optional.",
      "These worktree requirements are optional.",
      "These steps do not apply to conductors and builders.",
      "They are advisory only.",
      "That rule is optional."
    ]
  },
  {
    name: "cleanup accepted", actual: cleanupCorpus.accepted, minimum: 12,
    seeds: [
      // #359; #358 focused F3 and N1.
      "Before handoff, builders must never remove the owned worktree.",
      "Do not remove the owned worktree before handoff.",
      "Never remove the owned worktree before the handoff.",
      "Do not remove the owned worktree prior to handoff.",
      "Before the handoff, never remove the owned worktree.",
      "Prior to handoff, do not remove the owned worktree.",
      "Before handoff, builders must never remove the owned worktree, and after handoff builders remove the proof TMPDIR."
    ]
  },
  {
    name: "cleanup rejected", actual: cleanupCorpus.rejected, minimum: 31,
    seeds: [
      // #362; #358 focused F3, G1 and N4.
      "Builders finish fast; before handoff, builders remove the owned worktree.",
      "Builders finish fast; before handoff, they remove the owned worktree.",
      "Before handoff, each builder must remove the owned worktree and proof TMPDIR.",
      "Never remove the author checkout: remove the owned worktree before handoff.",
      "Never remove the author checkout — remove the owned worktree before handoff.",
      "Never remove the author checkout - remove the owned worktree before handoff.",
      "Remove the owned worktree before the handoff is recorded in the PR body.",
      "Remove the owned worktree prior to handoff.",
      "Prior to the handoff, remove the owned worktree.",
      "Builders finish fast, before handoff, remove the owned worktree.",
      "Shortly before handoff, remove the owned worktree.",
      "The fixer removes the owned worktree before handoff.",
      "Before handoff, builders should remove the owned worktree.",
      "Before the handoff, builders remove the owned worktree.",
      "Before handoff, however, builders remove the owned worktree.",
      "Before handoff, when the PR is green, remove the owned worktree.",
      "Before handoff, instead remove the owned worktree.",
      "Before handoff, remove the owned worktree."
    ]
  }
] as const;

for (const { name, actual, minimum, seeds } of corpusManifest) {
  it(`corpus manifest: ${name} retains its independent minimum`, () => {
    expect(new Set(actual).size).toBeGreaterThanOrEqual(minimum);
  });
  it(`corpus manifest: ${name} retains literal issue/review seeds`, () => {
    expect(actual).toEqual(expect.arrayContaining(seeds));
  });
}

// Sentence boundaries intentionally do not split scoped semicolon/colon/dash
// clauses. Whitespace wrapping and a final terminator are not semantic changes.
const normalize = (sentence: string) => sentence.replace(/\s+/g, " ").trim().replace(/^[-*] /, "").replace(/[.!?]$/, "");
const sentences = (text: string) => text.split(/(?<=[.!?])\s+|\n\s*\n/).map(normalize);
const classify = (sentence: string, corpus: Corpus): boolean =>
  !corpus.rejected.some(rejected => normalize(rejected) === normalize(sentence));
const checkSentences = (text: string, corpus: Corpus, guarded: RegExp): void => {
  for (const sentence of sentences(text).filter(sentence => guarded.test(sentence))) {
    expect(classify(sentence, corpus), sentence).toBe(true);
  }
};
const branchPhrase = /\bgit\s+(?:switch|checkout)\b/i;
const forcePhrase = /\b(?:optional|advisory[ -]only|(?:does not|do not|need not) apply|unless inconvenient|where practical|recommendation)\b/i;
const cleanupPhrase = /\bremoves?\b.*\b(?:before|prior to) (?:the )?handoff\b|\b(?:before|prior to) (?:the )?handoff\b.*\bremoves?\b/i;
const checkPrescriptions = (text: string) => checkSentences(text, branchCorpus, branchPhrase);
const checkForce = (text: string) => checkSentences(text, forceCorpus, forcePhrase);
for (const { skill, start, end, phrases } of contracts) {
  const check = (text: string) => {
    const operative = section(text, start, end);
    for (const phrase of phrases) expect(operative).toContain(phrase);
    checkForce(text);
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
const checkCleanupSentences = (text: string) => checkSentences(text, cleanupCorpus, cleanupPhrase);
function checkCleanup(text: string): void {
  const operative = section(text, "## Review scratch cleanup", "## 1.");
  expect(operative).toContain("after the branch is pushed and handoff is recorded in the PR body, remove their recorded owned worktree and proof TMPDIR under dogfood §1");
  expect(operative).not.toContain("remove only their recorded owned proof TMPDIR");
  checkCleanupSentences(text);
}
for (const skill of ["dogfood", "ship"]) {
  it(`${skill} removes both builder resources only after persisted handoff`, () => checkCleanup(read(skill)));
  it(`${skill} rejects premature cleanup with positive pointer removed`, () => {
    const text = read(skill).replace("after the branch is pushed and handoff is recorded in the PR body, remove", "before handoff, remove");
    expect(() => checkCleanup(text)).toThrow();
  });
}

// This harness is also used for the fail-first replay against the previous guards.
const guards = [
  { name: "prescription/prohibition", corpus: branchCorpus, check: checkPrescriptions },
  { name: "carve-out", corpus: forceCorpus, check: checkForce },
  { name: "premature-cleanup", corpus: cleanupCorpus, check: checkCleanupSentences },
];
for (const { name, corpus, check } of guards) {
  it.each(corpus.accepted)(`${name} accepts corpus sentence: %s`, sentence => {
    expect(() => check(sentence)).not.toThrow();
  });
  it.each(corpus.rejected)(`${name} rejects corpus sentence: %s`, sentence => {
    expect(() => check(sentence)).toThrow();
  });
  for (const skill of ["dogfood", "ship", "topic"]) {
    it.each(corpus.accepted)(`${skill} ${name} accepts inserted corpus: %s`, sentence => {
      expect(() => check(`${read(skill)}\n\n${sentence}`)).not.toThrow();
    });
    it.each(corpus.rejected)(`${skill} ${name} rejects inserted corpus: %s`, sentence => {
      expect(() => check(`${read(skill)}\n\n${sentence}`)).toThrow();
    });
  }
}

for (const { name, corpus } of guards) {
  it(`${name} has disjoint, unique corpus decisions`, () => {
    const entries = [...corpus.accepted, ...corpus.rejected].map(normalize);
    expect(new Set(entries).size).toBe(entries.length);
  });
  it.each(corpus.accepted)(`${name} directly accepts: %s`, sentence => {
    expect(classify(sentence, corpus)).toBe(true);
  });
  it.each(corpus.rejected)(`${name} directly rejects: %s`, sentence => {
    expect(classify(sentence, corpus)).toBe(false);
  });
  it(`${name} treats unknown phrasing as a coverage addition`, () => {
    expect(classify("Previously unlisted wording.", corpus)).toBe(true);
  });
}
it("extracts complete scoped sentences across soft line wraps", () => {
  expect(sentences("Before handoff, builders must never remove the owned worktree,\nand after handoff builders remove the proof TMPDIR. Next sentence.")).toEqual([
    "Before handoff, builders must never remove the owned worktree, and after handoff builders remove the proof TMPDIR",
    "Next sentence",
  ]);
});
