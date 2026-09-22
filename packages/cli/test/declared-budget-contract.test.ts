import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import ts from "typescript";

// These are latency allowances for expensive fixture work, not weaker assertions.
const cases = [
  ["../../core/test/skill-text-instruction-contract.test.ts", "every repository skill instruction reader uses the shared skill-text loader", 30_000],
  ["reviewer-adapters.test.ts", "%s launch template, raw provenance and stale-artifact refusal", 30_000],
  ["packages-runtime.test.ts", "accepts actual npm pack --ignore-scripts output with identical selected content", 60_000],
  ["evalset.test.ts", "vendors exact upstream bytes and runs all upstream cases separately", 30_000],
  ["evalset.test.ts", "A4 rejects summed/zero accounting and ungrounded answers", 30_000],
] as const;
it.each(cases)("%s: %s retains its explicit Vitest budget", (file, title, budget) => {
  const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const found: ts.CallExpression[] = [];
  function walk(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === title) found.push(node);
    ts.forEachChild(node, walk);
  }
  walk(source);
  expect(found).toHaveLength(1);
  expect(Number(found[0]?.arguments[2]?.getText(source).replaceAll("_", ""))).toBe(budget);
});

it("evalset prepareMechanics retains its explicit hook budget independent of testTimeout", () => {
  const file = "evalset.test.ts";
  const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const found: ts.CallExpression[] = [];
  function preparesMechanics(node: ts.Node): boolean {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "prepareMechanics") return true;
    return ts.forEachChild(node, preparesMechanics) === true;
  }
  function walk(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "beforeAll"
      && node.arguments[0] && preparesMechanics(node.arguments[0])) found.push(node);
    ts.forEachChild(node, walk);
  }
  walk(source);
  expect(found).toHaveLength(1);
  // Vitest takes hook timeouts in argument two, unlike the test budgets above.
  expect(Number(found[0]?.arguments[1]?.getText(source).replaceAll("_", ""))).toBe(30_000);
});
