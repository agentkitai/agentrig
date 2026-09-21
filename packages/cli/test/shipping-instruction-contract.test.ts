import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const skills = ["topic", "ship", "review", "dogfood", "land"];
const required = [
  "zero, one, or two", "Before any reviewer launch", "exact HEAD", "receipts to every reviewer",
  "code review only", "reviewer-owned probes", "scripts/reviewer-adapter.mjs",
  "## External review — <slot> (<model>) — head <SHA> — full",
  "External review: none declared", "With one slot", "With two",
];
for (const name of skills) {
  it(`${name} pins the declared reviewer contract and named mutants`, () => {
    const body = read(`.agentrig/skills/${name}/SKILL.md`).replace(/\s+/g, " ");
    for (const phrase of required) expect(body, `${name}: ${phrase}`).toContain(phrase);
    for (const phrase of required) expect(body.replaceAll(phrase, "MUTANT"), `${name}: deleted ${phrase}`).not.toContain(phrase);
  });
  it(`${name} contains no reviewer-vendor literals`, () => {
    expect(read(`.agentrig/skills/${name}/SKILL.md`)).not.toMatch(/claude|codex|anthropic|openai/i);
  });
  it(`${name} preserves the instruction contract in a CRLF fixture`, () => {
    const copied = read(`.agentrig/skills/${name}/SKILL.md`).replace(/\r?\n/g, "\r\n").replace(/\s+/g, " ");
    for (const phrase of required) expect(copied, `${name} CRLF: ${phrase}`).toContain(phrase);
    expect(copied).not.toMatch(/claude|codex|anthropic|openai/i);
  });
}
it("shipping policy has no historical reviewer-trio special case", () => {
  const body = read("docs/SHIPPING-WORKFLOW.md");
  expect(body).toContain("Reviewers receive the independent conductor receipts and perform code review only");
  expect(body).not.toMatch(/reviewer-trio|conductor trio|Codex trio evidence/);
});
