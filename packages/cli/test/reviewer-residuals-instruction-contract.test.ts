import { readSkillText } from "../../../test/skill-text.js";
import { expect, it } from "vitest";
const read = (skill: string) => readSkillText(new URL(`../../../.agentrig/skills/${skill}/SKILL.md`, import.meta.url), "utf8");
const contracts: Array<[string, string, string]> = [
  ["arbiter", "M-arbiter-slots", "Missing `reviewers` or `{}` means zero slots"],
  ["arbiter", "M-arbiter-checks", "named same-head receipts"],
  ["topic", "M-unbuilt-repo", "successful declared build output at that same head"],
  ["topic", "M-mutable-repo", "Never use the author tree, stale main dist"],
  ["topic", "M-empty-checks-build", "halt rather than run undeclared checks"],
  ...["ship", "topic"].flatMap(skill => [
    [skill, "M-paraphrased-assignment", "exact verbatim finding heading and comment URL/anchor"],
    [skill, "M-index-omitted", "scripts/review-finding-index.mjs"],
    [skill, "M-fixer-mismatch", "On any mismatch refuse the assignment"],
    [skill, "M-live-dispatch", "Fetch every source comment live again"],
  ] as Array<[string, string, string]>),
  ["land", "M-live-lander", "Fetch every ledger source comment live"],
  ["land", "M-id-only-lander", "blocks landing even when the local finding ID matches"],
  ["review", "M-ref-ownership", "reviewers never create, modify or delete them"],
];
for (const [skill, mutant, phrase] of contracts) {
  it(`${mutant}: ${skill} operative instruction and named deletion mutant`, () => {
    const text = read(skill).replace(/\s+/g, " ");
    const check = (value: string) => expect(value).toContain(phrase);
    check(text);
    expect(() => check(text.replace(phrase, "REMOVED"))).toThrow();
  });
}
it("arbiter has no fixed pair and review has no dangling conjunction", () => {
  expect(read("arbiter")).not.toMatch(/review pair|Give both\s+reviewers|two independent code/);
  expect(read("review")).not.toMatch(/correct\) and\s+with/);
});

for (const skill of ["ship", "topic", "land"]) {
  it(`M-all-ledger-rows: ${skill} covers deferred and advisory rows outside fixer dispatch`, () => {
    const text = read(skill);
    const unconditional = text.split("Before calling a fixer")[0];
    const phrase = "Every ledger row, including nonblocking deferred and advisory findings, must quote the live verbatim finding heading and source comment URL/anchor";
    const check = (value: string) => expect(value).toContain(phrase);
    check(unconditional);
    expect(() => check(unconditional.replace(phrase, "REMOVED"))).toThrow();
  });
}
it("M-base-creation: topic explicitly creates and records the cleanup-owned base", () => {
  const preparation = read("topic").split("- **Prepare.**")[1].split("- **Independent conductor checks")[0];
  const creation = 'git branch "review-base-NN" "$MAIN"';
  const check = (value: string) => expect(value).toContain(creation);
  check(preparation);
  expect(() => check(preparation.replace(creation, "REMOVED"))).toThrow();
  expect(preparation).toContain("refuse an existing ref");
  expect(preparation).toContain("Record this exact ref as conductor-owned");
});
