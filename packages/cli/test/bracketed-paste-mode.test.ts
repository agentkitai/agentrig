import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  DISABLE_BRACKETED_PASTE,
  ENABLE_BRACKETED_PASTE,
  withBracketedPaste,
} from "../src/tui/bracketed-paste-mode.ts";

describe("bracketed paste terminal mode", () => {
  it("enables on entry and disables on the normal exit path", async () => {
    const writes: string[] = [];
    await withBracketedPaste(
      { isTTY: true, write: (chunk) => writes.push(chunk) },
      async () => {
        expect(writes).toEqual([ENABLE_BRACKETED_PASTE]);
      },
    );

    expect(writes).toEqual([ENABLE_BRACKETED_PASTE, DISABLE_BRACKETED_PASTE]);
  });

  it("disables from finally when the UI exit rejects", async () => {
    const writes: string[] = [];
    await expect(
      withBracketedPaste(
        { isTTY: true, write: (chunk) => writes.push(chunk) },
        async () => {
          throw new Error("exit failed");
        },
      ),
    ).rejects.toThrow("exit failed");

    expect(writes.at(-1)).toBe(DISABLE_BRACKETED_PASTE);
  });

  it("disables synchronously and relays a termination signal", async () => {
    const writes: string[] = [];
    const emitter = new EventEmitter();
    const killed: Array<[number, string]> = [];
    let finish!: () => void;
    const running = withBracketedPaste(
      { isTTY: true, write: (chunk) => writes.push(chunk) },
      () => new Promise<void>((resolve) => {
        finish = resolve;
      }),
      {
        pid: 42,
        once: (signal, listener) => emitter.once(signal, listener),
        removeListener: (signal, listener) => emitter.removeListener(signal, listener),
        kill: (pid, signal) => killed.push([pid, signal]),
      },
    );

    emitter.emit("SIGTERM");
    expect(writes).toEqual([ENABLE_BRACKETED_PASTE, DISABLE_BRACKETED_PASTE]);
    expect(killed).toEqual([[42, "SIGTERM"]]);
    finish();
    await running;
    expect(writes, "finally disabled a second time").toHaveLength(2);
  });

  it("writes neither terminal sequence when stdout is not a TTY", async () => {
    const writes: string[] = [];
    let ran = false;
    await withBracketedPaste(
      { isTTY: false, write: (chunk) => writes.push(chunk) },
      async () => {
        ran = true;
      },
    );

    expect(ran).toBe(true);
    expect(writes).toEqual([]);
  });
});
