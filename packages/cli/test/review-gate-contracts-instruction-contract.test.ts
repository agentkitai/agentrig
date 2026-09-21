import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
it("land gates exactly the configured count and model pins", () => {
  const body = read(".agentrig/skills/land/SKILL.md");
  const gate = body.split("## 1. Preconditions")[1]?.split("## 2.")[0] ?? "";
  for (const phrase of ["zero slots", "one or two slots", "every and only configured slot", "model must exactly equal", "sole slot for one", "declared slot for two"]) expect(gate).toContain(phrase);
});
it("ship section 2 establishes independent same-head ordering", () => {
  const body = read(".agentrig/skills/ship/SKILL.md");
  const gate = body.split("## 2.")[1]?.split("## 3.")[0] ?? "";
  expect(gate).toContain("independently check out the PR HEAD");
  expect(gate).toContain("before launching any reviewer");
  expect(gate).toContain("Hosted CI may run concurrently");
});
