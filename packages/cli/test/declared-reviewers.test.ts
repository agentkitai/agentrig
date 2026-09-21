import { expect, it } from "vitest";
import { parseConfigText, resolveConfig } from "../src/config.js";
const slot = (name: string, provider = "first") => ({ name, adapter: "api", provider, model: "pinned-model" });
const providers = { first: { provider: "anthropic", model: "pinned-model" }, second: { provider: "openai", model: "pinned-model" } };
const parse = (reviewers: unknown, extra = {}) => parseConfigText("fixture", JSON.stringify({ providers, reviewers, ...extra }));
it.each([[], [slot("one")], [slot("one"), slot("two", "second")]].map(reviewers => ({ reviewers })))("accepts declared slots %j without routing duplication", ({ reviewers }) => {
  const config = parse(reviewers);
  expect(config).toHaveProperty("reviewers", reviewers);
  expect(resolveConfig({ defaults: {}, project: config })).not.toHaveProperty("reviewers");
});
it.each([
  [slot("a"), slot("b"), slot("c")], [slot("same"), slot("same")],
  [{ ...slot("a"), canRunChecks: true }], [{ ...slot("a"), model: " " }],
  [{ ...slot("a"), name: "bad\nname" }], [{ ...slot("a"), adapter: "unknown" }],
  [slot("a", "missing")], [slot("a", "constructor")], [{ ...slot("a"), model: "a\u2028b" }], [{ ...slot("a"), baseUrl: "https://example.com" }],
  [{ name: "a", adapter: "claude-cli", model: "pin", provider: "first" }],
].map(reviewers => ({ reviewers })))("rejects malformed declaration %j", ({ reviewers }) => expect(() => parse(reviewers)).toThrow());
it("supports strict CLI adapters and profile replacement including zero", () => {
  const config = parse([{ name: "a", adapter: "claude-cli", model: "pin-a" }, { name: "b", adapter: "codex-cli", model: "pin-b" }], { profiles: { none: { reviewers: [] }, api: { reviewers: [slot("api")] } } });
  expect(config.profiles?.none).toHaveProperty("reviewers", []);
  expect(resolveConfig({ defaults: {}, project: config, profile: "api" })).not.toHaveProperty("reviewers");
});
