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
it("M-raw-prototype-key: rejects own __proto__ before record normalization", () => {
  expect(() => parseConfigText("fixture", '{"reviewers":{"__proto__":{"adapter":"codex-cli","model":"pin"}}}')).toThrow(/invalid reviewer slot name/);
});
