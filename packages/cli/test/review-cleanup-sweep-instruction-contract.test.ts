import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
it("review skill receives receipts, reviews code, and restores optional probes", () => {
  const body = read(".agentrig/skills/review/SKILL.md").replace(/\s+/g, " ");
  expect(body).toContain("Missing or stale receipts block");
  expect(body).toContain("Never run the project's");
  expect(body).toContain("reviewer-owned probes or named mutants");
  expect(body).toContain("restore all changes");
});
it("all shipping roles retain ordered scratch cleanup", () => {
  for (const skill of ["topic", "ship", "dogfood"]) {
    const body = read(`.agentrig/skills/${skill}/SKILL.md`).replace(/\s+/g, " ");
    expect(body.toLowerCase()).toContain("join every");
    expect(body).toContain("restored tracked/index state");
    expect(body.toLowerCase()).toMatch(/persist|proof persisted/);
  }
});
