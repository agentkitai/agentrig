import { describe, expect, it } from "vitest";
// @ts-expect-error standalone ESM review helper
import { findingIndex } from "../../../scripts/review-finding-index.mjs";
const url = "https://github.com/agentkitai/agentrig/pull/414#issuecomment-5749759933";
describe("live posted finding index", () => {
  it("M-paraphrased-heading: retains exact heading bytes and source comment anchor", () => {
    expect(findingIndex(url, { html_url: url, body: "## External review — slot\n### HIGH: Preserve `Exact`  heading\nText\n### LOW: Second\n" })).toEqual([
      { comment: url, heading: "### HIGH: Preserve `Exact`  heading" },
      { comment: url, heading: "### LOW: Second" },
    ]);
  });
  it("M-quoted-finding: ignores fenced or quoted examples, not real findings", () => {
    expect(findingIndex(url, { html_url: url, body: "```md\n### HIGH: Fake\n```\n> ### LOW: Quote\n### MEDIUM: Real" })).toEqual([{ comment: url, heading: "### MEDIUM: Real" }]);
  });
  it("M-legacy-numbered-heading: indexes the posted PR 414 heading form verbatim", () => {
    const heading = "### F7 — MEDIUM — a `__proto__` slot name silently becomes zero slots instead of being rejected";
    expect(findingIndex(url, { html_url: url, body: heading })).toEqual([{ comment: url, heading }]);
  });
  it("M-comment-mismatch: refuses a mismatched live comment", () => {
    expect(() => findingIndex(url, { html_url: url + "0", body: "### HIGH: Title" })).toThrow(/identity/);
    expect(() => findingIndex(url, { html_url: url, body: null })).toThrow(/body/);
    expect(() => findingIndex("https://evil.example/" , { html_url: url, body: "" })).toThrow(/URL/);
  });
});
