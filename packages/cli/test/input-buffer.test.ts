import { describe, expect, it } from "vitest";
import { InputBuffer } from "../src/tui/input-buffer.ts";

/**
 * The property under test is that a burst of input produces ONE draw and no work in between,
 * because anything written during a paste is a blocking write to the tty and one of them
 * deadlocked a real terminal. The clock is injected so this is deterministic rather than a race
 * against a real timer — except in the one test that deliberately exercises the default.
 */

interface Harness {
  buffer: InputBuffer;
  drawn: string[];
  /** Runs whatever is pending, as a quiet stdin would. */
  quiet: () => void;
  pending: () => boolean;
  /** How many times a timer has been scheduled, to see a deadline being pushed out. */
  scheduled: () => number;
}

function harness(): Harness {
  const drawn: string[] = [];
  let next: (() => void) | null = null;
  let scheduled = 0;
  const buffer = new InputBuffer((t) => drawn.push(t), {
    setTimer: (fn) => {
      next = fn;
      scheduled += 1;
      return 1;
    },
    clearTimer: () => {
      next = null;
    },
  });
  return {
    buffer,
    drawn,
    quiet: () => {
      const fn = next;
      next = null;
      fn?.();
    },
    pending: () => next !== null,
    scheduled: () => scheduled,
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
    expect(h.drawn).toHaveLength(0);
    expect(h.buffer.value).toBe("fix the retry");
  });

  it("runs queued work at the quiet point, after the draw — never during the burst", () => {
    const h = harness();
    const order: string[] = [];
    // a submit reaching the buffer from the MIDDLE of a paste: a newline inside the pasted text
    h.buffer.set("rest of the paste", () => order.push("submit"));
    expect(order, "submitted during the burst").toHaveLength(0);
    expect(h.drawn, "drew during the burst").toHaveLength(0);

    h.quiet();
    expect(h.drawn).toEqual(["rest of the paste"]);
    expect(order).toEqual(["submit"]);
  });

  it("does not push the deadline out for keystroke-sized input", () => {
    const h = harness();
    // key auto-repeat is 15ms on macOS at the fast end, under the 32ms window: resetting the
    // deadline on every repeat meant a held key drew nothing at all until it was released
    h.buffer.set("a");
    const first = h.scheduled();
    for (const text of ["ab", "abc", "abcd", "abc", "ab", "a", ""]) h.buffer.set(text);
    expect(h.scheduled(), "a keystroke rescheduled the draw").toBe(first);

    h.quiet();
    expect(h.drawn).toEqual([""]);
  });

  it("still coalesces a paste chunk, which is not keystroke-sized", () => {
    const h = harness();
    h.buffer.set("x".repeat(64));
    const first = h.scheduled();
    h.buffer.set("x".repeat(128));
    expect(h.scheduled(), "a paste chunk did not push the deadline out").toBeGreaterThan(first);
  });

  it("drops pending work when disposed, and stays disposed", () => {
    const h = harness();
    const ran: string[] = [];
    h.buffer.set("half typed", () => ran.push("submit"));
    h.buffer.dispose();
    h.quiet();
    expect(h.drawn).toHaveLength(0);
    expect(ran).toHaveLength(0);

    // latched: a later keystroke must not schedule a draw into an unmounted component
    h.buffer.set("typed after unmount");
    expect(h.pending()).toBe(false);
    h.quiet();
    expect(h.drawn).toHaveLength(0);
  });

  it("draws again after the first burst settles", () => {
    const h = harness();
    h.buffer.set("one");
    h.quiet();
    h.buffer.set("one two three");
    h.quiet();
    expect(h.drawn).toEqual(["one", "one two three"]);
  });

  it("uses a quiet window short enough to feel immediate, on its own clock", async () => {
    // every other test injects the clock, so the default would go unexercised — and changing it
    // from 32 to 200 would keep them all green while making the prompt visibly laggy
    const drawn: string[] = [];
    const b = new InputBuffer((t) => drawn.push(t));
    b.set("hi");
    expect(drawn).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 80));
    expect(drawn).toEqual(["hi"]);
    b.dispose();
  });
});
