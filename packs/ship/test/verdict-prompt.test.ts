import { expect, it } from "vitest";
// @ts-expect-error standalone helper
import { parseVerdict, verdictBlock, verdictPrompt } from "../scripts/review-verdict.mjs";

const bindings = { reviewedHead: "a".repeat(40), assertedModel: "fixture-pin", slot: "fixture-slot" };
const verdict = { version: 1, ...bindings, modelSource: "fixture", verdict: "FAIL" };

it.each([true, false])("rendered finding shape presents blocking as a boolean: %s", blocking => {
  const prompt = verdictPrompt({ ...bindings, modelSource: "fixture" });
  const shapes = prompt.match(/\{"severity":.*?\}/g);
  expect(shapes).toHaveLength(1);
  const shape = shapes![0]!;
  expect(shape).toContain('"blocking":<true|false>');
  // Fill the rendered template, rather than constructing a separate example.
  const finding = JSON.parse(shape
    .replace("<CRITICAL|HIGH|MEDIUM|LOW>", "LOW")
    .replace("<exact verbatim heading>", "Fixture finding")
    .replace("<file:line>", "fixture.ts:1")
    .replace("<true|false>", String(blocking))
    .replace("<concrete failure scenario>", "Fixture scenario"));
  expect(finding.blocking).toBe(blocking);
  expect(parseVerdict(verdictBlock({ ...verdict, findings: [finding] }), bindings).findings).toEqual([finding]);
});

it.each(["true", "false", "", null, 0, 1])("keeps the schema strict for non-boolean blocking: %j", blocking => {
  const finding = { severity: "LOW", heading: "Fixture finding", location: "fixture.ts:1", blocking, scenario: "Fixture scenario" };
  expect(() => parseVerdict(verdictBlock({ ...verdict, findings: [finding] }), bindings)).toThrow(/blocking/);
});
