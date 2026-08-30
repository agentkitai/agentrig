/**
 * Holds what has been typed, and decides when it is worth drawing.
 *
 * **Why this is not just `setState`.** A paste reaches a raw-mode tty as a run of small chunks,
 * and drawing on each one interleaves output with input — which can deadlock the terminal. Node's
 * writes to a TTY are synchronous on macOS: `write()` blocks until the terminal drains it. If
 * whatever is on the other end of the pty is itself blocked writing the rest of the paste into
 * the input buffer — because the app stopped reading to service a render — then neither side can
 * move. Both sleep. Ctrl-c does not help, because in raw mode ctrl-c is a byte on that same dead
 * stdin rather than a signal.
 *
 * Observed under cmux on macOS with the real component: Ink read 64 bytes, drew, read 1,016 more,
 * and blocked forever inside a 1,166-byte write, with 0% CPU and the remaining ~1,160 bytes of the
 * paste never delivered. It takes about a kilobyte of output — no amount of making the frame
 * smaller avoids it, because the problem is that anything was written at all.
 *
 * So the buffer is the truth and it moves synchronously; drawing waits for stdin to go quiet.
 * During a burst that means one draw at the end instead of one per chunk, and nothing is written
 * while the terminal is still pushing. Nobody can read a buffer mid-paste anyway.
 *
 * There is deliberately no maximum wait. A ceiling would guarantee a write in the middle of a
 * long enough paste, which is precisely the thing being avoided; input that never pauses is input
 * nobody is reading yet.
 */

export interface InputBufferOptions {
  /** Quiet stdin for this long before the buffer is drawn. One frame is plenty. */
  quietMs?: number;
  /** Injected so a test can drive the coalescing without waiting on a real clock. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class InputBuffer {
  private text = "";
  private handle: unknown = null;
  private readonly quietMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(
    /** Called with the buffer when it is time to draw. */
    private readonly onDraw: (text: string) => void,
    opts: InputBufferOptions = {},
  ) {
    this.quietMs = opts.quietMs ?? 32;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** What has actually been typed, including anything not yet drawn. Never lags. */
  get value(): string {
    return this.text;
  }

  /** Records input and schedules a draw once stdin has been quiet. */
  set(next: string): void {
    this.text = next;
    this.cancel();
    this.handle = this.setTimer(() => {
      this.handle = null;
      this.onDraw(this.text);
    }, this.quietMs);
  }

  /**
   * Records input and draws now. For the paths that must not lag — submitting a line, where the
   * prompt has to clear before the reply starts arriving.
   */
  setNow(next: string): void {
    this.text = next;
    this.cancel();
    this.onDraw(next);
  }

  /** Drops a pending draw, so an unmounted component is never drawn into. */
  dispose(): void {
    this.cancel();
  }

  private cancel(): void {
    if (this.handle === null) return;
    this.clearTimer(this.handle);
    this.handle = null;
  }
}
