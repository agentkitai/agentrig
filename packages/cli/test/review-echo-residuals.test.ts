import { expect, it } from "vitest";
// @ts-expect-error standalone ESM helper
import { assertReviewerVerdict, instructionEchoSentences } from "../../../scripts/review-finding-index.mjs";
import { readSkillText } from "../../../test/skill-text.js";
const contract = readSkillText(".agentrig/skills/review/SKILL.md");
const heading = "### LOW: Review contract quotation needs evidence\n";
for (const phrase of instructionEchoSentences as string[]) {
  it(`pins and detects wrapped contract: ${phrase}`, () => {
    expect(contract).toContain(phrase);
    const wrapped = phrase.replace(/ /g, "\r\n");
    expect(() => assertReviewerVerdict(`VERDICT: PASS\n${wrapped}`)).toThrow(/echoes instructions/);
  });
  for (const quote of [
    `> ${phrase.replace(/ /g, "\n> ")}`,
    `The wrapped contract says \`${phrase.replace(/ /g, "\n")}\`; fix its evidence.`,
    `The contract says \`${phrase}\`; fix its evidence.`,
    `\`\`\`text\n${phrase}\n\`\`\``,
    `    ${phrase}`,
  ]) it(`M-citation-form: ${quote}`, () => {
    expect(() => assertReviewerVerdict(heading + quote)).not.toThrow();
    expect(() => assertReviewerVerdict(`VERDICT: PASS\n${quote}`)).toThrow(/echoes instructions/);
    expect(() => assertReviewerVerdict(heading + "Fix the evidence.\n\nUnrelated closing prose:\n" + quote)).toThrow(/echoes instructions/);
    expect(() => assertReviewerVerdict(heading + "## Summary\n" + quote)).toThrow(/echoes instructions/);
  });
}
it("unquoted echoes inside findings still refuse", () => {
  expect(() => assertReviewerVerdict(heading + instructionEchoSentences[0])).toThrow(/echoes instructions/);
});
