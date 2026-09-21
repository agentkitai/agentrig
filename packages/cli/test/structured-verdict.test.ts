import { expect, it } from "vitest";
import { preservedReviews } from "./preserved-review-455.js";
// @ts-expect-error standalone helper
import { parseVerdict, verdictBlock } from "../../../scripts/review-verdict.mjs";
const head = "a".repeat(40);
const expected = { reviewedHead: head, slot: "Codex", assertedModel: "gpt-5.5" };
const valid = { version: 1, ...expected, modelSource: "codex-launch", verdict: "PASS", findings: [] };
it("preserves PR455 prose without using its first line or echoes as authority", () => {
  for (const prose of preservedReviews) {
    expect(() => parseVerdict(prose, expected)).toThrow(/exactly one complete/);
    expect(parseVerdict(`${prose}\n${verdictBlock(valid)}`, expected)).toEqual(valid);
    expect(() => parseVerdict(`${prose}\n${verdictBlock({...valid, reviewedHead: "b".repeat(40)})}`, expected)).toThrow(/reviewedHead/);
  }
});
// Preserved diagnostic excerpts: #320 row115, issuecomment-5760111094;
// trial-320/logs/115-frontier-resume3.out, secondary-diagnostic.md.
it.each(["I independently reviewed de6915934d1ae98650b04f721b5568c9b4c9cdf1..cb8e779dcee47694d70f98674de870a76bdb630e", " error headlines distinguish zero, partial and all confirmed posts while retaining receipt"])("#320 row115 prose is data: %s", prose => {
  expect(parseVerdict(`${prose}\n${verdictBlock(valid)}`, expected)).toEqual(valid);
  expect(() => parseVerdict(`${prose}\n${verdictBlock({...valid, reviewedHead: `${head}~1..${head}`})}`, expected)).toThrow();
});
it.each([{}, {...valid, modelSource: ""}, {...valid, assertedModel:"wrong"}, {...valid, slot:"other"}, {...valid, findings:[{ severity:"HIGH" }]}, {...valid, verdict:"MAYBE"}])("rejects invalid schema/binding, never falls back: %j", value => {
  expect(() => parseVerdict(verdictBlock(value), expected)).toThrow();
});
it("schema headings have no grammar and PASS cannot conceal blocking findings", () => {
  const finding = {severity:"HIGH", heading:"any verbatim heading", location:"scripts/tool.mjs:12", blocking:true, scenario:"A stale model assertion is accepted."};
  expect(parseVerdict(verdictBlock({...valid, verdict:"FAIL", findings:[finding]}), expected).findings).toEqual([finding]);
  expect(() => parseVerdict(verdictBlock({...valid, findings:[finding]}), expected)).toThrow();
});
it("requires exactly one complete machine block", () => {
  expect(() => parseVerdict("VERDICT: PASS", expected)).toThrow();
  expect(() => parseVerdict(verdictBlock(valid) + verdictBlock(valid), expected)).toThrow();
  expect(() => parseVerdict("<!-- agentrig-verdict:v1 -->\n{", expected)).toThrow();
});

it.each(["F1 [HIGH] title", "F1: [HIGH] title"])("#473 legacy fallback accepts %s verbatim", async heading => {
  // @ts-expect-error standalone helper
  const { findingHeadings, assertReviewerVerdict } = await import("../../../scripts/review-finding-index.mjs");
  const logs: string[] = [];
  expect(assertReviewerVerdict(heading, {}, (line: string) => logs.push(line))).toBeNull();
  expect(logs.join()).toContain("nonfatal");
  expect(findingHeadings(heading)).toEqual([heading]);
});
