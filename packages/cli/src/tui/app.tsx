import { useEffect, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import type { TuiController, TuiState } from "./controller.js";

/**
 * Layout only. Every decision lives in `TuiController`, so this file has nothing in it worth
 * testing and nothing in it that a test would struggle to reach.
 */

// `exactOptionalPropertyTypes` means `color={undefined}` is not the same as omitting it, so the
// default tone is a real colour rather than an absent prop
const TONE: Record<TuiState["lines"][number]["tone"], string> = {
  event: "white",
  you: "cyan",
  system: "gray",
  error: "red",
};

export function App({ controller }: { controller: TuiController }): JSX.Element {
  const { exit } = useApp();
  const [state, setState] = useState<TuiState>(controller.snapshot());
  const [input, setInput] = useState("");

  useEffect(() => controller.subscribe(setState), [controller]);

  useInput((char, key) => {
    if (key.ctrl && char === "c") {
      if (state.status === "running") controller.abort();
      else exit();
      return;
    }

    // a permission prompt takes the keyboard: answering it is the only useful thing to do
    if (state.pending !== null) {
      if (char === "y" || char === "Y") controller.answerPermission("allow");
      else if (char === "n" || char === "N" || key.escape) controller.answerPermission("deny");
      return;
    }

    if (key.return) {
      const line = input;
      setInput("");
      void controller.submit(line).then((keepGoing) => {
        if (!keepGoing) exit();
      });
      return;
    }
    if (key.backspace || key.delete) {
      setInput((v) => v.slice(0, -1));
      return;
    }
    if (char === undefined || char === "" || key.ctrl || key.meta) return;
    // a paste arrives as ONE multi-character chunk with `key.return` false, so an embedded
    // newline used to land in the buffer literally and corrupt the line. Submit at the first
    // newline and keep the remainder.
    if (/[\r\n]/.test(char)) {
      const [first = "", ...rest] = char.split(/\r\n|[\r\n]/);
      const line = input + first;
      setInput(rest.join(" "));
      void controller.submit(line).then((keepGoing) => {
        if (!keepGoing) exit();
      });
      return;
    }
    setInput((v) => v + char);
  });

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

      {state.pending !== null ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="yellow">
            allow {state.pending.req.tool} [{state.pending.req.class}]
            {state.pending.req.paths === undefined ? "" : ` on ${state.pending.req.paths.join(", ")}`}
            {state.pending.req.origin === undefined ? "" : ` (asked by ${state.pending.req.origin})`}?
          </Text>
          <Text dimColor>
            y = allow, n / esc = deny{state.queued > 0 ? ` · ${state.queued} more waiting` : ""}
          </Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text color={state.status === "running" ? "yellow" : "green"}>
            {state.status === "running" ? "· " : "> "}
          </Text>
          <Text>{input}</Text>
        </Box>
      )}

      <Box>
        <Text dimColor>
          {state.sessionId ?? "no session"} · {state.status}
          {state.turns > 0 ? ` · turn ${state.turns}` : ""} · /help
        </Text>
      </Box>
    </Box>
  );
}
