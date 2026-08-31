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
      for (const segment of decoded.segments) buffer.set(buffer.value + segment.text);
      if (decoder.isPasting || decoder.hasPendingMarker) buffer.hold();
      else if (decoded.protocol) buffer.touch();
    };

    feed(`${ESC}[200~`);
    expect(timer, "armed a draw while the opening marker was unresolved").toBeNull();
    feed("x".repeat(64));
    expect(timer, "armed a draw while paste payload was still open").toBeNull();
    feed(`${ESC}[201`);
    expect(timer, "armed a draw while the closing marker was incomplete").toBeNull();
    feed("~");
    expect(drawn, "drew before the split end marker reached the quiet point").toEqual([]);
    const quiet = timer;
    timer = null;
    quiet?.();
    expect(drawn).toEqual(["x".repeat(64)]);
  });

  it("does not mistake ordinary bracket text for an ESC-prefixed marker", () => {
    const decoder = new BracketedPasteDecoder();
    expect(decoder.feed("[")).toEqual({
      segments: [{ text: "[", pasted: false }],
      protocol: false,
    });
    expect(decoder.feed("200~ literal")).toEqual({
      segments: [{ text: "200~ literal", pasted: false }],
      protocol: false,
    });
  });

  it("keeps an opening marker spelling inside pasted payload as content", () => {
    const decoder = new BracketedPasteDecoder();
    decoder.feed(`${ESC}[200~`);
    expect(decoder.feed(`before${ESC}[200~after`).segments).toEqual([
      { text: `before${ESC}[200~after`, pasted: true },
    ]);
    decoder.feed(`${ESC}[201~`);
  });

  it("strips an unmatched end marker instead of leaking it into ordinary input", () => {
    const decoder = new BracketedPasteDecoder();
    expect(decoder.feed(`${ESC}[201~ordinary`).segments).toEqual([
      { text: "ordinary", pasted: false },
    ]);
  });
});
