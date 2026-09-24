import { readSkillText } from "../../../test/skill-text.js";
import { resolve } from "node:path";
import { it, expect } from "vitest";
it.each(["dogfood", "topic", "review", "arbiter"])("%s pins operative declared-checks policy", async (skill) => {
  const text = await readSkillText(resolve(".agentrig/skills", skill, "SKILL.md"), "utf8");
  expect(text).not.toMatch(/pnpm/i);
  const policy = text.split("## Operative declared-checks policy (issue #395)")[1]?.split("\n## ")[0] ?? "";
  for (const required of ["shipping policy §3", "GREEN BEFORE launching", "must be", "reviewers do NOT run checks", "name, command, exit code, UTC start/end, counts", "declared checks: none", "exact-head CI plus human merge authorization", "permission", "project-checks.js", "bootstrap and preflight"]) expect(policy).toContain(required);
});

it("pins actual review flow and exact PR-head preparation", async () => {
  const review = await readSkillText(resolve(".agentrig/skills/review/SKILL.md"), "utf8");
  const isolate = review.split("## 2. Isolate")[1]?.split("\n## ")[0] ?? "";
  expect(isolate).toContain("Standalone review also requires conductor-prepared dependencies, build outputs and exact-head receipts");
  expect(isolate).not.toContain("otherwise create");
  const proof = review.split("## 3. Inspect independent proof, then review code")[1]?.split("\n## ")[0] ?? "";
  for (const required of ["head against the review head", "all declared step names and order", "individual exit codes, times and counts", "missing or failed proof", "return to the conductor"]) expect(proof).toContain(required);
  const topic = await readSkillText(resolve(".agentrig/skills/topic/SKILL.md"), "utf8");
  expect(topic).toContain("assert each tree HEAD equals current PR HEAD");
  expect(topic).toContain("update the PR and re-prove its new head");
  expect(topic).not.toContain('git -C "$WT" merge --no-edit origin/main');
});

it("gates each declared reviewer launch on its tree's conductor preparation", async () => {
  const topic = await readSkillText(resolve(".agentrig/skills/topic/SKILL.md"), "utf8");
  const prepare = topic.split("- **Prepare.**")[1]?.split("- **Independent conductor checks")[0]?.replace(/\s+/g, " ") ?? "";
  for (const required of [
    "For nonempty steps the conductor runs declared bootstrap and optional preflight separately in every reviewer tree",
    "Require each command's exit code zero in each reviewer tree before launching any reviewer job",
    "On any failure halt before launch, persist receipts, join jobs",
    "then remove owned reviewer trees, conductor-proof tree and conductor-proof temporary root under **Review scratch cleanup**; only then halt",
    "Empty steps run no commands, including bootstrap/preflight",
    "A separate proof tree does not prepare reviewer dependencies",
  ]) expect(prepare).toContain(required);
});
