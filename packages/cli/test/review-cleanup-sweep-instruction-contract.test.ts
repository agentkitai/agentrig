import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const read = (skill: string) => readFileSync(new URL(`../../../.agentrig/skills/${skill}/SKILL.md`, import.meta.url), "utf8");
const section = (text: string, start: string, end: string) => {
  expect(text.split(start)).toHaveLength(2);
  const rest = text.split(start)[1]!;
  expect(rest).toContain(end);
  return rest.split(end)[0]!;
};
const contracts = [
  ...[
    ["Operative resource mapping:", "Apply this sequence"],
    ["  persist the verdict/receipts", "- **Converge:**"],
    ["4. Remove only", "For a focused pass"],
    ["For a focused pass", "## 1."],
    ["Persist-before-delete on incomplete review:", "Never share mutable"],
  ].map(([start, end]) => ({ skill: "topic", start: start!, end: end!, issue: 341, phrases: ["conductor-proof tree", "conductor-proof temporary root"] })),
  { skill: "topic", start: "   - **Independent conductor checks", end: "   - **Launch each slot", issue: 342, phrases: ["Require GREEN BEFORE launching any reviewer", "Restore tracked/index state", "join jobs", "recheck current PR head before launch"] },
  ...["dogfood", "ship"].map(skill => ({ skill, start: "## 1.", end: "## 2.", issue: 348, phrases: ["git worktree remove <path>", "then `git worktree prune`", "Never use bare directory deletion"] })),
  ...[
    ["## 7.", "## 8.", ["record the phase handoff in the PR body", "remove the owned builder worktree and proof TMPDIR", "before starting §8"]],
    ["## 8.", "## 9.", ["After §7's persisted phase handoff and builder cleanup", "outside the removed builder tree"]],
    ["## 9.", "## 10.", ["attach the existing branch in an owned worktree per §1", "push", "record a new phase handoff in the PR body", "repeat builder worktree and proof TMPDIR cleanup", "before resuming review"]],
    ["## 10.", "- When the supervisor", ["outside the removed builder tree", "Do not retain or recreate the builder tree while waiting"]],
  ].map(([start, end, phrases]) => ({ skill: "dogfood", start: start as string, end: end as string, issue: 349, phrases: phrases as string[] })),
];
for (const { skill, start, end, issue, phrases } of contracts) {
  const check = (text: string) => {
    const operative = section(text, start, end).replace(/\s+/g, " ");
    for (const phrase of phrases) expect(operative).toContain(phrase);
  };
  it(`#${issue} ${skill} ${start}`, () => check(read(skill)));
  it.each(phrases)(`#${issue} rejects removed operative instruction: %s (${start})`, phrase => {
    const text = read(skill);
    check(text);
    const body = section(text, start, end);
    const mutant = body.replace(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+")), "REMOVED");
    expect(mutant).not.toBe(body);
    expect(() => check(text.replace(body, mutant) + `\n${phrase}`)).toThrow();
  });
}

for (const skill of ["ship", "topic"]) {
  const spawn = skill === "ship" ? "- Spawn the fixer" : "- **Fix** with one subagent";
  const check = (text: string) => {
    const operative = section(text, "## 3.", "## 4.");
    const edit = operative.indexOf("1. Persist the PR body with `gh pr edit");
    expect(edit).toBeGreaterThanOrEqual(0);
    expect(operative.indexOf(spawn)).toBeGreaterThan(edit);
    const ledger = operative.slice(edit, operative.indexOf(spawn)).replace(/\s+/g, " ");
    for (const phrase of ["## Review disposition", "every finding", "severity", "disposition", "Repair round: N/3", "OLD", "assigned blocker IDs", "## Residuals", "links or none", "Require edit success before proceeding", "2. Only then"]) expect(ledger).toContain(phrase);
  };
  it(`#351 ${skill} persists ledger before fixer`, () => check(read(skill)));
  it(`#351 ${skill} rejects prescribed spawn before ledger edit`, () => {
    const text = read(skill);
    check(text);
    const at = text.indexOf(spawn);
    const end = text.indexOf("\n- ", at + 1);
    const instruction = text.slice(at, end);
    const mutant = text.replace(instruction, "").replace("1. Persist the PR body", `${instruction}\n1. Persist the PR body`);
    expect(() => check(mutant)).toThrow();
  });
}

// Canonical composition/posting and #365 regressions live in post-review-comment.test.ts.
const validator = () => section(read("topic"), "# Slot posting gate\n", "\n");

// #368: enforce order in each local halt path, not by a distant delegation.
for (const start of ["Persist-before-delete on incomplete review:"]) {
  const check = (text: string) => {
    const local = section(text, start, "Never share mutable").replace(/\s+/g, " ");
    const post = local.indexOf("post any surviving review and persist verdicts, provenance, proof results and failure receipts in the PR");
    const clean = local.indexOf("then remove owned reviewer trees");
    expect(post).toBeGreaterThanOrEqual(0);
    expect(clean).toBeGreaterThan(post);
    expect(local).toContain("under **Review scratch cleanup**; only then");
  };
  it(`#368 local persist-before-delete ${start}`, () => {
    const text = read("topic");
    check(text);
    const mutant = text.replace(/post any surviving review and persist verdicts,\s+provenance, proof results and failure receipts in the PR; then remove owned reviewer trees/g, "then remove owned reviewer trees; post any surviving review and persist verdicts, provenance, proof results and failure receipts in the PR");
    expect(mutant).not.toBe(text);
    expect(() => check(mutant)).toThrow();
  });
}
// Shared Claude/Codex posting gate is executed by sha-claim-instruction-contract.test.ts.

// D1: the slot lead-in forbids global source substitution.
it("D1 slot lead-in prescribes only targeted shell substitution", () => {
  const lead = section(read("topic"), "For each successful slot,", "# Slot posting gate");
  expect(lead).toContain("only to shell SHA arguments and paths");
  expect(lead).toContain("never edit the validator source");
});
it("D1 substitution touches only shell paths and expected head", () => {
  const source = validator();
  const targeted = source.replaceAll("<PREFIX>", "/tmp/owned/codex").replace('"HEAD" >', `"${"a".repeat(40)}" >`);
  expect(targeted.match(/node -e '[^']*'/g)).toEqual(source.match(/node -e '[^']*'/g));
});
