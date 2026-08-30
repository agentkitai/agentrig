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
 */

/** Rendering the tail rather than the head: what you are typing is at the end. */
export function fitToRows(text: string, columns: number, maxRows: number): string {
  // a zero or negative width would make `budget` zero or negative and hide everything; a terminal
  // this small cannot be drawn correctly anyway, so fall back to something drawable
  const width = Math.max(1, Math.floor(columns));
  const rows = Math.max(1, Math.floor(maxRows));
  const budget = width * rows;
  if (text.length <= budget) return text;

  const hidden = text.length - budget;
  // the marker occupies part of the budget, or adding it would push the frame back over the cliff
  const marker = `…(${hidden.toLocaleString("en-US")} more) `;
  const keep = Math.max(0, budget - marker.length);
  return marker + text.slice(text.length - keep);
}

/**
 * Rows the live frame may spend on one growable region. Deliberately a small fraction of the
 * window: the prompt, the status line and a permission prompt all share the frame, and the cliff
 * is reached by the frame as a whole rather than by any one part of it.
 */
export function liveRows(terminalRows: number | undefined, cap = 8): number {
  const rows = terminalRows === undefined || terminalRows <= 0 ? 24 : terminalRows;
  // leave room for everything else in the frame; never fewer than one row
  return Math.max(1, Math.min(cap, rows - 8));
}
