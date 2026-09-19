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
  expect(text).toContain(rule);
  // Inspect quoted review H2s, including alternate posting families. Only the
  // literal ledger allowlist is exempt from complete comment-heading validation.
  const ledgerHeadings: readonly string[] = ["## Review disposition"];
  const literals = [...text.matchAll(/[`"](## [^`"\n]*\breview\b[^`"\n]*)[`"]/gi)].map(match => match[1]!);
  expect(text).not.toMatch(/[`"]## Initial independent review[^`"\n]*[`"]/i);
  expect(literals.length).toBeGreaterThan(0);
  for (const literal of literals) {
    if (ledgerHeadings.includes(literal)) continue;
    // The separate delta-review protocol is outside the initial full-pair contract.
    if (literal === "## Focused review — <reviewer> — head NEW — delta OLD..NEW") continue;
    expect(literal).toMatch(/^## External review — (?:<reviewer>|Claude Code|Codex) \((?:<model>|[\w.-]+|\$CODEX_MODEL)\) — head (?:<SHA>|HEAD) — merged with origin\/main (?:<MAIN>|MAIN) — full$/);
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
  it.each(["Independent", "Peer", "Adversarial", "Review verdict", "External review pair"])(
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
  const slice = text.split("First check whether it already ran:")[1]?.split("continue at **Combine**")[0];
  expect(slice).toContain("with the complete initial full review heading defined above");
  expect(slice).toContain("naming the CURRENT head SHA in the heading");
  // Bounded prose contract, not general language inference: these alternative
  // acceptance markers are forbidden in the rerun bullet even when both required
  // phrases remain. Word boundaries avoid matching e.g. "or" inside "Codex".
  expect(slice).not.toMatch(/\bor\b|\balternatively\b|\balso\s+accept\b|\bprefix\b|\banywhere\s+in\s+the\s+body\b/i);
}

it("topic rerun acceptance requires the complete heading and CURRENT SHA within that heading", () => {
  assertRerun(topic);
  const mutant = topic.replace(/if the PR carries two comments[\s\S]*?do not run the pass again —/, `if the PR carries two comments whose heading begins with the external review prefix and
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

const historicalMainRule = "The recorded `<MAIN>` is historical provenance: it documents the origin/main merge base\n   reviewed by that pass and need not equal current `origin/main`. A moved main uses the existing\n   conflict and material-delta rules in shipping policy §3, not a redundant initial pair.";

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
  ["lost conflict/delta routing", historicalMainRule.replace("conflict and material-delta rules in shipping policy §3", "rerun matching alone")],
])("topic rejects %s at the operative rerun check", (_name, replacement) => {
  assertHistoricalMain(topic);
  const mutant = topic.replace(historicalMainRule, replacement);
  expect(mutant).not.toBe(topic);
  // A surviving copy outside the rerun check cannot satisfy this contract.
  expect(() => assertHistoricalMain(`${mutant}\n${historicalMainRule}`)).toThrow();
});

it("topic captures and validates Codex stderr provenance before its concrete canonical posting template", () => {
  const slice = topic.split("**Assert the Codex model from stderr:**")[1]?.split("**Combine.**")[0];
  expect(slice).toContain('"<OUT>/codex.err" > "<OUT>/codex-model.txt"');
  expect(slice).toContain("Missing, malformed or ambiguous model provenance halts the pass; never guess or post a placeholder.");
  expect(slice).toContain('CODEX_MODEL=$(cat "<OUT>/codex-model.txt")');
  expect(slice).toContain('## External review — Codex ($CODEX_MODEL) — head HEAD — merged with origin/main MAIN — full');
  expect(slice).toContain('gh pr comment NN --body-file "<OUT>/codex-comment.md"');
});

it("isolated reviewer hands off only its own verdict; conductor owns the complete pair", () => {
  const slice = review.split("## Initial full review heading contract")[1]?.split("## 1.")[0];
  expect(slice).toContain("The conductor (or standalone dogfood author) posts one for Claude Code and one for Codex.");
  expect(slice).toContain("Hand off only your own verdict and provenance to the conductor; do not post the pair,");
  expect(slice).toContain("invoke a counterpart, or fabricate a counterpart verdict.");
  expect(slice).not.toContain(";\npost one for Claude Code");
});


it.each([
  ["model: gpt-5.6-sol\n", 0, "gpt-5.6-sol"],
  ["OpenAI Codex\nmodel: gpt-5.6\nprovider: openai\n", 0, "gpt-5.6"],
  ["provider: openai\n", 2, ""],
  ["model: \n", 2, ""],
  ["model: <model>\n", 2, ""],
  ["model: gpt-5.6 extra\n", 2, ""],
  ["model: gpt-5.6\nmodel: gpt-5.7\n", 2, ""],
  ["model: gpt-5.6\nmodel: gpt-5.6\n", 2, ""],
])("Codex provenance command fails closed for stderr %j", (stderr, status, stdout) => {
  const script = topic.match(/node -e '([^'\n]+)' "<OUT>\/codex\.err"/)?.[1];
  expect(script).toBeDefined();
  const dir = mkdtempSync(join(tmpdir(), "heading-provenance-"));
  try {
    const path = join(dir, "codex.err");
    writeFileSync(path, stderr);
    const result = spawnSync(process.execPath, ["-e", script!, path], { encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(status);
    expect(result.stdout).toBe(stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// These are prose contracts, not evidence of agent compliance or workflow speedup.
const cleanupRule = "After the initial review pair and after any focused delta review, the conductor removes the review output directory (`OUT`) and the reviewer temporary roots in addition to both worktrees and the `review-base-NN` branch; builders and fixers remove their own proof TMPDIR after recording its results in the PR body. Removal happens only after joining every job and verifying restored tracked/index state, and never touches the author's tree.";
const cleanupMapping = "Operative resource mapping: initial reviews remove the pass’s recorded owned `WT`, `CODEX_WT` and `review-base-NN`; focused reviews remove the pass’s recorded owned single `WT` and unique `BASE`. Both remove their recorded owned `OUT` and reviewer temporary roots only after all jobs are joined, tracked/index restoration is verified, and evidence is persisted.";
const arbitrationRule = "the topic skill permits one arbitration per row; a conductor that disagrees with a focused reviewer's non-blocking classification records the disagreement in the ledger and either accepts it or halts for the human, without a second arbitration.";
const cleanupSteps = [
  "1. Join every job and subprocess, including installs, retries and mutations.",
  "2. Verify recorded HEADs and restored tracked/index state; an unrestored mutation or unfinished writer blocks removal and invalidates the review, never erases evidence.",
  "3. Persist verdicts, provenance, proof results and failure receipts in the PR before deleting their only local copies.",
  "4. Remove only this pass's recorded owned worktrees, base ref, reviewer temporary roots and `OUT`; never the author's tree or old unowned scratch.",
];
function assertCleanup(text: string): void {
  expect(text).toContain(`Human cleanup contract (verbatim):\n\n> ${cleanupRule}`);
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
  expect(section).toContain("For a focused pass remove its one worktree and unique `BASE` instead of the initial pair and `review-base-NN`.");
}
for (const skill of ["topic", "ship", "dogfood"]) {
  const text = readFileSync(new URL(`../../../.agentrig/skills/${skill}/SKILL.md`, import.meta.url), "utf8");
  it(`${skill} binds cleanup ownership, evidence and order for initial and focused reviews`, () => {
    assertCleanup(text);
    const wrongPass = text.replace("focused reviews remove the pass’s recorded owned single `WT` and unique `BASE`", "focused reviews remove the pass’s recorded owned `WT`, `CODEX_WT` and `review-base-NN`");
    expect(wrongPass).not.toBe(text);
    expect(() => assertCleanup(wrongPass)).toThrow();
    for (const phrase of [cleanupMapping, "initial reviews remove the pass’s recorded owned `WT`, `CODEX_WT` and `review-base-NN`", "only after all jobs are joined, tracked/index restoration is verified, and evidence is persisted"]) {
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
const initialCleanup = "cleanup: every removal below and in retry/staleness paths follows **Review scratch cleanup**,\n     including BOTH reviewer trees, the shared `review-base-NN` ref, reviewer temporary roots and `OUT`.";
const focusedCleanup = "Follow **Review scratch cleanup**: join subprocesses, verify restored tracked/index state,\n  persist the verdict/receipts, then remove this pass's worktree, unique `BASE`, reviewer temporary\n  root and `OUT`.";
const cleanupPointer = "Use topic's **Review scratch cleanup** sequence for every initial and focused pass, including failure/retry/staleness paths. The standalone dogfood author assumes conductor cleanup duties for its reviews. Builders/fixers record command exit codes, test counts, fail-first/mutation results and times in the PR body, join every proof job, verify restored tracked/index state, then remove only their recorded owned proof TMPDIR before handoff; do not wait for hosted CI. Keep proof TMPDIR outside Git ancestry per docs/TESTING.md.";

const cleanupWiring = [
  ["topic initial provenance", topic, "**Provenance.**", "**Combine.**", initialCleanup,
    "cleanup: every removal below and in retry/staleness paths means BOTH reviewer trees, only after jobs are joined, plus the shared `review-base-NN` ref."],
  ["topic focused delta", topic, "- **Cover the delta**", "- **Converge:**", focusedCleanup,
    "Join subprocesses and verify restored tracked/index state before cleanup."],
  ...["ship", "dogfood"].map(skill => [
    `${skill} pointer`,
    readFileSync(new URL(`../../../.agentrig/skills/${skill}/SKILL.md`, import.meta.url), "utf8"),
    "## Review scratch cleanup", "## 1.", cleanupPointer, "",
  ]),
];

for (const [name, text, start, end, passage, reverted] of cleanupWiring) {
  const assertWiring = (candidate: string): void => {
    expect(candidate.split(start!)[1]?.split(end!)[0]).toContain(passage!);
  };
  it(`${name} pins the operative cleanup wiring`, () => {
    assertWiring(text!);
  });
  it.each([
    ["reviewer reverting mutant", reverted!],
    ["removed passage", ""],
    ["reworded reference", passage!.replace("**Review scratch cleanup**", "the cleanup guidance")],
  ])(`${name} rejects %s even if the passage survives elsewhere`, (_label, replacement) => {
    assertWiring(text!);
    const mutant = text!.replace(passage!, replacement);
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
