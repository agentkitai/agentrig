import stringWidth from "string-width";

/**
 * How much text the live frame may draw.
 *
 * Ink's renderer has a cliff: when the live frame is at least as tall as the terminal
 * (`outputHeight >= stdout.rows`) it abandons incremental redraw and writes
 * `clearTerminal + fullStaticOutput + output` on EVERY render — a full-screen clear followed by
 * the entire session's scrollback, which Ink accumulates and never trims. So one tall frame does
 * not cost one big paint; it costs one big paint per keystroke, per paste chunk, per streamed
 * token, growing with how long the session has been running.
 *
 * Two things in the TUI grow without bound and are drawn live: the input buffer (a pasted brief
 * is thousands of characters) and the reply as it streams. Measured with the real `App` against a
 * fake 80x30 TTY, a 2,500-character paste over 2,000 scrollback lines wrote 962,196 bytes across
 * 40 full-screen repaints, versus 267 bytes for a short one — which is what "the TUI hangs when I
 * paste" actually is.
 *
 * The fix is to keep the live frame short: draw the tail, and say how much is not shown. Nothing
 * is truncated in the buffer itself — this is a viewport, not an edit.
 *
 * **The budget is rows, not characters.** The first version of this file multiplied columns by
 * rows and compared that to `text.length`, which is only the same thing for text with no line
 * breaks in it. A streamed reply is mostly line breaks: a 1,625-character answer of short bullets
 * measures 155 rows, not 21, and it drove 40 full-screen repaints and 699,389 bytes straight back
 * through the cliff the character budget was supposed to keep it away from. Flattening the very
 * same text to one line: no repaints, 31,059 bytes.
 */

/** Rows one line occupies once the terminal wraps it. An empty line is still a row. */
function lineRows(line: string, columns: number): number {
  return Math.max(1, Math.ceil(stringWidth(line) / columns));
}

/**
 * Rows `text` occupies at this width — the quantity Ink compares against `stdout.rows`.
 * Exported because it is what a test should assert on: any weaker property lets a fix pass that
 * does not actually keep the frame short.
 */
export function measureRows(text: string, columns: number): number {
  const width = Math.max(1, Math.floor(columns));
  return text.split("\n").reduce((n, line) => n + lineRows(line, width), 0);
}

/** The last `rows` rows of `text`, whole lines where possible. */
function tailWithinRows(text: string, width: number, rows: number): string {
  const lines = text.split("\n");
  let used = 0;
  let start = lines.length;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const r = lineRows(lines[i] ?? "", width);
    if (used + r > rows) break;
    used += r;
    start = i;
  }
  if (start < lines.length) return lines.slice(start).join("\n");
  // Not even the final line fits on its own, so keep its tail. Sliced by characters and then
  // measured, because a wide character is two columns and one slice cannot know how many it took.
  let tail = (lines.at(-1) ?? "").slice(-(rows * width));
  while (tail !== "" && lineRows(tail, width) > rows) tail = tail.slice(1);
  return tail;
}

/** Rendering the tail rather than the head: what you are typing, and what is streaming, is there. */
export function fitToRows(text: string, columns: number, maxRows: number): string {
  // a zero or negative width or height would make the budget zero and hide everything; a terminal
  // this small cannot be drawn correctly anyway, so fall back to something drawable
  const width = Math.max(1, Math.floor(columns));
  const rows = Math.max(1, Math.floor(maxRows));
  if (measureRows(text, width) <= rows) return text;

  // one row goes to saying what is not shown, so a clipped paste never looks like a short one
  const kept = tailWithinRows(text, width, Math.max(1, rows - 1));
  const marker = `…(${(text.length - kept.length).toLocaleString("en-US")} more)`;
  if (rows === 1) {
    // no row to spare: the marker shares the single row, and is itself clipped if even that is
    // too narrow — returning a marker wider than the budget was how this overflowed at width 5
    return tailWithinRows(`${marker} ${kept}`, width, 1);
  }
  return `${marker}\n${kept}`;
}

/**
 * Rows the live frame may spend on ONE growable region. Deliberately a small fraction of the
 * window, and halved, because the frame draws two of them — the streaming reply and the input
 * buffer — plus a prompt row, a status row and the margins between them. Budgeting each region
 * against the whole window left every terminal between 12 and 20 rows freezing exactly as before
 * whenever someone typed while a reply was streaming, which is a tmux pane or a split editor.
 */
export function liveRows(terminalRows: number | undefined, cap = 8): number {
  const rows = terminalRows === undefined || terminalRows <= 0 ? 24 : terminalRows;
  // `- 6` is the frame's fixed furniture with headroom; `/ 2` is the second growable region.
  // Below about six rows there is no arrangement that fits and the cliff is unavoidable.
  return Math.max(1, Math.min(cap, Math.floor((rows - 6) / 2)));
}
