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
  /** A paste reaches a raw-mode tty as a run of chunks, not as one keystroke. */
  paste(text: string, chunk = 64): void {
    for (let i = 0; i < text.length; i += chunk) this.chunks.push(text.slice(i, i + chunk));
    this.emit("readable");
  }
}

interface Harness {
  stdin: FakeStdin;
  controller: TuiController;
  writes: string[];
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

function mount(scrollback: number, reply = ""): Harness {
  let writes: string[] = [];
  const stdout = new EventEmitter() as EventEmitter & {
    columns: number;
    rows: number;
    isTTY: boolean;
    write: (s: string) => boolean;
  };
  stdout.columns = COLUMNS;
  stdout.rows = ROWS;
  stdout.isTTY = true;
  stdout.write = (s: string): boolean => {
    writes.push(s);
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

  const stdin = new FakeStdin();
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
    reset: () => {
      writes = [];
    },
    stop: () => instance.unmount(),
  };
}

/** Ink throttles rendering at 32ms with a trailing call, so a settle is required, not optional. */
const settle = async (ms = 250): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms));
};

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
