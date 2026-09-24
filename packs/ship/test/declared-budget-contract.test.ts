import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import ts from "typescript";

// These are latency allowances for expensive fixture work, not weaker assertions.
const cases = [
  ["./skill-text-instruction-contract.test.ts", "every repository skill instruction reader uses the shared skill-text loader", 30_000],
  ["./reviewer-adapters.test.ts", "%s launch template, raw provenance and stale-artifact refusal", 30_000],
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
