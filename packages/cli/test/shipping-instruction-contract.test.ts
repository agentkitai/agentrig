import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const skills = ["topic", "ship", "dogfood", "review", "land"] as const;
const heading = "## External review — <reviewer> (<model>) — head <SHA> — merged with origin/main <MAIN> — full";
const rule = `The two initial external review comments must each start with this exact heading form:
\`${heading}\`
Substitute the actual reviewer, model, full reviewed PR head SHA and full origin/main SHA;
post one for Claude Code and one for Codex. No alternate heading is valid for posting,
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
    expect(literal).toMatch(/^## External review — (?:<reviewer>|Claude Code|Codex) \((?:<model>|[\w.-]+)\) — head (?:<SHA>|HEAD) — merged with origin\/main (?:<MAIN>|MAIN) — full$/);
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
