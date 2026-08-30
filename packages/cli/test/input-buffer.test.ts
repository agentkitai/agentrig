import { describe, expect, it } from "vitest";
import { InputBuffer } from "../src/tui/input-buffer.ts";

/**
 * The property under test is that a burst of input produces ONE draw, because every draw during a
 * paste is a blocking write to the tty and one of them deadlocked a real terminal. The clock is
 * injected so this is deterministic rather than a race against a real timer.
 */

interface Clock {
  buffer: InputBuffer;
  drawn: string[];
  /** Runs whatever is pending, as a quiet stdin would. */
  quiet: () => void;
  pending: () => boolean;
}

function harness(): Clock {
  const drawn: string[] = [];
  let scheduled: (() => void) | null = null;
  const buffer = new InputBuffer((t) => drawn.push(t), {
    setTimer: (fn) => {
      scheduled = fn;
      return 1;
    },
    clearTimer: () => {
      scheduled = null;
    },
  });
  return {
    buffer,
    drawn,
    quiet: () => {
      const fn = scheduled;
      scheduled = null;
      fn?.();
    },
    pending: () => scheduled !== null,
  };
}

describe("InputBuffer", () => {
  it("draws once for a whole paste, not once per chunk", () => {
    const h = harness();
    // 31 chunks is what a real 2,242-byte paste delivered; each draw before this was a blocking
    // write into a terminal that was mid-paste, and one of them never returned
    let text = "";
    for (let i = 0; i < 31; i += 1) {
      text += "x".repeat(64);
      h.buffer.set(text);
    }
    expect(h.drawn).toHaveLength(0);

    h.quiet();
    expect(h.drawn).toEqual([text]);
  });

  it("never lags on what was actually typed, whatever has been drawn", () => {
    const h = harness();
    h.buffer.set("fix the ");
    h.buffer.set("fix the retry");
    // the screen has not been told anything yet; the buffer already knows all of it
    expect(h.drawn).toHaveLength(0);
    expect(h.buffer.value).toBe("fix the retry");
  });

  it("draws immediately when a line is submitted, so the prompt clears before the reply", () => {
    const h = harness();
    h.buffer.set("a task");
    h.buffer.setNow("");
    expect(h.drawn).toEqual([""]);
    expect(h.buffer.value).toBe("");
    // and the coalesced draw it replaced never lands afterwards
    expect(h.pending()).toBe(false);
  });

  it("drops a pending draw when disposed, so an unmounted component is not drawn into", () => {
    const h = harness();
    h.buffer.set("half typed");
    h.buffer.dispose();
    h.quiet();
    expect(h.drawn).toHaveLength(0);
  });

  it("draws again after the first burst settles", () => {
    const h = harness();
    h.buffer.set("one");
    h.quiet();
    h.buffer.set("one two");
    h.quiet();
    expect(h.drawn).toEqual(["one", "one two"]);
  });
});
