import { describe, expect, it } from "vitest";
import { BracketedPasteDecoder, InputBuffer } from "../src/tui/input-buffer.ts";

const ESC = "\u001b";

function inputHarness(): {
  feed: (chunk: string) => void;
  enter: () => void;
  value: () => string;
  submitted: string[];
} {
  let timer: (() => void) | null = null;
  const submitted: string[] = [];
  const buffer = new InputBuffer(() => {}, {
    setTimer: (fn) => {
      timer = fn;
      return 1;
    },
    clearTimer: () => {
      timer = null;
    },
  });
  const decoder = new BracketedPasteDecoder();

  const consume = (chunk: string): void => {
    const decoded = decoder.feed(chunk);
    for (const segment of decoded.segments) {
      if (!segment.pasted && segment.text === "\r") {
        const line = buffer.value;
        buffer.set("", () => submitted.push(line));
      } else {
        buffer.set(buffer.value + segment.text.replace(/\r\n?/g, "\n"));
      }
    }
    const quiet = timer;
    timer = null;
    quiet?.();
  };

  return {
    feed: consume,
    enter: () => consume("\r"),
    value: () => buffer.value,
    submitted,
  };
}

describe("bracketed paste decoding", () => {
  it("strips markers while keeping pasted newlines in the input buffer", () => {
    const h = inputHarness();
    h.feed(`${ESC}[200~line one\r\nline two${ESC}[201~`);

    expect(h.value()).toBe("line one\nline two");
    expect(h.submitted).toEqual([]);
  });

  it("holds ESC[200 at a chunk edge until the split marker resolves", () => {
    const decoder = new BracketedPasteDecoder();

    expect(decoder.feed(`${ESC}[200`).segments).toEqual([]);
    expect(decoder.feed("~kept").segments).toEqual([{ text: "kept", pasted: true }]);
    expect(decoder.feed(`${ESC}[201~`).segments).toEqual([]);
  });

  it("holds a bare ESC at a chunk edge so no start-marker byte leaks", () => {
    const h = inputHarness();
    h.feed(ESC);
    h.feed("[200~split safely");
    h.feed(`${ESC}[201~`);

    expect(h.value()).toBe("split safely");
  });

  it("submits Enter outside markers but keeps a bare CR inside them as content", () => {
    const h = inputHarness();
    h.feed(`${ESC}[200~first\rsecond${ESC}[201~`);
    expect(h.value()).toBe("first\nsecond");
    expect(h.submitted).toEqual([]);

    h.enter();
    expect(h.submitted).toEqual(["first\nsecond"]);
  });

  it("keeps marker-only chunks on the stdin quiet-point path", () => {
    let timer: (() => void) | null = null;
    const drawn: string[] = [];
    const buffer = new InputBuffer((text) => drawn.push(text), {
      setTimer: (fn) => {
        timer = fn;
        return 1;
      },
      clearTimer: () => {
        timer = null;
      },
    });
    const decoder = new BracketedPasteDecoder();
    const feed = (chunk: string): void => {
      const decoded = decoder.feed(chunk);
      if (decoded.protocol) buffer.touch();
      for (const segment of decoded.segments) buffer.set(buffer.value + segment.text);
    };

    feed(`${ESC}[200~`);
    feed("x".repeat(64));
    feed(`${ESC}[201`);
    feed("~");
    expect(drawn, "drew before the split end marker reached the quiet point").toEqual([]);
    const quiet = timer;
    timer = null;
    quiet?.();
    expect(drawn).toEqual(["x".repeat(64)]);
  });

  it("strips an unmatched end marker instead of leaking it into ordinary input", () => {
    const decoder = new BracketedPasteDecoder();
    expect(decoder.feed(`${ESC}[201~ordinary`).segments).toEqual([
      { text: "ordinary", pasted: false },
    ]);
  });
});
