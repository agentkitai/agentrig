import { useEffect, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
import type { TuiController, TuiState } from "./controller.js";
import { BracketedPasteDecoder, InputBuffer } from "./input-buffer.js";
import { statusLine } from "./status.js";
import { fitToRows, liveRows } from "./viewport.js";

/**
 * Layout only. Every decision lives in `TuiController`, so there is nothing in here a test needs
 * to reach — with one exception: how tall this tree renders is a correctness property, not a
 * cosmetic one (see `viewport.ts`), and `test/tui-frame.test.ts` renders it against a fake TTY to
 * hold it.
 */

// `exactOptionalPropertyTypes` means `color={undefined}` is not the same as omitting it, so the
// default tone is a real colour rather than an absent prop
const TONE: Record<TuiState["lines"][number]["tone"], string> = {
  event: "gray",
  you: "cyan",
  system: "gray",
  // the reply is what the user asked for; everything else is context around it
  assistant: "white",
  error: "red",
};

export function App({ controller }: { controller: TuiController }): JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [state, setState] = useState<TuiState>(controller.snapshot());
  const [input, setInput] = useState("");
  /**
   * The authoritative buffer. Two reasons it is not the `input` state variable:
   *
   * - Ink drains several stdin chunks in one `readable` batch and React does not update state
   *   between them, so reading state to build a line dropped whole chunks — pasting 2,500
   *   characters ending in a newline submitted 2,436 of them, silently.
   * - Drawing on every chunk interleaves output with input, which can deadlock a pty. See
   *   `input-buffer.ts`; that is why drawing waits for stdin to go quiet.
   *
   * `input` exists only to trigger a re-render when the buffer is drawn.
   */
  const buffer = useRef<InputBuffer | null>(null);
  buffer.current ??= new InputBuffer(setInput);
  const buf = buffer.current;
  const pasteDecoder = useRef<BracketedPasteDecoder | null>(null);
  pasteDecoder.current ??= new BracketedPasteDecoder();
  const paste = pasteDecoder.current;
  useEffect(() => () => buf.dispose(), [buf]);

  // Everything the controller has to say reaches the screen through here and nowhere else: the
  // reply, the event lines, the status, the permission prompt. Without it the TUI still accepts
  // input and still runs the agent — it just never shows any of it, which is not a failure any
  // test that counts bytes can see. `test/tui-visible.test.ts` asserts the content instead.
  useEffect(() => controller.subscribe(setState), [controller]);

  useInput((char, key) => {
    if (key.ctrl && char === "c") {
      if (state.status === "running") controller.abort();
      else exit();
      return;
    }

    // Escape still denies a permission. Elsewhere a bare escape is handed to the decoder because
    // it may be the first chunk of ESC[200~; the decoder releases it only when that becomes false.
    if (state.pending !== null && key.escape) {
      controller.answerPermission("deny");
      return;
    }

    const decoded = paste.feed(key.return ? "\r" : key.escape ? "\u001b" : (char ?? ""));
    if (decoded.protocol) {
      // Markers carry no text, but they are still arriving stdin: move the same quiet point used by
      // payload chunks so a render cannot land between the final payload byte and split 201~ bytes.
      buf.touch();
      // A paste cannot answer a permission prompt accidentally. Protocol chunks are still consumed
      // so a later 201~ restores ordinary input correctly.
      if (state.pending !== null) return;
      for (const segment of decoded.segments) {
        const text = segment.text.replaceAll("\u001b", "");
        if (text === "") continue;
        if (!segment.pasted && text === "\r") {
          const line = buf.value;
          if (state.escalation !== null) buf.set("", () => controller.answerEscalation(line));
          else {
            buf.set("", () => {
              void controller.submit(line).then((keepGoing) => {
                if (!keepGoing) exit();
              });
            });
          }
        } else {
          // Return is data between 200~ and 201~, including a bare CR in its own stdin chunk.
          buf.set(buf.value + text.replace(/\r\n?/g, "\n"));
        }
      }
      return;
    }

    // a permission prompt takes the keyboard: answering it is the only useful thing to do
    if (state.pending !== null) {
      if (char === "y" || char === "Y") controller.answerPermission("allow");
      // `a` answers this request AND every later one for the same tool: a task that writes twenty
      // files should be approved once, not twenty times
      else if (char === "a" || char === "A") controller.answerPermission("allow", true);
      else if (char === "d" || char === "D") controller.answerPermission("deny", true);
      else if (char === "n" || char === "N") controller.answerPermission("deny");
      return;
    }

    // Unlike a permission decision, an escalation needs a real sentence. It uses the normal input
    // buffer but bypasses submit(), which correctly refuses ordinary new tasks while a turn runs.
    if (state.escalation !== null && key.return) {
      const answer = buf.value;
      buf.set("", () => controller.answerEscalation(answer));
      return;
    }

    if (key.return) {
      // queued rather than run now: a bare carriage return can be drained in the same batch as
      // the text ahead of it, so "the user pressed enter" is not proof that stdin has gone quiet
      const line = buf.value;
      buf.set("", () => {
        void controller.submit(line).then((keepGoing) => {
          if (!keepGoing) exit();
        });
      });
      return;
    }
    if (key.backspace || key.delete) {
      buf.set(buf.value.slice(0, -1));
      return;
    }
    if (char === undefined || char === "" || key.ctrl || key.meta) return;
    // A newline INSIDE a chunk is pasted text, not the enter key. This used to submit at the
    // first one and join the remainder with spaces, so pasting a multi-line brief sent only its
    // first line as the task and answered every following line with "a turn is already running".
    // Enter is its own chunk and is handled above; a paste is kept whole, line breaks and all —
    // `fitToRows` measures rendered rows, so a multi-line buffer draws correctly.
    if (/[\r\n]/.test(char)) {
      buf.set(buf.value + char.replace(/\r\n?/g, "\n"));
      return;
    }
    buf.set(buf.value + char);
  });

  // `||`, not `??`: Ink's own layout notes that `columns` is undefined OR ZERO off a TTY, and a
  // zero width collapses the budget to one character per row — the user saw the marker and none
  // of what they had typed
  const columns = stdout?.columns || 80;
  const rows = liveRows(stdout?.rows);

  return (
    <Box flexDirection="column">
      {/*
        `Static` writes each line ONCE above the live frame and never re-renders it. Keeping the
        scrollback as live `<Text>` made render cost grow with the buffer — 800 lines took 5s at
        a 500-line cap versus 0.5s at 50 — because Ink repaints the whole frame on every print,
        which also destroys terminal scrollback for anything scrolled past.
      */}
      <Static items={state.lines}>
        {(l) => (
          <Text key={l.key} color={TONE[l.tone]}>
            {l.text}
          </Text>
        )}
      </Static>

      {/*
        The reply as it streams and the input buffer are the two things in the frame that grow
        without bound, and a frame as tall as the window costs a full-screen clear plus a rewrite
        of the whole scrollback on EVERY render — see `viewport.ts`. Both are drawn through a
        viewport so the frame's height is a constant.
      */}
      {state.streaming !== "" ? (
        <Box marginTop={1}>
          <Text>{fitToRows(state.streaming, columns, rows)}</Text>
        </Box>
      ) : null}

      {state.pending !== null ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="yellow">
            allow {state.pending.req.tool} [{state.pending.req.class}]
            {state.pending.req.paths === undefined ? "" : ` on ${state.pending.req.paths.join(", ")}`}
            {state.pending.req.origin === undefined ? "" : ` (asked by ${state.pending.req.origin})`}?
          </Text>
          <Text dimColor>
            y = allow once, a = allow {state.pending.req.tool} all session, n / esc = deny, d = deny
            all session{state.queued > 0 ? ` · ${state.queued} more waiting` : ""}
          </Text>
        </Box>
      ) : state.escalation !== null ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="yellow">supervisor asks: {state.escalation.question}</Text>
          <Box>
            <Text color="cyan">answer: </Text>
            <Text>{fitToRows(input, columns - 8, rows)}</Text>
          </Box>
          <Text dimColor>enter sends this guidance to the running agent; unanswered prompts expire</Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text color={state.status === "running" ? "yellow" : "green"}>
            {state.status === "running" ? "· " : "> "}
          </Text>
          {/* less the two columns the prompt marker takes, or the line wraps one row further */}
          <Text>{fitToRows(input, columns - 2, rows)}</Text>
        </Box>
      )}

      <Box>
        {/*
          truncated, never wrapped: the statusline is budgeted as ONE row (see `liveRows`), and a
          long branch name wrapping to two would push the frame past the height the viewport was
          sized to hold
        */}
        <Text dimColor wrap="truncate-end">
          {statusLine(state)}
        </Text>
      </Box>
    </Box>
  );
}
