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
  // Inspect every review-heading literal, not only the normative example: a second,
  // conflicting posting example must not pass because the right one is also present.
  const literals = [...text.matchAll(/[`"](## [^`"\n]*review[^`"\n]*)[`"]/gi)].map(match => match[1]!);
  expect(literals.length).toBeGreaterThan(0);
  for (const literal of literals) {
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
  it.each([
    ["alternate prescribed heading", '\nPost each comment with `## Initial independent review — <reviewer> (<model>) — head <SHA>`.' ],
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
}

it("topic rerun acceptance requires the complete heading and CURRENT SHA within that heading", () => {
  assertRerun(topic);
  const mutant = topic.replace(/if the PR carries two comments[\s\S]*?do not run the pass again —/, `if the PR carries two comments whose heading begins with the external review prefix and
   which identify the CURRENT head SHA anywhere in the comment, one from Claude Code and one
   from Codex, do not run the pass again —`);
  expect(mutant).not.toBe(topic);
  expect(() => assertRerun(mutant)).toThrow();
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
