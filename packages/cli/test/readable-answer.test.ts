import { expect, it } from "vitest";
import { renderMarkdown } from "../src/tui/markdown.js";
import { markdownTable } from "../src/tui/viewport.js";

it.each([40, 80, 120])("preserves every permission explanation at %s columns", width => {
  const detail = "Future requests for this tool in the live session, regardless of resource or working directory.";
  const output = markdownTable(["Answer", "Effect"], [["Standing allow", detail], ["Allow once", "Only this request."]], width);
  expect(output).toContain(detail);
  expect(output).toContain("Only this request.");
  expect(output).not.toContain("elided");
  expect(output).not.toContain("…");
});

it("uses spare width for a long column before falling back to labelled rows", () => {
  expect(markdownTable(["A", "B"], [["x", "12345"]], 9)).toContain(" │ ");
  expect(markdownTable(["A", "B"], [["x", "12345"]], 8)).not.toContain(" │ ");
  expect(markdownTable(["A", "B"], [["x", "A moderately long explanation"]], 40))
    .toBe("A │ B                            \n──┼──────────────────────────────\nx │ A moderately long explanation");
  expect(markdownTable(["A", "B"], [["x", "A moderately long explanation"]], 15))
    .toBe("A: x\nB: A moderately long explanation");
});

it("keeps complete Unicode cells and explicit structural omission notices", () => {
  const value = "你好 👨‍👩‍👧‍👦 café é";
  expect(markdownTable(["説明"], [[value]], 5)).toContain(value);
  expect(markdownTable(["A"], [["x"]], 80, true)).toContain("omitted");
  expect(markdownTable(["Very long header"], [], 5)).toBe("Very long header");
});

it("shows matching local file citations once, retaining the full path and line range", () => {
  expect(renderMarkdown("[grants.ts:12–56](packages/core/src/grants.ts#L12-L56)", 80, false))
    .toBe("packages/core/src/grants.ts:12–56");
  expect(renderMarkdown("[packages/core/src/grants.ts:12](packages/core/src/grants.ts#L12)", 80, false))
    .toBe("packages/core/src/grants.ts:12");
});

it("never hides a different citation target or arbitrary link label", () => {
  for (const source of [
    "[grants.ts:12](packages/core/src/grants.ts#L13)",
    "[policy.ts:12](packages/core/src/grants.ts#L12)",
    "[explanation](packages/core/src/grants.ts#L12)",
    "[grants.ts:12](https://example.test/grants.ts#L12)",
    "[grants.ts:12](//example.test/grants.ts#L12)",
  ]) expect(renderMarkdown(source, 80, false)).toContain(" (");
});
