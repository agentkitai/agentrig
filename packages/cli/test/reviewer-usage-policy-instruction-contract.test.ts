import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { readSkillText } from "../../../test/skill-text.js";

const ship = readSkillText(new URL("../../../.agentrig/skills/ship/SKILL.md", import.meta.url));
const dogfood = readSkillText(new URL("../../../.agentrig/skills/dogfood/SKILL.md", import.meta.url));
const review = readSkillText(new URL("../../../.agentrig/skills/review/SKILL.md", import.meta.url));
const land = readSkillText(new URL("../../../.agentrig/skills/land/SKILL.md", import.meta.url));
const topic = readSkillText(new URL("../../../.agentrig/skills/topic/SKILL.md", import.meta.url));
const policy = readFileSync(new URL("../../../docs/SHIPPING-WORKFLOW.md", import.meta.url), "utf8");

it("pins the adapter invocation once beside launch and exempts pre-launch usage errors from reviewer retry", () => {
  const invocation = "node scripts/reviewer-adapters.mjs <config> <slot> <prompt-file> <owned-worktree> <absolute-output-prefix>";
  expect(ship.split(invocation)).toHaveLength(2);
  const launch = ship.slice(ship.indexOf("Two slots launch"), ship.indexOf("### Review finding integrity"));
  expect(launch).toContain(invocation);
  for (const text of [ship, policy]) {
    expect(text).toMatch(/exit 64 before vendor launch/);
    expect(text).toMatch(/no .*\.stdout/);
    expect(text).toMatch(/conductor error/);
    expect(text).toMatch(/does not consume the slot's single .*retry/);
  }
});

it("distinguishes a dispatched fixer task from the durable fixer pre-push handoff", () => {
  for (const text of [ship, topic]) expect(text).toContain("verbatim in the dispatched fixer task");
  expect(dogfood).toContain("durable pre-push GitHub PR handoff comment");
  for (const text of [land, policy]) expect(text).toContain("missing durable fixer pre-push handoff alone is not a halt");
});

it("propagates the verbatim human authorization quote exception to PR-body review and shared policy", () => {
  for (const text of [dogfood, review, policy]) {
    expect(text).toContain("verbatim human authorization quote");
    expect(text).toContain("preserve the quote unchanged");
    expect(text).toContain("never add model or agent authorship attribution");
  }
  expect(review).toContain("single PR-body and squash-body exception");
  expect(policy).toContain("single PR-body and squash-body exception");
});
