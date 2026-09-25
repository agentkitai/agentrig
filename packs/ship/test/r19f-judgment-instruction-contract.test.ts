import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { readSkillText } from "../../../test/skill-text.js";
const skill = (name: string) => readSkillText(`.agentrig/skills/${name}/SKILL.md`).replace(/\s+/g, " ");
const policy = () => readFileSync(new URL("../docs/SHIPPING-WORKFLOW.md", import.meta.url), "utf8").replace(/\s+/g, " ");

it("retires mandatory manual dispatch handoff, retaining hook provenance and receipt inputs", () => {
  for (const text of [skill("dogfood"), policy()]) {
    const check = (value: string) => {
      expect(value).not.toMatch(/handoff comment must quote|fixer must post and read back|Post and read back this handoff before every fixer push/);
      expect(value).toContain("pre_spawn hook owns");
      expect(value).toContain("persisted receipt, exact finding identities and counter");
    };
    check(text);
    expect(() => check(text + " The fixer must post and read back a handoff.")).toThrow();
    expect(() => check(text.replace("pre_spawn hook owns", "manual bookkeeping owns"))).toThrow();
  }
});

const landPhrases = [
  "Fetch every ledger source comment live at landing, including nonblocking deferred and advisory findings, even when no fixer is dispatched.",
  "Compare its exact verbatim finding heading and comment URL/anchor against the ledger, not the conductor's paraphrase.",
  "A missing, edited or mismatched heading/anchor blocks landing even when the local finding ID matches",
  "Source changes after ledger writes are not covered by the write-time hook or the minimal merge guard",
];
for (const phrase of landPhrases) it(`land source judgment deletion mutant: ${phrase}`, () => {
  const check = (text: string) => expect(text).toContain(phrase);
  const text = skill("land");
  check(text);
  expect(() => check(text.replace(phrase, "REMOVED"))).toThrow();
});

const amendmentPhrases = [
  "Above round 3, use `N/N` and first record one operative PR-body line `Human amendment: Repair round: N/N; authorization: <JSON-quoted verbatim human authorization>` for that exact round.",
  "This is a conductor-recorded human amendment, not automatic GitHub-author authentication; never invent an authorization or copy task text as authority.",
  "A larger denominator or unrelated round amendment alone cannot authorize dispatch.",
  "Hook validation checks syntax, not human provenance.",
];
for (const phrase of amendmentPhrases) it(`human authority deletion mutant: ${phrase}`, () => {
  for (const text of [skill("ship"), policy()]) {
    const check = (value: string) => expect(value).toContain(phrase);
    check(text);
    expect(() => check(text.replace(phrase, "REMOVED"))).toThrow();
  }
});
