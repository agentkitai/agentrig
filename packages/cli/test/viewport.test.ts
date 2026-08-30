import { describe, expect, it } from "vitest";
import { fitToRows, liveRows } from "../src/tui/viewport.ts";

describe("fitToRows", () => {
  it("leaves text that already fits exactly as it was", () => {
    expect(fitToRows("", 80, 4)).toBe("");
    expect(fitToRows("fix the retry logic", 80, 4)).toBe("fix the retry logic");
    // the boundary itself fits: budget characters is not one too many
    const exact = "x".repeat(320);
    expect(fitToRows(exact, 80, 4)).toBe(exact);
  });

  it("never returns more than the budget, however long the text is", () => {
    for (const length of [321, 1_000, 2_500, 100_000]) {
      const out = fitToRows("x".repeat(length), 80, 4);
      expect(out.length, `${length} chars`).toBeLessThanOrEqual(320);
    }
  });

  it("keeps the tail, because the end is what you are typing", () => {
    const text = "head".padEnd(996, "-") + "tail";
    const out = fitToRows(text, 80, 4);
    expect(out.endsWith("tail")).toBe(true);
    expect(out).not.toContain("head");
  });

  it("says how much it is not showing", () => {
    // 1,000 characters into a 320-column budget: what is hidden is stated, and stated in full
    const out = fitToRows("x".repeat(1_000), 80, 4);
    expect(out).toMatch(/^…\([\d,]+ more\) /);
    const hidden = Number(/\(([\d,]+) more\)/.exec(out)![1]!.replaceAll(",", ""));
    expect(hidden).toBe(680);
  });

  it("still draws something in a terminal too small to have a budget", () => {
    // 0 or negative width would make the budget zero and hide the line entirely
    for (const [columns, rows] of [[0, 4], [-10, 4], [80, 0], [80, -1]] as const) {
      const out = fitToRows("x".repeat(50), columns, rows);
      expect(out.length, `${columns}x${rows}`).toBeGreaterThan(0);
    }
  });
});

describe("liveRows", () => {
  it("leaves room in the frame for everything that is not the growable region", () => {
    // The cliff is reached by the frame as a whole: the prompt, the status line, a permission
    // prompt and the margins between them all sit in it too. `< rows` is not enough — in a short
    // window a viewport that merely fits still pushes the frame over once the rest is added.
    const FURNITURE = 8;
    for (const rows of [10, 12, 16, 24, 30, 50, 200]) {
      expect(liveRows(rows) + FURNITURE, `${rows} rows`).toBeLessThanOrEqual(Math.max(rows, 9));
    }
  });

  it("caps the region even in a very tall window", () => {
    expect(liveRows(200)).toBe(8);
    expect(liveRows(200, 3)).toBe(3);
  });

  it("returns a drawable number of rows for a window it was told nothing about", () => {
    for (const rows of [undefined, 0, -5, 1, 8]) {
      expect(liveRows(rows), String(rows)).toBeGreaterThanOrEqual(1);
    }
  });
});
