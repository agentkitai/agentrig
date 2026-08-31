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
