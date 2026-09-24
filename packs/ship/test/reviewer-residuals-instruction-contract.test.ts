import { readFileSync } from "node:fs";
import { readSkillText } from "../../../test/skill-text.js";
import { expect, it } from "vitest";
const read = (skill: string) => readSkillText(new URL(`../../../.agentrig/skills/${skill}/SKILL.md`, import.meta.url), "utf8");
const contracts: Array<[string, string, string]> = [
  ["arbiter", "M-arbiter-slots", "Missing `reviewers` or `{}` means zero slots"],
  ["arbiter", "M-arbiter-checks", "named same-head receipts"],
  ["topic", "M-unbuilt-repo", "Prepare any required dist from this same base commit"],
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
    expect(() => check(text.replaceAll(phrase, "REMOVED"))).toThrow();
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

it("defines the base-pinned adapter REPO checkout before ship examples and links topic", () => {
  const ship = read("ship");
  const policy = readFileSync(new URL("../../../docs/SHIPPING-WORKFLOW.md", import.meta.url), "utf8");
  for (const text of [ship, policy]) {
    expect(text).toMatch(/<REPO>[^\n]*separate clean checkout/i);
    expect(text).toMatch(/topic[^\n]*§2 step 4/);
    expect(text).toMatch(/Never use the author tree[^\n]*main/i);
  }
  const topic = read("topic");
  expect(topic).toMatch(/<REPO>[^\n]*separate clean checkout/i);
});

it("testing policy resolves named checks and zero reviewer slots", () => {
  const policy = readFileSync(new URL("../../../docs/TESTING.md", import.meta.url), "utf8");
  expect(policy).toMatch(/declared reviewer slots/);
  expect(policy).toContain("External review: none declared");
  expect(policy).toMatch(/zero[^\n]*slots/i);
  expect(policy).toMatch(/resolved[^\n]*bootstrap/);
  const current = "same-head receipts **before** launching declared reviewer slots.";
  const stale = "same-head receipts **before** launching the review pair. Reviewers inspect code and targeted\nmutants, not a duplicate full suite. The operative sections in dogfood/topic/review/arbiter\nsupersede shipping policy §3's reviewer-trio rule; ship/land and shipping policy are unchanged.";
  const check = (value: string) => expect(value).toContain(current);
  check(policy);
  // M-actual-stale-433: restore the actual pre-440 sentence, not invented wording.
  expect(() => check(policy.replace(current, stale))).toThrow();
  expect(policy).toContain("declared check receipts");
  expect(policy).toContain("Zero, one or many named steps");
});

it("pins Markdown-only LF policy and explains Windows tooling tradeoff", () => {
  const policy = readFileSync(new URL("../../../docs/TESTING.md", import.meta.url), "utf8");
  const attributes = readFileSync(new URL("../../../.gitattributes", import.meta.url), "utf8");
  expect(attributes).toContain(".agentrig/skills/**/*.md text eol=lf");
  expect(attributes).not.toContain(".agentrig/skills/** text eol=lf");
  expect(policy).toMatch(/Windows[^\n]*editors/);
  expect(policy).toMatch(/CRLF-only[^\n]*tooling/);
  expect(policy).toMatch(/generated[^\n]*raw.byte/);
});
