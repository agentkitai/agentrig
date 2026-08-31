export const ENABLE_BRACKETED_PASTE = "\u001b[?2004h";
export const DISABLE_BRACKETED_PASTE = "\u001b[?2004l";

export interface TerminalOutput {
  isTTY?: boolean;
  write(chunk: string): unknown;
}

type TeardownSignal = "SIGHUP" | "SIGTERM";

export interface SignalHost {
  pid: number;
  once(signal: TeardownSignal, listener: () => void): unknown;
  removeListener(signal: TeardownSignal, listener: () => void): unknown;
  kill(pid: number, signal: TeardownSignal): unknown;
}

/** Enable only for the lifetime of the real TTY UI, and restore the user's shell on every exit. */
export async function withBracketedPaste<T>(
  stdout: TerminalOutput,
  run: () => Promise<T>,
  signals: SignalHost = process,
): Promise<T> {
  if (stdout.isTTY !== true) return run();

  let disabled = false;
  const disable = (): void => {
    if (disabled) return;
    disabled = true;
    stdout.write(DISABLE_BRACKETED_PASTE);
  };
  const cleanupSignals = (): void => {
    signals.removeListener("SIGHUP", onSighup);
    signals.removeListener("SIGTERM", onSigterm);
  };
  const relay = (signal: TeardownSignal): void => {
    // Promise finally callbacks do not run before Node re-raises an unhandled termination signal.
    // TTY writes are synchronous, so restore first, remove our handlers, then preserve signal exit.
    disable();
    cleanupSignals();
    signals.kill(signals.pid, signal);
  };
  const onSighup = (): void => relay("SIGHUP");
  const onSigterm = (): void => relay("SIGTERM");

  stdout.write(ENABLE_BRACKETED_PASTE);
  signals.once("SIGHUP", onSighup);
  signals.once("SIGTERM", onSigterm);
  try {
    return await run();
  } finally {
    cleanupSignals();
    disable();
  }
}
