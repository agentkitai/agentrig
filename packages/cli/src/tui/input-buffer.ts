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
 * while the terminal is still pushing.
 *
 * **Submitting waits too.** The first version drew synchronously when a line was submitted, on the
 * grounds that stdin had just gone quiet. It has not: a newline inside a paste submits from the
 * middle of an arriving burst, and a bare carriage return can be drained in the same batch as the
 * text ahead of it. Measured on the committed harness, one newline in a 120-chunk paste produced
 * 11 writes and 1,141 bytes mid-paste — the same byte volume as the write that deadlocked. So a
 * submit is queued and runs at the quiet point, right after the draw, and there is no path left
 * that writes while chunks are still unread.
 *
 * There is deliberately no maximum wait. A ceiling would guarantee a write in the middle of a long
 * enough paste, which is precisely the thing being avoided.
 */

/**
 * A change this size or smaller is a keystroke, not a chunk of a paste.
 *
 * Keystrokes must not push the deadline out, or input arriving faster than the quiet window never
 * draws at all. Human typing is far slower than that, but key auto-repeat is not: macOS's repeat
 * rate is 15ms at the fast end of the slider and 30ms one notch up, both under 32ms. Holding
 * backspace to clear a line showed a frozen prompt for as long as the key was held, then snapped
 * to the final value. A paste chunk is 64 bytes or more and still resets the deadline, so bursts
 * coalesce exactly as before.
 */
const KEYSTROKE = 4;

const ESC = "\u001b";
const START_MARKER = `${ESC}[200~`;
const END_MARKER = `${ESC}[201~`;

export interface DecodedInput {
  /** Text with protocol markers removed, tagged with whether Enter is content at that point. */
  segments: Array<{ text: string; pasted: boolean }>;
  /** True when this chunk participated in bracketed-paste parsing rather than ordinary input. */
  protocol: boolean;
}

/**
 * Stateful decoder for raw stdin chunks. Prefixes are retained across calls; in particular, a
 * bare ESC is not released until the next chunk proves that it is not the start of a marker.
 * An opening marker inside a paste is payload; only the closing marker has protocol meaning there.
 */
export class BracketedPasteDecoder {
  private pending = "";
  private pasted = false;

  get isPasting(): boolean {
    return this.pasted;
  }

  get hasPendingMarker(): boolean {
    return this.pending !== "";
  }

  feed(chunk: string): DecodedInput {
    const input = this.pending + chunk;
    this.pending = "";
    const segments: DecodedInput["segments"] = [];
    let markerSeen = false;
    let offset = 0;

    const append = (text: string): void => {
      if (text === "") return;
      const last = segments.at(-1);
      if (last?.pasted === this.pasted) last.text += text;
      else segments.push({ text, pasted: this.pasted });
    };

    while (offset < input.length) {
      const candidates = this.pasted ? [END_MARKER] : [START_MARKER, END_MARKER];
      const marker = candidates.find((candidate) => input.startsWith(candidate, offset));
      if (marker !== undefined) {
        markerSeen = true;
        this.pasted = marker === START_MARKER;
        offset += marker.length;
        continue;
      }

      const remaining = input.length - offset;
      if (
        remaining < END_MARKER.length &&
        candidates.some((candidate) => candidate.startsWith(input.slice(offset)))
      ) {
        this.pending = input.slice(offset);
        break;
      }

      append(input[offset] ?? "");
      offset += 1;
    }

    return {
      segments,
      // A disproved prefix outside paste returns to the exact ordinary key path. The held ESC is
      // intentionally absent from Ink's semantic input and remains ignored as it was before R1c.
      protocol: markerSeen || this.pending !== "" || this.pasted,
    };
  }
}

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
  private disposed = false;
  /** Work to run once the draw lands — submitting a line, today. */
  private readonly queued: Array<() => void> = [];
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

  /**
   * Records input, and optionally work to run once it has been drawn. Both happen at the next
   * quiet point, so neither writes to the terminal while a paste is still arriving.
   */
  set(next: string, thenRun?: () => void): void {
    if (this.disposed) return;
    const delta = Math.abs(next.length - this.text.length);
    this.text = next;
    if (thenRun !== undefined) this.queued.push(thenRun);
    // a keystroke leaves the existing deadline alone; only a burst-sized change pushes it out
    if (this.handle !== null && delta <= KEYSTROKE && thenRun === undefined) return;
    this.cancel();
    this.handle = this.setTimer(() => {
      this.handle = null;
      this.draw();
    }, this.quietMs);
  }

  /** Cancels drawing without discarding text or queued submits; release it after paste framing. */
  hold(): void {
    if (this.disposed) return;
    this.cancel();
  }

  /**
   * Records stdin activity that changes no text (for example, a completed closing marker). It
   * starts the quiet wait only after bracket framing has fully resolved.
   */
  touch(): void {
    if (this.disposed) return;
    this.cancel();
    this.handle = this.setTimer(() => {
      this.handle = null;
      this.draw();
    }, this.quietMs);
  }

  /** Drops pending work, so an unmounted component is never drawn into. Latches. */
  dispose(): void {
    this.disposed = true;
    this.queued.length = 0;
    this.cancel();
  }

  private draw(): void {
    this.onDraw(this.text);
    // spliced first: a callback that submits can schedule more work, and must not re-run this one
    for (const run of this.queued.splice(0)) run();
  }

  private cancel(): void {
    if (this.handle === null) return;
    this.clearTimer(this.handle);
    this.handle = null;
  }
}
