import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const skills = ["topic", "ship", "dogfood", "review", "land"] as const;
const heading = "## External review — <reviewer> (<model>) — head <SHA> — merged with origin/main <MAIN> — full";
const rule = `The two initial external review comments must each start with this exact heading form:
\`${heading}\`
Substitute the actual reviewer, model, full reviewed PR head SHA and full origin/main SHA.
The conductor (or standalone dogfood author) posts one for Claude Code and one for Codex.
No alternate heading is valid for posting,
acceptance or rerun detection. Require the complete heading, not just its prefix or a SHA
elsewhere in the body. This form is for the initial full pair, not focused delta verdicts.`;

function assertHeadingContract(text: string): void {
  if (text.includes("declared reviewer slots")) {
    expect(text).toContain(heading.replace("<reviewer>", "<slot>"));
    expect(text).toContain("Require the complete heading, not just a prefix");
  } else expect(text).toContain(rule);
  // Bounded quoted-H2 vocabulary: review/reviews/reviewer/reviewers, not general
  // English morphology. Alternate inflected forms (Independent reviews, Reviewer
  // verdict, Reviewers notes) are rejected; Reviewed by / Reviewing report and
  // synonyms are deliberately outside this scanner, not authorized headings.
  // Accept only the literal ledger allowlist below and complete canonical
  // External/Focused forms checked below; the ledger exemption is exact, not a prefix.
  const ledgerHeadings: readonly string[] = ["## Review disposition"];
  const literals = [...text.matchAll(/[`"](## [^`"\n]*\breview(?:s|er|ers)?\b[^`"\n]*)[`"]/gi)].map(match => match[1]!);
  expect(text).not.toMatch(/[`"]## Initial independent review[^`"\n]*[`"]/i);
  expect(literals.length).toBeGreaterThan(0);
  for (const literal of literals) {
    if (ledgerHeadings.includes(literal)) continue;
    // The separate delta-review protocol is outside the initial full-pair contract.
    if (literal === "## Focused review — <reviewer> — head NEW — delta OLD..NEW") continue;
    expect(literal).toMatch(/^## External review — (?:<reviewer>|<slot>|Claude Code|Codex) \((?:<model>|[\w.-]+|\$CODEX_MODEL)\) — head (?:<SHA>|HEAD) — merged with origin\/main (?:<MAIN>|MAIN) — full$/);
  }
  expect(text).not.toMatch(/heading starts with|whose body\s+names the CURRENT head SHA/);
}

for (const skill of skills) {
  const text = readFileSync(new URL(`../../../.agentrig/skills/${skill}/SKILL.md`, import.meta.url), "utf8");
  it(`${skill} prescribes and accepts only the complete initial review heading`, () => {
    assertHeadingContract(text);
  });
  it.each(["`", '"'])(`${skill} allows a quoted Review disposition ledger reference (%s)`, quote => {
    assertHeadingContract(text);
    const fixture = `${text}\nCheck the PR body's ${quote}## Review disposition${quote} ledger is complete.`;
    assertHeadingContract(fixture);
  });
  it.each(["Independent", "Peer", "Adversarial", "Review verdict", "External review pair", "Independent reviews", "Reviewer verdict"])(
    `${skill} rejects alternate %s review-comment headings in either quote style`, family => {
      for (const quote of ["`", '"']) {
        const name = family.includes("review") || family.includes("Review") ? family : `${family} review`;
        const alternative = `\nPost each comment with ${quote}## ${name} — <reviewer> (<model>) — head <SHA>${quote}.`;
        expect(() => assertHeadingContract(text + alternative)).toThrow();
      }
    },
  );
  it(`${skill} accepts the complete focused review heading`, () => {
    assertHeadingContract(`${text}\nPost \`## Focused review — <reviewer> — head NEW — delta OLD..NEW\`.`);
  });
  it.each([
    ["alternate prescribed heading", '\nPost each comment with `## Initial independent review — <reviewer> (<model>) — head <SHA>`.' ],
    ["malformed focused heading", '\nPost a delta verdict with `## Focused review — <reviewer> — head NEW`.' ],
    ["alternate accepted heading", '\nAccept `## External review — <reviewer> (<model>) — head <SHA>` as the initial pair.' ],
    ["prefix-only rerun acceptance", '\nSkip reruns if the heading starts with `## External review —`.' ],
  ])(`${skill} rejects %s even with the canonical example present`, (_name, alternative) => {
    assertHeadingContract(text);
    expect(() => assertHeadingContract(text + alternative)).toThrow();
  });
}

const topic = readFileSync(new URL("../../../.agentrig/skills/topic/SKILL.md", import.meta.url), "utf8");
const review = readFileSync(new URL("../../../.agentrig/skills/review/SKILL.md", import.meta.url), "utf8");

function assertRerun(text: string): void {
  const slice = text.split("First check whether it already ran:")[1]?.split("- **Prepare.**")[0];
  expect(slice).toContain("with the complete initial full review heading defined above");
  expect(slice).toContain("naming the CURRENT head SHA in the heading");
  // Bounded prose contract, not general language inference: these alternative
  // acceptance markers are forbidden in the rerun bullet even when both required
  // phrases remain. Word boundaries avoid matching e.g. "or" inside "Codex".
  // This exact evidence-isolation sentence contains a benign "or", not an
  // acceptance alternative. Exempt only its literal text, not the surrounding tail.
  const acceptance = slice?.replace("Never pass the builder's report,\n   reasoning, findings, or claimed evidence to either reviewer; the PR and the repository are their\n   only evidence.", "");
  expect(acceptance).not.toMatch(/\bor\b|\balternatively\b|\balso\s+accept\b|\bprefix\b|\banywhere\s+in\s+the\s+body\b/i);
}

it("topic rerun acceptance requires the complete heading and CURRENT SHA within that heading", () => {
  assertRerun(topic);
  const mutant = topic.replace(/if the PR carries every declared slot's comment[\s\S]*?do not run the pass again —/, `if the PR carries two comments whose heading begins with the external review prefix and
   which identify the CURRENT head SHA anywhere in the comment, one from Claude Code and one
   from Codex, do not run the pass again —`);
  expect(mutant).not.toBe(topic);
  expect(() => assertRerun(mutant)).toThrow();
});

it.each([
  ["named N1 mutant", "or alternatively whose heading begins with the external review prefix with the SHA anywhere in the body"],
  ["or", "or accept a shortened heading"],
  ["alternatively", "alternatively accept a shortened heading"],
  ["also accept", "also accept a shortened heading"],
  ["prefix", "accept a heading matching the external review prefix"],
  ["anywhere in the body", "accept a comment with the SHA anywhere in the body"],
])("topic rejects additive rerun acceptance: %s", (_name, alternative) => {
  assertRerun(topic);
  const mutant = topic.replace("do not run the pass again", `${alternative}, do not run the pass again`);
  expect(mutant).not.toBe(topic);
  expect(mutant).toContain("with the complete initial full review heading defined above");
  expect(mutant).toContain("naming the CURRENT head SHA in the heading");
  expect(() => assertRerun(mutant)).toThrow();
});

it("topic rejects alternate acceptance in the rerun tail before Prepare", () => {
  assertRerun(topic);
  const alternative = "Alternatively, two comments whose heading begins with the external review prefix and that name the CURRENT head SHA anywhere in the body are also accepted; do not run the pass again.";
  const mutant = topic.replace("   - **Prepare.**", `   ${alternative}\n   - **Prepare.**`);
  expect(mutant).not.toBe(topic);
  expect(mutant).toContain(historicalMainRule);
  expect(() => assertRerun(mutant)).toThrow();
});

it.each([
  ["removed", ""],
  ["reworded", "with an initial review heading"],
])("topic rejects a %s complete-heading requirement", (_name, replacement) => {
  assertRerun(topic);
  const mutant = topic.replace("with the complete initial full review heading defined above", replacement);
  expect(mutant).not.toBe(topic);
  expect(mutant).toContain("naming the CURRENT head SHA in the heading");
  expect(() => assertRerun(mutant)).toThrow();
});

const historicalMainRule = "The recorded `<MAIN>` is historical provenance: it documents the origin/main merge base\n   reviewed by that pass and need not equal current `origin/main`. A moved main uses the existing\n   conflict and material-delta rules in shipping policy §3; a clean advance re-verifies exact-head CI\n   under shipping policy §1’s CI-staleness rule, not a redundant initial pair.";

function assertHistoricalMain(text: string): void {
  const rerun = text.split("First check whether it already ran:")[1]?.split("- **Prepare.**")[0];
  assertRerun(text);
  expect(rerun).toContain(historicalMainRule);
}

it("topic rerun treats MAIN as historical provenance, not a current-main equality gate", () => {
  assertHistoricalMain(topic);
});

it.each([
  ["removed clarification", ""],
  ["current-main equality gate", historicalMainRule.replace("need not equal", "must equal")],
  ["redundant pair on moved main", historicalMainRule.replace("not a redundant initial pair", "requiring a redundant initial pair")],
  ["lost clean-main CI-staleness routing", historicalMainRule.replace("a clean advance re-verifies exact-head CI\n   under shipping policy §1’s CI-staleness rule", "clean advances need no CI re-verification")],
  ["lost conflict/delta routing", historicalMainRule.replace("conflict and material-delta rules in shipping policy §3", "rerun matching alone")],
])("topic rejects %s at the operative rerun check", (_name, replacement) => {
  assertHistoricalMain(topic);
  const mutant = topic.replace(historicalMainRule, replacement);
  expect(mutant).not.toBe(topic);
  // A surviving copy outside the rerun check cannot satisfy this contract.
  expect(() => assertHistoricalMain(`${mutant}\n${historicalMainRule}`)).toThrow();
});

it("isolated reviewer hands off only its own verdict", () => {
  expect(review).toContain("Hand off only your own verdict and provenance to the conductor; do not post other slots,");
  expect(review).toContain("invoke a counterpart, or fabricate a counterpart verdict.");
});


// These are prose contracts, not evidence of agent compliance or workflow speedup.
const cleanupRule = "After the initial declared review pass and after any focused delta review, the conductor removes the review output directory (`OUT`) and the reviewer temporary roots in addition to all owned worktrees and the `review-base-NN` branch; builders and fixers remove their own proof TMPDIR after recording its results in the PR body. Removal happens only after joining every job and verifying restored tracked/index state, and never touches the author's tree.";
const cleanupMapping = "Operative resource mapping: initial reviews remove one recorded owned tree per declared slot and `review-base-NN`; focused reviews remove the pass’s recorded owned single `WT` and unique `BASE`. Both also remove any recorded owned conductor-proof tree and conductor-proof temporary root (including extra exact-head proof trees). Both remove their recorded owned `OUT` and reviewer temporary roots only after all jobs are joined, tracked/index restoration is verified, and evidence is persisted.";
const arbitrationRule = "the topic skill permits one arbitration per row; a conductor that disagrees with a focused reviewer's non-blocking classification records the disagreement in the ledger and either accepts it or halts for the human, without a second arbitration.";
const cleanupSteps = [
  "1. Join every job and subprocess, including installs, retries and mutations.",
  "2. Verify recorded HEADs and restored tracked/index state; an unrestored mutation or unfinished writer blocks removal and invalidates the review, never erases evidence.",
  "3. Persist verdicts, provenance, proof results and failure receipts in the PR before deleting their only local copies.",
  "4. Remove only this pass's recorded owned worktrees, base ref, reviewer temporary roots, any conductor-proof tree and conductor-proof temporary root, and `OUT`; never the author's tree or old unowned scratch.",
];
function assertCleanup(text: string): void {
  expect(text).toContain(`Human cleanup contract (generalized to declared slots):\n\n> ${cleanupRule}`);
  expect(text).toContain(cleanupMapping);
}
function assertCleanupOrder(text: string): void {
  const section = text.split("## Review scratch cleanup")[1]?.split("## 1.")[0] ?? "";
  let previous = -1;
  for (const step of cleanupSteps) {
    const position = section.indexOf(step);
    expect(position).toBeGreaterThan(previous);
    previous = position;
  }
  expect(section).toContain("For a focused pass remove its one worktree and unique `BASE` instead of the initial declared pass and `review-base-NN`.");
}
for (const skill of ["topic", "ship", "dogfood"]) {
  const text = readFileSync(new URL(`../../../.agentrig/skills/${skill}/SKILL.md`, import.meta.url), "utf8");
  it(`${skill} binds cleanup ownership, evidence and order for initial and focused reviews`, () => {
    assertCleanup(text);
    const wrongPass = text.replace("focused reviews remove the pass’s recorded owned single `WT` and unique `BASE`", "focused reviews remove one recorded owned tree per declared slot and `review-base-NN`");
    expect(wrongPass).not.toBe(text);
    expect(() => assertCleanup(wrongPass)).toThrow();
    for (const phrase of ["conductor-proof tree", "conductor-proof temporary root", cleanupMapping, "initial reviews remove one recorded owned tree per declared slot and `review-base-NN`", "only after all jobs are joined, tracked/index restoration is verified, and evidence is persisted"]) {
      expect(() => assertCleanup(text.replace(phrase, ""))).toThrow();
    }
    for (const phrase of ["the review output directory (`OUT`) and ", "the reviewer temporary roots in addition to ", "after recording its results in the PR body", "only after joining every job and verifying restored tracked/index state", "never touches the author's tree"]) {
      const mutant = text.replace(phrase, "");
      expect(mutant).not.toBe(text);
      expect(() => assertCleanup(mutant)).toThrow();
    }
  });
}
it("topic cleanup procedure orders join, restoration and persisted evidence before owned removal", () => {
  assertCleanupOrder(topic);
  for (const step of cleanupSteps) expect(() => assertCleanupOrder(topic.replace(step, ""))).toThrow();
  const swapped = topic.replace(cleanupSteps[0]!, "SWAP").replace(cleanupSteps[3]!, cleanupSteps[0]!).replace("SWAP", cleanupSteps[3]!);
  expect(() => assertCleanupOrder(swapped)).toThrow();
  expect(() => assertCleanupOrder(topic.replace("never the author's tree or old unowned scratch", "including the author's tree and old scratch"))).toThrow();
});
// Pin the operative procedure points, not just the shared declaration above.
const initialCleanup = "Link every returned comment URL in the ledger. Restore mutants and tracked/index state, join\n     all jobs, persist evidence, then remove all recorded owned resources under Review scratch cleanup.";
const focusedCleanup = "Follow **Review scratch cleanup**: join subprocesses, verify restored tracked/index state,\n  persist the verdict/receipts, then remove this pass's worktree, unique `BASE`, reviewer temporary\n  root, any conductor-proof tree and conductor-proof temporary root, and `OUT`.";
const cleanupPointer = "Use topic's **Review scratch cleanup** sequence for every initial and focused pass, including failure/retry/staleness paths. The standalone dogfood author assumes conductor cleanup duties for its reviews. Builders/fixers record command exit codes, test counts, fail-first/mutation results and times in the PR body, join every proof job, verify restored tracked/index state, then, after the branch is pushed and handoff is recorded in the PR body, remove their recorded owned worktree and proof TMPDIR under dogfood §1; do not wait for hosted CI. Keep proof TMPDIR outside Git ancestry per docs/TESTING.md.";

const cleanupWiring: ReadonlyArray<readonly [string, string, string, string, string, string]> = [
  ["topic initial cleanup", topic, "   - **Validate and post.", "   - **Combine.", initialCleanup,
    "Remove scratch before persisting receipts."],
  ["topic focused delta", topic, "- **Cover the delta**", "- **Converge:**", focusedCleanup,
    "Join subprocesses and verify restored tracked/index state before cleanup."],
  ...["ship", "dogfood"].map(skill => [
    `${skill} pointer`,
    readFileSync(new URL(`../../../.agentrig/skills/${skill}/SKILL.md`, import.meta.url), "utf8"),
    "## Review scratch cleanup", "## 1.", cleanupPointer, "Use topic's cleanup sequence for every pass.",
  ] as const),
];

for (const [name, text, start, end, passage, reverted] of cleanupWiring) {
  const assertWiring = (candidate: string): void => {
    expect(candidate.split(start)[1]?.split(end)[0]).toContain(passage);
  };
  it(`${name} uses a distinct nonempty cleanup revert`, () => {
    expect(reverted.trim()).not.toBe("");
    expect(reverted).not.toBe(passage);
    expect(reverted).not.toBe(passage.replace("Review scratch cleanup", "the cleanup guidance"));
  });
  it(`${name} pins the operative cleanup wiring`, () => {
    assertWiring(text);
  });
  it.each([
    ["generic cleanup revert", reverted],
    ["removed passage", ""],
    ["reworded reference", passage.replace("Review scratch cleanup", "the cleanup guidance")],
  ])(`${name} rejects %s even if the passage survives elsewhere`, (_label, replacement) => {
    assertWiring(text);
    const mutant = text.replace(passage, replacement);
    expect(mutant).not.toBe(text);
    // A copy outside the operative bullet/section cannot satisfy the contract.
    expect(() => assertWiring(`${mutant}\n${passage}`)).toThrow();
  });
}

it("topic caps arbitration and explicitly dispositions focused classification disagreement without weakening gates", () => {
  const assertArbitration = (text: string): void => {
    expect(text).toContain(arbitrationRule);
    expect(text).toContain("If that allowance is already used, halt for the human; do not spawn a second arbiter.");
    expect(text).toContain("This disagreement rule does not reclassify blocking findings: all HIGH findings, unmet acceptance, uncertain impact and unresolved blockers still block landing under shipping policy §2.");
    expect(text).toContain("Pending CI and non-blocking polish are not halts by themselves; unresolved classification disagreement may halt for the human.");
  };
  assertArbitration(topic);
  for (const phrase of [arbitrationRule, "without a second arbitration", "records the disagreement in the ledger", "either accepts it or halts for the human", "If that allowance is already used, halt for the human; do not spawn a second arbiter.", "all HIGH findings, unmet acceptance, uncertain impact and unresolved blockers still block landing"]) {
    expect(() => assertArbitration(topic.replace(phrase, ""))).toThrow();
  }
});
