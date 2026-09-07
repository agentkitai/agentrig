import { Children, cloneElement, createContext, isValidElement, useContext, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Box, Static, Text as InkText, useApp, useStdout } from "ink";
import type { TuiController, TuiState } from "./controller.js";
import {
  BracketedPasteDecoder,
  InputBuffer,
  ordinaryInputActions,
  type OrdinaryInputAction,
} from "./input-buffer.js";
import { statusLine } from "./status.js";
import { fitToRows, liveRows } from "./viewport.js";
import { useRawInput } from "./raw-input.js";
import { createMarkdownCache } from "./markdown.js";
import { PromptHistory, PromptRecall, completePrompt } from "./prompt-history.js";
import { mapTuiAction, resolveTuiSettings, type TuiSettings } from "./settings.js";

/**
 * Layout only. Every decision lives in `TuiController`, so there is nothing in here a test needs
 * to reach — with one exception: how tall this tree renders is a correctness property, not a
 * cosmetic one (see `viewport.ts`), and `test/tui-frame.test.ts` renders it against a fake TTY to
 * hold it.
 */

const PlainText = createContext(false);
function withoutSgr(children: ReactNode): ReactNode {
  return Children.map(children, child => typeof child === "string" ? child.replace(/\u001b\[[0-9;:]*m/g, "")
    : isValidElement<{ children?: ReactNode }>(child) ? cloneElement(child, {}, withoutSgr(child.props.children)) : child);
}
/** Per-tree styling only: NO_COLOR never mutates Ink/chalk/global process settings. */
function Text(props: ComponentProps<typeof InkText>): JSX.Element {
  const plain = useContext(PlainText);
  if (!plain) return <InkText {...props} />;
  const { color: _color, backgroundColor: _backgroundColor, dimColor: _dim, bold: _bold, italic: _italic,
    underline: _underline, strikethrough: _strike, inverse: _inverse, children, ...rest } = props;
  return <InkText {...rest}>{withoutSgr(children)}</InkText>;
}

export function App({ controller, onMounted, onInput, history: suppliedHistory, settings: suppliedSettings }: { controller: TuiController; onMounted?: () => void; onInput?: () => void; history?: PromptHistory; settings?: TuiSettings }): JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [markdown] = useState(createMarkdownCache);
  const [settings] = useState(() => resolveTuiSettings(suppliedSettings));
  const [plain] = useState(() => process.env["NO_COLOR"] !== undefined);
  const palette = settings.palette, permissionKeys = settings.keybindings.permission;
  const [state, setState] = useState<TuiState>(controller.snapshot());
  const [input, setInput] = useState("");
  const [clock, setClock] = useState(Date.now());
  const historyRef = useRef<PromptHistory>(suppliedHistory ?? new PromptHistory());
  const recall = useRef(new PromptRecall());
  const completionHint = useRef("");
  const slashActive = useRef(false);
  const slashIndex = useRef(0);
  const suggestions = (text: string) => {
    const current = controller.snapshot();
    if (!slashActive.current || current.pending !== null || current.question !== null || current.escalation !== null || !/^\/[^\s/]*$/.test(text)) return [];
    const prefix = text.slice(1).toLowerCase();
    return controller.completionCandidates().filter(candidate => candidate.name.toLowerCase().startsWith(prefix));
  };
  // Startup notices are already in the initial controller snapshot. Never acknowledge them
  // before this actual React/Ink mount (a timer or queued controller line is not readiness).
  const mounted = useRef(false);
  useEffect(() => controller.mountStatus(), [controller]);
  useEffect(() => { if (!mounted.current) { mounted.current = true; onMounted?.(); } }, [onMounted]);
  const deferredState = useRef<TuiState | null>(null);
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
  buffer.current ??= new InputBuffer((next) => {
    setInput(next);
    // Controller events and clock ticks share the input quiet point. React batches these updates,
    // producing one paste-safe render with the freshest state once terminal input has completed.
    if (deferredState.current !== null) {
      setState(deferredState.current);
      deferredState.current = null;
    }
    setClock(Date.now());
  });
  const buf = buffer.current;
  const pasteDecoder = useRef<BracketedPasteDecoder | null>(null);
  pasteDecoder.current ??= new BracketedPasteDecoder();
  const paste = pasteDecoder.current;
  useEffect(() => () => buf.dispose(), [buf]);

  // Everything the controller has to say reaches the screen through here and nowhere else: the
  // reply, the event lines, the status, the permission prompt. Without it the TUI still accepts
  // input and still runs the agent — it just never shows any of it, which is not a failure any
  // test that counts bytes can see. `test/tui-visible.test.ts` asserts the content instead.
  useEffect(
    () =>
      controller.subscribe((next) => {
        if (paste.isPasting || paste.hasPendingMarker || buf.hasPendingDraw) {
          deferredState.current = next;
        } else {
          setState(next);
        }
      }),
    [buf, controller, paste],
  );

  useEffect(() => {
    if (state.activity === null) return;
    const timer = setInterval(() => {
      // A terminal can block if the TUI writes while it is still delivering input. Bracketed paste
      // state covers arbitrarily slow framed pastes; InputBuffer covers unframed bursts and the
      // final quiet window. Its next safe draw flushes the clock through the callback above.
      if (!paste.isPasting && !paste.hasPendingMarker && !buf.hasPendingDraw) setClock(Date.now());
    }, 1_000);
    return () => clearInterval(timer);
  }, [buf, paste, state.activity]);

  useRawInput((raw, char, key) => {
    onInput?.();
    // Use the synchronous controller state, not a React render from before this stdin batch.
    // A preview created by this same raw chunk cannot also be confirmed by trailing bytes.
    const previewAtInput = controller.snapshot().pending?.scope;
    const questionAtInput = controller.snapshot().question;
    const composerAction = (action: OrdinaryInputAction): void => {
      const current = controller.snapshot();
      const protectedInput = questionAtInput !== null || current.question !== null || current.escalation !== null || current.pending !== null;
      const edit = (text: string): void => { recall.current.reset(); completionHint.current = ""; slashActive.current = !protectedInput; slashIndex.current = 0; buf.set(text); };
      const matches = protectedInput ? [] : suggestions(buf.value);
      if (action.type === "up" || action.type === "down") {
        if (matches.length) {
          slashIndex.current = (slashIndex.current + (action.type === "up" ? -1 : 1) + matches.length) % matches.length;
          buf.touch();
        } else if (!protectedInput) { slashActive.current = false; completionHint.current = ""; buf.set(recall.current.move(action.type === "up" ? -1 : 1, buf.value, historyRef.current.values())); }
      } else if (action.type === "escape") {
        if (!protectedInput) { slashActive.current = false; completionHint.current = ""; buf.touch(); }
      } else if (action.type === "tab") {
        if (!protectedInput) {
          if (matches.length) { edit(`/${matches[Math.min(slashIndex.current, matches.length - 1)]!.name} `); return; }
          const before = buf.value;
          if (/(^|\s)@[^\s"@]*$/.test(before)) {
            void controller.completeInput(before).then(result => {
              if (buf.value !== before || controller.snapshot().pending !== null || controller.snapshot().question !== null || controller.snapshot().escalation !== null) return;
              recall.current.reset(); completionHint.current = result.hint; buf.set(result.text);
            });
          } else { const result = completePrompt(before, controller.completionNames()); recall.current.reset(); completionHint.current = result.hint; buf.set(result.text); }
        }
      } else if (action.type === "newline") {
        if (!protectedInput) edit(buf.value + "\n");
      } else if (action.type === "paste-image") {
        if (!protectedInput) void controller.pasteImage();
      } else if (action.type === "backspace") edit(buf.value.slice(0, -1));
      else if (action.type === "append") edit(buf.value + action.text);
      else if (action.type === "enter") {
        const line = buf.value;
        if (questionAtInput !== null) buf.set("", () => controller.answerQuestionText(line, questionAtInput));
        else if (current.escalation !== null) buf.set("", () => controller.answerEscalation(line));
        else if (!protectedInput) {
          const trailing = /\\+$/.exec(line)?.[0].length ?? 0;
          if (trailing % 2 === 1) { edit(line.slice(0, -1) + "\n"); return; }
          recall.current.reset(); completionHint.current = "";
          slashActive.current = false;
          buf.set("", () => {
            historyRef.current.remember(line);
            void controller.submit(line).then(keepGoing => { if (!keepGoing) exit(); });
          });
        }
      }
    };
    const permissionAction = (action: OrdinaryInputAction): void => {
      const pending = controller.snapshot().pending;
      if (pending === null) return;
      const pressed = action.type === "append" && /^[a-zA-Z]$/.test(action.text) ? action.text.toLowerCase() : undefined;
      buf.touch(); // coalesce scope edits and controller redraws at the input quiet point
      if (pending.scope !== undefined) {
        if (action.type === "escape") controller.cancelPermissionScope();
        else if (pending.scope.preview) {
          if (pressed === permissionKeys.allowOnce && pending.scope === previewAtInput) controller.confirmPermissionScope();
          else if (pressed === permissionKeys.editScope) controller.editPermissionScope(pending.scope.text);
          else if (pressed === permissionKeys.denyOnce) controller.cancelPermissionScope();
        } else if (action.type === "enter") controller.previewPermissionScope();
        else if (action.type === "backspace") controller.editPermissionScope(pending.scope.text.slice(0, -1));
        else if (action.type === "append") controller.editPermissionScope(pending.scope.text + action.text);
        return;
      }
      if (pressed === permissionKeys.scope) controller.startPermissionScope();
      else if (pressed === permissionKeys.allowOnce) controller.answerPermission("allow");
      else if (pressed === permissionKeys.allowSession) controller.answerPermission("allow", true);
      else if (pressed === permissionKeys.denySession) controller.answerPermission("deny", true);
      else if (action.type === "escape" || pressed === permissionKeys.denyOnce) controller.answerPermission("deny");
    };
    const dispatchAction = (original: OrdinaryInputAction): void => {
      const action = (original.type === "up" || original.type === "down") && suggestions(buf.value).length
        ? original : mapTuiAction(original, settings); if (action === undefined) return;
      if (action.type === "interrupt") {
        if (!controller.isIdle()) controller.abort();
        else exit();
      } else if (controller.snapshot().pending !== null) permissionAction(action);
      else composerAction(action);
    };
    const decoded = paste.feed(raw);
    if (decoded.protocol) {
      // A paste cannot answer a permission prompt accidentally. Protocol chunks are still consumed
      // so a later 201~ restores ordinary input correctly.
      for (const segment of decoded.segments) {
        if (segment.text === "") continue;
        if (segment.pasted) {
          slashActive.current = false;
          // The decoder normalises CRLF across chunks; every other payload byte is preserved.
          if (controller.snapshot().pending === null) { recall.current.reset(); completionHint.current = ""; buf.set(buf.value + segment.text); }
          continue;
        }

        // Bytes adjacent to an unmatched closing marker are ordinary input. Ink gives one semantic
        // key for the whole raw chunk, so replay the control bytes here after stripping the marker.
        for (const action of ordinaryInputActions(segment.text)) dispatchAction(action);
      }
      // There is deliberately no timer while a paste or possible split marker remains open. Even a
      // long delivery pause is not proof that the terminal has finished writing the paste.
      if (paste.isPasting || paste.hasPendingMarker) buf.hold();
      else buf.touch();
      return;
    }

    // A possible marker prefix may have occupied earlier callbacks. Once disproved, restore its
    // printable bytes before applying Ink's unchanged semantics for the current chunk.
    if (decoded.released !== undefined) buf.set(buf.value + decoded.released);

    if (key.ctrl && char === "c") {
      dispatchAction({ type: "interrupt" });
      return;
    }

    if (raw === "\u0010" || raw === "\u000e" || raw === "\u0007") { dispatchAction({ type: "append", text: raw }); return; }

    if (raw === "\u0016") { void controller.pasteImage(); return; }

    // A terminal may coalesce supported Shift-Enter with printable bytes on either
    // side. Decode only those exact sequences; the remainder is literal paste-like
    // text, never a stream of Enter/approval actions. Submission still needs its
    // own input event and the InputBuffer quiet point.
    const shiftedEnter = /\u001b\[(?:13;2u|27;2;13~)/g;
    if (shiftedEnter.test(raw)) {
      const current = controller.snapshot();
      if (current.pending !== null) return;
      const protectedInput = questionAtInput !== null || current.question !== null || current.escalation !== null;
      composerAction({ type: "append", text: raw.replace(shiftedEnter, protectedInput ? "" : "\n").replace(/\r\n?/g, "\n") });
      return;
    }

    // a permission prompt takes the keyboard: answering it is the only useful thing to do
    if (controller.snapshot().pending !== null) {
      if (key.return) permissionAction({ type: "enter" });
      else if (key.escape) permissionAction({ type: "escape" });
      else if (key.backspace || key.delete) permissionAction({ type: "backspace" });
      else if (char !== "" && !key.ctrl && !key.meta) permissionAction({ type: "append", text: char });
      return;
    }

    if (key.upArrow || key.downArrow || key.tab) { dispatchAction({ type: key.upArrow ? "up" : key.downArrow ? "down" : "tab" }); return; }
    if (key.escape) { composerAction({ type: "escape" }); return; }
    if (key.return && key.shift) { composerAction({ type: "newline" }); return; }
    if (key.return) {
      // queued rather than run now: a bare carriage return can be drained in the same batch as
      // the text ahead of it, so "the user pressed enter" is not proof that stdin has gone quiet
      composerAction({ type: "enter" });
      return;
    }
    if (key.backspace || key.delete) {
      composerAction({ type: "backspace" });
      return;
    }
    if (char === undefined || char === "" || key.ctrl || key.meta) return;
    // A newline INSIDE a chunk is pasted text, not the enter key. This used to submit at the
    // first one and join the remainder with spaces, so pasting a multi-line brief sent only its
    // first line as the task and answered every following line with "a turn is already running".
    // Enter is its own chunk and is handled above; a paste is kept whole, line breaks and all —
    // `fitToRows` measures rendered rows, so a multi-line buffer draws correctly.
    if (/[\r\n]/.test(char)) {
      composerAction({ type: "append", text: char.replace(/\r\n?/g, "\n") });
      return;
    }
    composerAction({ type: "append", text: char });
  });

  // `||`, not `??`: Ink's own layout notes that `columns` is undefined OR ZERO off a TTY, and a
  // zero width collapses the budget to one character per row — the user saw the marker and none
  // of what they had typed
  const columns = stdout?.columns || 80;
  const rows = liveRows(stdout?.rows);
  const matches = suggestions(input);
  const selected = Math.min(slashIndex.current, Math.max(0, matches.length - 1));
  const menuRows = matches.length ? Math.min(4, matches.length, Math.max(0, rows - 1)) : 0;
  const menuStart = menuRows ? Math.floor(selected / menuRows) * menuRows : 0;
  const selectedCandidate = matches[selected];

  return (
    <PlainText.Provider value={plain}><Box flexDirection="column">
      {/*
        `Static` writes each line ONCE above the live frame and never re-renders it. Keeping the
        scrollback as live `<Text>` made render cost grow with the buffer — 800 lines took 5s at
        a 500-line cap versus 0.5s at 50 — because Ink repaints the whole frame on every print,
        which also destroys terminal scrollback for anything scrolled past.
      */}
      <Static items={state.lines}>
        {(l) => (
          <Text key={l.key} color={palette[l.tone]}>
            {markdown(l, columns, !plain)}
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
          <Text color={palette.assistant}>{fitToRows(state.streaming, columns, rows)}</Text>
        </Box>
      ) : null}

      {state.pending !== null ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={palette.warning}>
            {state.pending.req.origin === "sandbox-escalation" ? (
              <>blocked by sandbox — run outside it?</>
            ) : (
              <>
                {fitToRows(`allow ${JSON.stringify(state.pending.req.tool)} [${state.pending.req.class}]? Declared effects and unknowns above.`, columns, 2)}
              </>
            )}
          </Text>
          {state.pending.scope !== undefined ? <>
            <Text>{fitToRows(state.pending.scope.preview
              ? `Exact future scope printed above. ${permissionKeys.allowOnce} = confirm grant, ${permissionKeys.editScope} = edit, ${permissionKeys.denyOnce} / esc = cancel scope`
              : `Edit ${state.pending.scope.kind === "path" ? "absolute pathPrefix" : "literal commandPrefix + absolute cwd"} JSON; enter = preview, esc = cancel scope`, columns, 2)}</Text>
            <Text>{fitToRows(state.pending.scope.error ?? state.pending.scope.text, columns, rows)}</Text>
          </> : <Text dimColor>
            {state.pending.req.origin === "sandbox-escalation"
              ? `${permissionKeys.allowOnce} = run outside once, ${permissionKeys.denyOnce} / esc = deny`
              : state.pending.req.origin === "mcp-definition-change"
              ? `${permissionKeys.allowOnce} = approve these exact definitions, ${permissionKeys.denyOnce} / esc = deny (no standing grant)`
              : state.pending.req.origin === "external-input-expansion"
              ? `${permissionKeys.allowOnce} = approve this first-use expansion once, ${permissionKeys.denyOnce} / esc = deny (no standing grant)`
              : state.pending.permissionGrants === undefined ? `${permissionKeys.allowOnce} = allow once, ${permissionKeys.denyOnce} / esc = deny (no standing grants for this request)`
              : `${permissionKeys.allowOnce} = allow once, ${permissionKeys.allowSession} = allow all session, ${permissionKeys.scope} = scope, ${permissionKeys.denyOnce} / esc = deny, ${permissionKeys.denySession} = deny all session`}
            {state.queued > 0 ? ` · ${state.queued} more waiting` : ""}
          </Text>}
        </Box>
      ) : state.question !== null ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={palette.warning}>{fitToRows(`Question: ${state.question.request.prompt}\n${state.question.request.options.map((option, index) => `${index + 1}. ${option}`).join("\n")}`, columns, Math.max(2, Math.min(7, rows - 3)))}</Text>
          <Text>{fitToRows(`answer: ${input}`, columns, 2)}</Text>
          <Text dimColor>{fitToRows(`Enter a number or free text; clarification is not permission.${state.queuedQuestions ? ` ${state.queuedQuestions} more waiting.` : ""}`, columns, 2)}</Text>
        </Box>
      ) : state.escalation !== null ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={palette.warning}>supervisor asks: {state.escalation.question}</Text>
          <Box>
            <Text color={palette.you}>answer: </Text>
            <Text>{fitToRows(input, columns - 8, rows)}</Text>
          </Box>
          <Text dimColor>enter sends this guidance to the running agent; unanswered prompts expire</Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          {state.reviewing ? <Text color={palette.warning}>reviewing captured diff · /abort to cancel · </Text> : null}
          <Text color={state.status === "running" ? palette.warning : palette.prompt}>
            {state.status === "running" ? "· " : "> "}
          </Text>
          {/* less the two columns the prompt marker takes, or the line wraps one row further */}
          <Text>{fitToRows(input, columns - 2, rows - menuRows)}</Text>
        </Box>
      )}

      {menuRows > 0 ? <Box flexDirection="column">
        {matches.slice(menuStart, menuStart + menuRows).map((candidate, offset) =>
          <Text key={candidate.name} color={menuStart + offset === selected ? palette.prompt : palette.status} wrap="truncate-end">
            {`${menuStart + offset === selected ? "›" : " "} /${candidate.name} [${candidate.kind}]`}
          </Text>)}
      </Box> : null}

      <Box>
        {/*
          truncated, never wrapped: the statusline is budgeted as ONE row (see `liveRows`), and a
          long branch name wrapping to two would push the frame past the height the viewport was
          sized to hold
        */}
        <Text color={palette.status} dimColor wrap="truncate-end">
          {selectedCandidate ? `${selected + 1}/${matches.length} /${selectedCandidate.name} · ↑↓ choose · Tab fill · Enter run typed command`
            : state.pending === null && state.question === null && state.escalation === null && completionHint.current ? completionHint.current : statusLine(state, clock)}
        </Text>
      </Box>
    </Box></PlainText.Provider>
  );
}
