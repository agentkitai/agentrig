export const ENABLE_BRACKETED_PASTE = "\u001b[?2004h";
export const DISABLE_BRACKETED_PASTE = "\u001b[?2004l";

export interface TerminalOutput {
  isTTY?: boolean;
  write(chunk: string): unknown;
}

/** Enable only for the lifetime of the real TTY UI, and restore the user's shell in `finally`. */
export async function withBracketedPaste<T>(
  stdout: TerminalOutput,
  run: () => Promise<T>,
): Promise<T> {
  if (stdout.isTTY !== true) return run();

  stdout.write(ENABLE_BRACKETED_PASTE);
  try {
    return await run();
  } finally {
    stdout.write(DISABLE_BRACKETED_PASTE);
  }
}
