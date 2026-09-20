import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseConfigText, resolveConfig } from "../src/config.js";
const parse = (value: unknown) => parseConfigText("fixture", JSON.stringify(value));
const providers = { first: { provider: "openai", model: "model-one", baseUrl: "https://one.example/v1" }, second: { provider: "anthropic", model: "model-two" } };
const slots = { primary: { adapter: "api:first", model: "model-one" }, secondary: { adapter: "api:second", model: "model-two" } };
it.each([{}, { primary: slots.primary }, slots])("accepts 0, 1 and 2 slots with existing provider bindings: %j", reviewers => {
  const config = parse({ providers, reviewers });
  expect(config).toHaveProperty("reviewers", reviewers);
  expect(resolveConfig({ defaults: {}, project: config })).not.toHaveProperty("reviewers");
});
it.each([
  { a: slots.primary, b: slots.primary, c: slots.primary },
  { a: { adapter: "unknown", model: "model-one" } },
  { a: { adapter: "api:missing", model: "model-one" } },
  { a: { adapter: "api:first", model: "wrong" } },
  { a: { adapter: "claude-cli", model: "" } },
  { a: { adapter: "codex-cli", model: "model-one", canRunChecks: false } },
  { "bad\nslot": slots.primary },
])("rejects invalid reviewer declaration %j", reviewers => expect(() => parse({ providers, reviewers })).toThrow());
it("accepts named CLI bindings and absent declaration", () => {
  expect(parse({ reviewers: { "Team One": { adapter: "claude-cli", model: "pin-1" }, other: { adapter: "codex-cli", model: "pin-2" } } })).toHaveProperty("reviewers");
  expect(parse({})).not.toHaveProperty("reviewers");
});
const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");
for (const skill of ["topic", "ship", "review", "land", "dogfood", "arbiter"]) {
  it(`${skill} uses declared slots and no vendor literals`, () => {
    const text = read(`.agentrig/skills/${skill}/SKILL.md`);
    expect(text).not.toMatch(/claude|codex|opus|gpt-\d/i);
    for (const phrase of ["declared reviewer slots", "External review: none declared", "slot's pinned model", "reviewers do NOT run checks"]) expect(text).toContain(phrase);
    expect(text).toContain("## External review — <slot> (<model>) — head <SHA> — merged with origin/main <MAIN> — full");
  });
}
it("policy deletes the reviewer-trio exception and gates launch on independent proof", () => {
  const policy = read("docs/SHIPPING-WORKFLOW.md").split("## 3.")[1]!.split("## 4.")[0]!;
  expect(policy).not.toMatch(/claude|codex|canRunChecks/i);
  expect(policy).toContain("GREEN BEFORE launching any reviewer");
  expect(policy).toContain("reviewers do NOT run checks");
});

// Instruction policy remains outside core. These fixtures exercise the declaration and pin
// the launch/landing rules each count must select; removing a branch or reversing proof order
// is a named instruction mutant, not a simulated workflow engine in production.
it.each([{}, { primary: slots.primary }, slots])("M-count-branches: fixture %j retains proof-before-review and landing gates", reviewers => {
  const config = parse({ providers, reviewers });
  const count = Object.keys(config.reviewers!).length;
  const topic = read(".agentrig/skills/topic/SKILL.md");
  const step = topic.slice(topic.indexOf("4. Run the **external review pass**"), topic.indexOf("5. Record"));
  const assertOrder = (text: string) => {
    const proof = text.indexOf("Require GREEN BEFORE launching any reviewer");
    const launch = text.indexOf("node <REPO>/scripts/reviewer-adapters.mjs");
    expect(proof).toBeGreaterThan(-1);
    expect(launch).toBeGreaterThan(proof);
    expect(text).toContain("Supply receipts to every slot");
  };
  assertOrder(step);
  expect(() => assertOrder(step.replace("Require GREEN BEFORE launching any reviewer", "CI will provide evidence later"))).toThrow();
  if (count === 0) expect(step).toContain("Zero slots: persist `External review: none declared`, skip all reviewer preparation/dispatch");
  if (count === 1) expect(topic).toContain("that same slot is the focused-delta reviewer");
  if (count === 2) expect(topic).toContain("both independently");
  const land = read(".agentrig/skills/land/SKILL.md");
  for (const gate of ["Land requires only declared headings", "exact-head hosted CI", "scoped human authorization"]) expect(land).toContain(gate);
});
it("M-vendor-literal and M-pin-gate are rejected instruction mutants", () => {
  const check = (text: string) => {
    expect(text).not.toMatch(/claude|codex|opus|gpt-\d/i);
    expect(text).toContain("initial heading model must equal the slot's pinned model");
  };
  const text = read(".agentrig/skills/land/SKILL.md");
  check(text);
  expect(() => check(text + "\nUse Codex instead")).toThrow();
  expect(() => check(text.replace("initial heading model must equal the slot's pinned model", "any model satisfies review"))).toThrow();
});

it("keeps topic posting continuations and adapter fences inside the enclosing CommonMark list", () => {
  const text = readFileSync(new URL("../../../.agentrig/skills/topic/SKILL.md", import.meta.url), "utf8");
  const start = text.indexOf("   - **Launch each slot through its adapter**");
  const end = text.indexOf("   - **Combine.**", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const lines = text.slice(start, end).split("\n");
  // Three spaces for the numbered item, two for its nested bullet. Blank lines
  // terminate lazy continuation: prose AND opening fences must retain all five.
  for (const line of lines.filter(line => line.trim() && !line.startsWith("   - "))) {
    expect(line, "posting continuation escaped enclosing list").toMatch(/^ {5}\S|^ {5}\s/);
  }
  expect(lines.filter(line => line === "     ```sh")).toHaveLength(2);
  expect(lines.filter(line => line === "     ```")).toHaveLength(2);
});

it("standalone dogfood delegates the entire slot lifecycle without fixed launch/post/cleanup", () => {
  const text = read(".agentrig/skills/dogfood/SKILL.md");
  const flow = text.split("## 8.")[1]!.split("## 9.")[0]!;
  for (const phrase of ["Zero slots", "One slot", "Two slots", "API", "topic §2 step 4", "validated", "Review scratch cleanup"]) expect(flow).toContain(phrase);
  expect(text).not.toMatch(/review pair|initial pair|both reviews|both trees|CODEX_WT|conductor-trio/);
});
it("M-raw-prototype-key: rejects own __proto__ before record normalization", () => {
  expect(() => parseConfigText("fixture", '{"reviewers":{"__proto__":{"adapter":"codex-cli","model":"pin"}}}')).toThrow(/invalid reviewer slot name/);
});
