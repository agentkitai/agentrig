import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
it("topic step 4 launches declared slots only after conductor receipts", () => {
  const body = read(".agentrig/skills/topic/SKILL.md");
  const section = body.split("4. Run the **declared external-review pass**")[1]?.split("5. Record every child session id")[0] ?? "";
  expect(section).toContain("zero, one, or two slots");
  expect(section).toContain("conductor checks before any launch");
  expect(section).toContain("never ask reviewers to run project checks");
  expect(section).toContain("For zero slots");
  expect(section).toContain("For one");
  expect(section).toContain("For two");
});
it("role wording rejects project-check authority in reviewer declarations", () => {
  for (const skill of ["topic", "ship", "review", "dogfood", "land"]) {
    const body = read(`.agentrig/skills/${skill}/SKILL.md`).replace(/\s+/g, " ");
    expect(body).toContain("never rerun project checks");
    expect(body).not.toContain("canRunChecks:");
  }
});
