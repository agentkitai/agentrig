import { describe, expect, it } from "vitest";
import { fitToRows, liveRows, measureRows } from "../src/tui/viewport.ts";

/**
 * The property that matters is `measureRows(fitToRows(t, c, r), c) <= r` — how tall the result
 * renders. Asserting on `.length` instead is what let the first version of this file ship a
 * character budget that a streamed reply full of line breaks walked straight past.
 */

describe("measureRows", () => {
  it("counts wrapped rows, and a line break is a row whatever precedes it", () => {
    expect(measureRows("", 80)).toBe(1);
    expect(measureRows("short", 80)).toBe(1);
    expect(measureRows("x".repeat(160), 80)).toBe(2);
    expect(measureRows("x".repeat(161), 80)).toBe(3);
    // ten characters, ten rows: the shape a bulleted answer or a code block has
    expect(measureRows("a\nb\nc\nd\ne\nf\ng\nh\ni\nj", 80)).toBe(10);
    expect(measureRows("\n\n\n", 80)).toBe(4);
  });

  it("measures display columns rather than code units", () => {
    // a wide character takes two columns, so half as many fit on a row
    expect(measureRows("漢".repeat(40), 80)).toBe(1);
    expect(measureRows("漢".repeat(41), 80)).toBe(2);
  });
});

describe("fitToRows", () => {
  it("leaves text that already fits exactly as it was", () => {
    expect(fitToRows("", 80, 4)).toBe("");
    expect(fitToRows("fix the retry logic", 80, 4)).toBe("fix the retry logic");
    // the boundary itself fits: four rows is not one too many
    const exact = "x".repeat(320);
    expect(fitToRows(exact, 80, 4)).toBe(exact);
    expect(fitToRows("one\ntwo\nthree\nfour", 80, 4)).toBe("one\ntwo\nthree\nfour");
  });

  it("never renders taller than the budget, whatever shape the text is", () => {
    const shapes: Array<[string, string]> = [
      ["one long line", "x".repeat(100_000)],
      // the case the character budget missed entirely: short lines, so rows >> characters/columns
      ["short lines", Array.from({ length: 400 }, (_, i) => `- point ${i}`).join("\n")],
      ["blank lines", "\n".repeat(500)],
      ["a fenced block", `prose\n\n\`\`\`ts\n${"const x = 1;\n".repeat(200)}\`\`\`\n`],
      ["wide characters", "漢字".repeat(5_000)],
      ["one line too wide for the budget", "x".repeat(5_000)],
    ];
    for (const [name, text] of shapes) {
      for (const [columns, rows] of [[80, 8], [80, 1], [40, 3], [5, 1], [1, 1], [200, 8]] as const) {
        const out = fitToRows(text, columns, rows);
        expect(measureRows(out, columns), `${name} at ${columns}x${rows}`).toBeLessThanOrEqual(rows);
      }
    }
  });

  it("keeps the tail, because the end is what you are typing", () => {
    const text = "head".padEnd(996, "-") + "tail";
    expect(fitToRows(text, 80, 4).endsWith("tail")).toBe(true);
    expect(fitToRows(text, 80, 4)).not.toContain("head");
    // and whole lines where it can, rather than slicing one in half
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    expect(fitToRows(lines, 80, 4).endsWith("line 49")).toBe(true);
  });

  it("says how much it is not showing, and says it accurately", () => {
    const text = "x".repeat(1_000);
    const out = fitToRows(text, 80, 4);
    const hidden = Number(/\(([\d,]+) more\)/.exec(out)![1]!.replaceAll(",", ""));
    // the marker itself occupies part of the budget, so the count has to be derived from what was
    // actually kept — deriving it from the budget instead under-reported by the marker's width
    const kept = out.slice(out.indexOf("\n") + 1);
    expect(hidden).toBe(text.length - kept.length);
    expect(kept.length + hidden).toBe(text.length);
  });

  it("still draws something in a terminal too small to have a budget", () => {
    // 0 or negative width or height would make the budget zero and hide the line entirely
    for (const [columns, rows] of [[0, 4], [-10, 4], [80, 0], [80, -1]] as const) {
      expect(fitToRows("x".repeat(50), columns, rows).length, `${columns}x${rows}`).toBeGreaterThan(0);
    }
  });
});

describe("liveRows", () => {
  /**
   * What the frame actually has to satisfy. `app.tsx` draws two growable regions — the streaming
   * reply and the input buffer — a prompt row, a status row and the margins between them.
   */
  const frameHeight = (rows: number): number => 2 * liveRows(rows) + 3;

  it("leaves room for BOTH growable regions plus the rest of the frame", () => {
    // budgeting each region against the whole window left every terminal from 12 to 20 rows
    // freezing exactly as before as soon as someone typed while a reply was streaming
    for (const rows of [10, 12, 14, 16, 18, 20, 24, 30, 50, 200]) {
      expect(frameHeight(rows), `${rows} rows`).toBeLessThan(rows);
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
