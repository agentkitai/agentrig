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

it("M-non-ATX-omission: indexes the live PR414 Codex finding and priority forms", () => {
  const headings = [
    "F1 — HIGH, blocking — Standalone `dogfood` still hard-codes the old two-reviewer flow, so valid declared-slot configs fail or are ignored.",
    "[P1] Preserve this exact priority title",
    "### [P2] Preserve ATX priority too",
  ];
  const codexUrl = "https://github.com/agentkitai/agentrig/pull/414#issuecomment-5749760055";
  expect(findingIndex(codexUrl, { html_url: codexUrl, body: "**Findings**\n\n" + headings.join("\n\n") })).toEqual(headings.map(heading => ({ comment: codexUrl, heading })));
});
it("M-recognizable-omission: refuses unsupported recognizable findings even after a valid finding", () => {
  for (const body of ["F2: HIGH — unsupported numbered finding", "[P4] Unknown priority", "### HIGH: indexed\nF2: LOW — omitted"]) {
    expect(() => findingIndex(url, { html_url: url, body })).toThrow(/unindexed finding/);
  }
});
it("clean verdict and fenced/quoted non-ATX examples are not omissions", () => {
  expect(findingIndex(url, { html_url: url, body: "VERDICT: PASS\nNo findings.\n~~~md\nF1: HIGH example\n~~~\n> [P4] quoted" })).toEqual([]);
});

it.each(["## High-level summary", "## Low-risk observations", "### P1 planning notes"])("does not index prose section %s", body => {
  expect(findingIndex(url, { html_url: url, body })).toEqual([]);
});
it.each([" ### HIGH: Actual", "  ### F1 — HIGH — Actual", "   ### [P1] Actual", "### **LOW**: Actual", "# CRITICAL: Actual"])("retains real and indented ATX bytes %s", heading => {
  expect(findingIndex(url, { html_url: url, body: heading })).toEqual([{ comment: url, heading }]);
});

// Unsupported severity openings must not vanish from the disposition ledger.
it.each([
  "### HIGH Something", "### MEDIUM Something else", "## LOW Vacuous assertion",
  "### HIGH", "### LOW", "### CRITICAL", "### P1", "### P1 Unsanitized tool emit",
  "### P1 prose following", "   ### **HIGH** Unsupported", "### HIGH: indexed\n### LOW Missing delimiter",
])("C1 fails closed on unsupported severity opening %s", body => {
  expect(() => findingIndex(url, { html_url: url, body })).toThrow(/unindexed finding/);
});
it.each([
  "### High-level summary of HIGH findings", "### HIGHLIGHTS: summary", "### LOWER: summary",
  "### P1 planning notes", "### P1 planning notes for release",
  "> ### HIGH Unsupported", "```md\n### HIGH Unsupported\n```",
])("C1 preserves ordinary prose and example exclusion %s", body => {
  expect(findingIndex(url, { html_url: url, body })).toEqual([]);
});

it.each([
  "HIGH confidence in the implementation.", "LOW risk remains after verification.",
  "MEDIUM is a severity token, not a finding here.", "CRITICAL issues were not observed.",
  "P1 work is scheduled next.", "HIGH", "P1 Unsanitized tool emit",
])("M-severity-prose: ordinary severity-token prose does not halt the index: %s", prose => {
  const heading = "### LOW: Actual finding";
  expect(findingIndex(url, { html_url: url, body: `${heading}\n${prose}` })).toEqual([{ comment: url, heading }]);
});

it.each([
  'An ordinary sentence quoting `### HIGH title` is not a heading.',
  'An ordinary sentence quoting `### HIGH — title` must not halt fallback.',
  "- **#444** — `unsupportedOpening` is ATX-scoped; P1 proves the new prose test is non-vacuous, P2 proves delimiter-less ALL-CAPS ATX headings still fail closed. The #431 exclusions, quoted/fenced exclusions, bare `F1 — HIGH —` grammar and exact-heading-bytes tests are all still present and green. Bare severity-with-delimiter prose (`HIGH: …`) still indexes, so the loosening is confined to delimiter-less non-heading lines — the design choice #444 explicitly authorized.",
  'The example `[P4]` is inline prose, not a finding.',
])("M-inline-fallback: ignores grammar examples in prose: %s", prose => {
  const headings = ["### LOW: First", "### LOW: Second", "### LOW: Third", "### LOW: Fourth"];
  expect(findingIndex(url, { html_url: url, body: [...headings, prose].join("\n") }))
    .toEqual(headings.map(heading => ({ comment: url, heading })));
});
