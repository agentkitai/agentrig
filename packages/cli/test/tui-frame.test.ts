import { mkdtemp, rm } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { render } from "ink";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAgent,
  defaultRules,
  RulePolicy,
  SessionStore,
  type HarnessEvent,
  type ModelEvent,
  type ModelProvider,
} from "@agentkitai/agentrig-core";
import { App } from "../src/tui/app.tsx";
import { TuiController } from "../src/tui/controller.ts";

/**
 * How tall the live frame renders is a correctness property, not a cosmetic one.
 *
 * Ink abandons incremental redraw the moment the frame is as tall as the terminal: from then on
 * every render writes a full-screen clear followed by the whole accumulated scrollback. A long
 * paste or a long streamed reply crossed that line, so the cost of one more character became the
 * cost of repainting the entire session — which is what "the TUI hangs when I paste" was.
 *
 * These tests drive the real `App` against a fake TTY and watch what reaches stdout.
 */

const COLUMNS = 80;
const ROWS = 30;
/** Ink's full-screen clear. Its presence in a write IS the pathology. */
const CLEAR_TERMINAL = "\u001B[2J";

class FakeStdin extends EventEmitter {
  isTTY = true;
  private readonly chunks: string[] = [];
  setEncoding(): this {
    return this;
  }
  setRawMode(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
  read(): string | null {
    return this.chunks.shift() ?? null;
  }
  /** Chunks the terminal has delivered that nobody has taken yet. */
  get unread(): number {
    return this.chunks.length;
  }
  /** A paste reaches a raw-mode tty as a run of chunks, not as one keystroke. */
  paste(text: string, chunk = 64): void {
    this.queue(text, chunk);
    this.emit("readable");
  }
  /**
   * Queues without waking the reader, so a following chunk lands in the SAME `readable` batch —
   * which is the only way a bare "\r" arrives while React has not yet applied the text before it.
   */
  queue(text: string, chunk = 64): void {
    for (let i = 0; i < text.length; i += chunk) this.chunks.push(text.slice(i, i + chunk));
  }
}

interface Harness {
  stdin: FakeStdin;
  controller: TuiController;
  writes: string[];
  /** Unread stdin chunks at the moment of each write. Any non-zero entry is the hazard. */
  unreadAtWrite: () => number[];
  bytes: () => number;
  reset: () => void;
  stop: () => void;
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentrig-frame-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Streams one turn of text, in the many small deltas a real provider sends. */
class StreamingProvider implements ModelProvider {
  readonly id = "fake";
  readonly model = "fake-1";
  readonly capabilities = { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 };
  constructor(private readonly reply: string) {}
  async *stream(): AsyncIterable<ModelEvent> {
    for (let i = 0; i < this.reply.length; i += 40) {
      yield { type: "text_delta", text: this.reply.slice(i, i + 40) };
      // yield to the event loop so Ink actually renders intermediate frames, exactly as it does
      // against a real provider arriving over the network
      await new Promise((r) => setTimeout(r, 0));
    }
    yield { type: "stop", reason: "end_turn" };
  }
}

function mount(scrollback: number, reply = "", rows = ROWS, columns = COLUMNS): Harness {
  let writes: string[] = [];
  let unreadAtWrite: number[] = [];
  const stdin = new FakeStdin();
  const stdout = new EventEmitter() as EventEmitter & {
    columns: number;
    rows: number;
    isTTY: boolean;
    write: (s: string) => boolean;
  };
  stdout.columns = columns;
  stdout.rows = rows;
  stdout.isTTY = true;
  // A write while chunks are still queued is the deadlock condition itself: the terminal is
  // pushing input and cannot drain output. Recorded per write rather than counted at the end, so
  // it holds for ANY paste shape rather than only the one a test happens to use.
  stdout.write = (s: string): boolean => {
    writes.push(s);
    unreadAtWrite.push(stdin.unread);
    return true;
  };

  const controller: TuiController = new TuiController({
    cwd: root,
    agent: createAgent({
      provider: new StreamingProvider(reply),
      tools: [],
      permissions: new RulePolicy(defaultRules),
      systemPrompt: "test",
      store: new SessionStore({ root }),
      budget: { maxTurns: 2 },
      maxTokensPerTurn: 100,
    }),
  });
  for (let i = 0; i < scrollback; i += 1) {
    controller.print(`tool read packages/cli/src/tui/controller.ts (line ${i})`, "event");
  }

  const instance = render(createElement(App, { controller }), {
    stdout: stdout as never,
    stdin: stdin as never,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  return {
    stdin,
    controller,
    get writes(): string[] {
      return writes;
    },
    bytes: () => writes.reduce((n, s) => n + s.length, 0),
    unreadAtWrite: () => unreadAtWrite,
    reset: () => {
      writes = [];
      unreadAtWrite = [];
    },
    stop: () => instance.unmount(),
  };
}

/** Ink throttles rendering at 32ms with a trailing call, so a settle is required, not optional. */
const settle = async (ms = 250): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms));
};


/** An ordinary answer: short lines, bullets, a fenced block. 1,625 characters, 155 rows. */
const BULLETED_REPLY = Array.from({ length: 155 }, (_, i) =>
  i % 5 === 0 ? `- point ${i}` : `  step ${i}`,
).join("\n");

describe("the test harness itself", () => {
  it("runs with Ink's CI short-circuit disabled, or it asserts nothing at all", () => {
    // `ink/build/ink.js` returns from `onRender` before the frame-height branch when `is-in-ci` is
    // true, and every GitHub Actions step sets `CI`. Without `test/setup-no-ci.ts` these tests
    // pass against a fully reverted fix.
    expect(process.env["CI"]).toBeUndefined();
  });
});

describe("the live frame", () => {
  it("never repaints the whole terminal because of a long paste", async () => {
    const h = mount(300);
    await settle();
    h.reset();

    // the prompt this was found with was about this long
    h.stdin.paste("x".repeat(2_500));
    await settle();

    const clears = h.writes.filter((w) => w.includes(CLEAR_TERMINAL));
    h.stop();
    expect(clears).toHaveLength(0);
  });

  it("keeps one repaint the size of a frame, not the size of the session", async () => {
    const h = mount(2_000);
    await settle();
    h.reset();
    h.stdin.paste("x".repeat(2_500));
    await settle();

    const largest = Math.max(0, ...h.writes.map((w) => w.length));
    h.stop();
    // a repaint is the visible frame: the viewport, the prompt and the status line. Before this
    // fix each of the ~40 repaints this paste caused carried the whole 2,000-line scrollback,
    // averaging ~24,000 bytes; now they are a few hundred.
    expect(largest).toBeLessThan(4_000);
  });

  it("does not make a paste more expensive the longer the session has run", async () => {
    // the scrollback is what the full-screen repaint reprints, so before this fix the same paste
    // cost 192,596 bytes at 300 lines of scrollback and 962,196 at 2,000
    const small = mount(100);
    await settle();
    small.reset();
    small.stdin.paste("x".repeat(2_500));
    await settle();
    const smallBytes = small.bytes();
    small.stop();

    const big = mount(2_000);
    await settle();
    big.reset();
    big.stdin.paste("x".repeat(2_500));
    await settle();
    const bigBytes = big.bytes();
    big.stop();

    expect(bigBytes).toBeLessThan(smallBytes * 2 + 2_000);
  });


  it("never repaints the whole terminal because of a reply made of short lines", async () => {
    // The shape of nearly every real answer: bullets, steps, a code block. A character budget
    // reads this as 21 rows; the terminal renders 155. Before the row budget it drove 40
    // full-screen repaints and 699,389 bytes — worse than the paste this all started with, and
    // from a reply of only 1,625 characters.
    const h = mount(300, BULLETED_REPLY);
    await settle();
    h.reset();

    await h.controller.submit("explain the retry policy");
    await settle();

    const clears = h.writes.filter((w) => w.includes(CLEAR_TERMINAL));
    h.stop();
    expect(clears).toHaveLength(0);
  });

  it("holds in a small window with a reply streaming AND something typed", async () => {
    // The frame draws two growable regions. Budgeting each against the whole window left every
    // terminal from 12 to 20 rows — a tmux pane, a split editor — freezing exactly as before.
    for (const rows of [12, 16, 20, 24]) {
      const h = mount(200, BULLETED_REPLY, rows);
      await settle();
      h.reset();
      h.stdin.paste("x".repeat(2_500));
      await h.controller.submit("explain");
      await settle();
      const clears = h.writes.filter((w) => w.includes(CLEAR_TERMINAL));
      h.stop();
      expect(clears, `${rows}-row terminal`).toHaveLength(0);
    }
  }, 30_000);

  it("never repaints the whole terminal because of a long streamed reply", async () => {
    // a reply of a few thousand characters is an ordinary answer, not an outlier, and it arrives
    // token by token — so the tall frame was redrawn once per delta for the whole turn
    const h = mount(300, "answer ".repeat(500));
    await settle();
    h.reset();

    await h.controller.submit("explain the retry policy");
    await settle();

    const clears = h.writes.filter((w) => w.includes(CLEAR_TERMINAL));
    h.stop();
    expect(clears).toHaveLength(0);
  });
});

describe("the frame off a real terminal", () => {
  it("still shows what was typed when the terminal reports zero columns", async () => {
    // Ink's own layout notes that `columns` is undefined OR ZERO off a TTY and falls back with
    // `||`. With `??` the zero passes through, the budget collapses to one character per row, and
    // the user sees the "(N more)" marker and none of what they typed.
    const h = mount(20, "", ROWS, 0);
    await settle();
    h.reset();

    h.stdin.paste("fix the retry logic in the anthropic adapter");
    await settle();
    const frame = h.writes.join("");
    h.stop();

    expect(frame).toContain("fix the retry logic in the anthropic adapter");
  });
});

describe("the input buffer", () => {
  /** What `submit` was actually handed, which is the only thing that reaches the agent. */
  const submitted = (h: Harness): string[] => {
    const seen: string[] = [];
    const real = h.controller.submit.bind(h.controller);
    h.controller.submit = async (line: string): Promise<boolean> => {
      seen.push(line);
      return real("");
    };
    return seen;
  };

  it("keeps a multi-line paste whole instead of submitting its first line", async () => {
    const h = mount(50);
    await settle();
    const seen = submitted(h);

    // This used to submit at the first newline and join the remainder with spaces. Pasting a
    // multi-line brief therefore sent only its first sentence as the task, and every line after
    // it came back "a turn is already running — /abort first" while the agent worked on a
    // fragment. A newline inside a chunk is pasted text; enter is its own chunk.
    h.stdin.paste("line one\nline two\nline three");
    await settle();

    expect(seen, "submitted a fragment of the paste").toHaveLength(0);

    // and pressing enter afterwards submits all of it, line breaks intact
    h.stdin.paste("\r");
    await settle();
    h.stop();
    expect(seen).toEqual(["line one\nline two\nline three"]);
  });

  it("normalises the line endings a terminal may deliver", async () => {
    const h = mount(50);
    await settle();
    const seen = submitted(h);

    h.stdin.paste("first\r\nsecond");
    await settle();
    h.stdin.paste("\r");
    await settle();
    h.stop();
    expect(seen).toEqual(["first\nsecond"]);
  });

  it("submits every character when the return key arrives in the same batch as the text", async () => {
    const h = mount(50);
    await settle();
    const seen = submitted(h);

    // A separate keystroke a moment later would let React catch up and prove nothing. Ink drains
    // the whole queue in one `readable` handler, so this is the return arriving before any of the
    // text ahead of it has been applied to state.
    h.stdin.queue("z".repeat(2_496));
    h.stdin.paste("\r");
    await settle();
    h.stop();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe("z".repeat(2_496));
  });

  it("submits the full buffer, not the viewport slice drawn on screen", async () => {
    const h = mount(50);
    await settle();
    const seen = submitted(h);

    h.stdin.paste("q".repeat(4_000));
    await settle();
    h.stdin.paste("\r");
    await settle();
    h.stop();

    // the frame shows a tail with a "(N more)" marker; what the agent gets is all of it
    expect(seen[0]).toBe("q".repeat(4_000));
    expect(seen[0]).not.toContain("more)");
  });
});

describe("output while a paste is arriving", () => {
  it("keeps the activity tick silent through a pending marker and an open paste", async () => {
    const h = mount(0);
    await settle();
    const event: HarnessEvent = {
      type: "model.request",
      seq: 1,
      sessionId: "s1",
      ts: Date.now(),
      tokensIn: 12,
    };
    (h.controller as unknown as { consume: (next: HarnessEvent) => void }).consume(event);
    await settle();

    // An ESC may be the first byte of a split opening marker. The first tick lands while it is
    // pending; the second lands after the rest of the marker has opened the paste.
    h.stdin.paste("\u001b");
    h.reset();
    await settle(1_100);
    expect(h.writes, "activity tick wrote while an opening marker was pending").toHaveLength(0);

    h.stdin.paste("[200~still arriving");
    await settle(1_100);
    expect(h.writes, "activity tick wrote while bracketed paste was open").toHaveLength(0);

    // Event-driven state changes use the same gate; otherwise an activity transition racing the
    // timer would still write even though the tick itself was suspended.
    h.controller.print("DEFERRED-UNTIL-PASTE-END", "system");
    await settle(100);
    expect(h.writes, "controller state wrote while bracketed paste was open").toHaveLength(0);

    h.stdin.paste("\u001b[201~");
    await settle(100);
    const flushed = h.writes.length;
    h.stop();

    expect(flushed, "did not flush the suspended activity render when paste completed").toBeGreaterThan(0);
  });

  it("keeps the activity tick behind the quiet point for an unframed input burst", async () => {
    const h = mount(0);
    await settle();
    const event: HarnessEvent = {
      type: "model.request",
      seq: 1,
      sessionId: "s1",
      ts: Date.now(),
      tokensIn: 12,
    };
    (h.controller as unknown as { consume: (next: HarnessEvent) => void }).consume(event);
    await settle();
    h.reset();

    // Some terminals ignore bracketed-paste mode. Keep the input quiet deadline continuously armed
    // across a 1 Hz tick; the timer must not bypass the same write discipline used by input draws.
    for (let i = 0; i < 110; i += 1) {
      h.stdin.paste("x".repeat(64));
      await settle(10);
    }
    const during = h.writes.length;
    await settle(100);
    const after = h.writes.length;
    h.stop();

    expect(during, "activity tick bypassed the pending input draw").toBe(0);
    expect(after, "input quiet point did not flush a render").toBeGreaterThan(0);
  });

  it("writes nothing to the terminal until the chunks stop coming", async () => {
    // Every write during a paste is a blocking write to the tty, and one of them deadlocked a
    // real terminal: the peer was blocked writing the rest of the paste into the input buffer
    // while this process was blocked writing 1,166 bytes out. It needs about a kilobyte, so no
    // amount of shrinking the frame avoids it — the fix is to write nothing at all until stdin
    // goes quiet.
    const h = mount(300);
    await settle();
    h.reset();

    // 31 separate wakeups, the way the terminal actually delivered it
    for (let i = 0; i < 31; i += 1) {
      h.stdin.paste("x".repeat(64), 64);
      await new Promise((r) => setImmediate(r));
    }
    const during = h.writes.length;
    await settle();
    const after = h.writes.length;
    h.stop();

    expect(during, "wrote to the terminal mid-paste").toBe(0);
    // and the buffer is drawn once the burst settles, rather than never
    expect(after).toBeGreaterThan(0);
  });
});

describe("a paste that contains a newline", () => {
  /**
   * The shape the first version of this fix missed entirely. A newline submits, and submitting
   * used to draw synchronously — from the middle of an arriving paste. Measured on this harness,
   * one newline in a 120-chunk paste produced 11 writes and 1,141 bytes while chunks were still
   * queued, which is the byte volume of the write that deadlocked a real terminal.
   */
  const chunk = (i: number, at: number): string => (i === at ? `${"y".repeat(63)}\n` : "y".repeat(64));

  /**
   * Delivered in batches, because that is what a tty does: Ink drains several chunks per
   * `readable` wakeup, so while it is working through one the rest are still queued — which is
   * the only arrangement in which a write can land with input unread.
   */
  const pasteWithNewline = async (h: Harness, chunks: number, at: number, batch = 5): Promise<void> => {
    for (let i = 0; i < chunks; i += batch) {
      for (let j = i; j < Math.min(i + batch, chunks) - 1; j += 1) h.stdin.queue(chunk(j, at), 64);
      h.stdin.paste(chunk(Math.min(i + batch, chunks) - 1, at), 64);
      await new Promise((r) => setImmediate(r));
    }
  };

  it("writes nothing while chunks are still queued", async () => {
    const h = mount(300);
    await settle();
    h.reset();

    await pasteWithNewline(h, 120, 10);
    const during = h.writes.length;
    h.stop();
    expect(during, "wrote to the terminal mid-paste").toBe(0);
  });

  it("never writes while stdin still has something unread, whatever the shape", async () => {
    // asserted per write rather than by counting at the end, so this holds for paste shapes no
    // test thought to try — which is exactly how the newline case got through
    const h = mount(300);
    await settle();
    h.reset();

    await pasteWithNewline(h, 60, 30);
    await settle();
    const hazards = h.unreadAtWrite().filter((n) => n > 0);
    h.stop();
    expect(hazards, "wrote while the terminal still had input queued").toEqual([]);
  });

  it("submits the whole brief once enter is pressed, every character of it", async () => {
    const h = mount(300);
    await settle();
    const seen: string[] = [];
    const real = h.controller.submit.bind(h.controller);
    h.controller.submit = async (line: string): Promise<boolean> => {
      seen.push(line);
      return real("");
    };

    await pasteWithNewline(h, 20, 10);
    await settle();
    expect(seen, "submitted mid-paste").toHaveLength(0);

    h.stdin.paste("\r");
    await settle();
    h.stop();

    // 20 chunks: 19 of 64 characters and one of 63 plus a newline
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(`${"y".repeat(10 * 64 + 63)}\n${"y".repeat(9 * 64)}`);
  });
});
