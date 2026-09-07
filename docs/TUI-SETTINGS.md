# TUI themes and keys

Use the existing trusted user/project configuration or a named profile:

```json
{
  "tui": {
    "theme": "light",
    "keybindings": {
      "permission": { "allowOnce": "j", "denyOnce": "k" },
      "historyPrevious": "ctrl-p",
      "historyNext": "ctrl-n",
      "abort": "ctrl-g"
    }
  }
}
```

The default is `dark`. Both themes supply fixed transcript, prompt, warning and
status colours. `NO_COLOR` disables TUI colour/style escapes even when
`FORCE_COLOR` is set. It does not select a different keymap. There is no runtime
theme editor, custom ANSI palette, terminal background detection or automatic
config reload. Settings are captured at startup.

Permission defaults are `y` allow once, `n` deny once, `a` allow session, `d` deny
session, `s` edit a narrow scope and `e` re-edit its preview. Overrides must be
single ASCII letters, distinct ignoring case including unchanged defaults.
Scope confirmation uses the allow-once key and cancellation uses deny-once.
The displayed prompt names the effective keys. Changing a key never changes
permission policy, scope confirmation, separate-consent rules or grant lifetime.

History defaults to `up`/`down`. Each binding may be `up`, `down`, `ctrl-p` or
`ctrl-n`, but the two must differ. History remains unavailable in permission,
question and supervisor-answer prompts. The only configurable abort alias is
`ctrl-g`; Ctrl+C always remains available. Escape always denies/cancels permission
input. Enter, editing, structured questions and supervisor answers are not rebound.

Bracketed pasted payloads are text, never permission answers, history gestures or
abort commands. Ordinary input and protocol-adjacent input share the same keymap.
Invalid settings fail startup; they are not silently discarded. Nested settings
follow the existing config rule: later layers replace the whole `tui` object,
rather than deep-merging keymaps across user/project/profile layers.

See [R16h contract](plans/R16h.md) for verification and limits.

## Driving the TUI from a PTY

The first visible `agentrig — type a task` frame is a rendering observation, not
an input-readiness handshake. Do not send a task and Enter as one input chunk:
`task\r` in a multi-character chunk is pasted text, not a submission. This keeps
multi-line pastes from accidentally running their first line. Write the task,
wait until its input-buffer repaint is visible, then send a standalone carriage
return (`\r`, byte 0x0D). Neither LF (`\n`) nor CRLF (`\r\n`) submits; they append
a newline to the buffer. Keep a probe task short, or match its visible tail:
long input is truncated behind a `…(N more)` marker, not painted in full.
Separate PTY writes alone are insufficient: the OS may coalesce adjacent writes.
For bracketed paste, finish `ESC[200~…ESC[201~`, observe the input repaint, then
send Enter outside the paste. Do not use pasted text to answer permission prompts:
it is discarded, not saved as a task. Bracketed paste is discarded in the scope
editor too; only ordinary unframed bytes edit its scope JSON. Wait until protected
prompts are resolved before pasting a task.

Use a bounded wait and fail the fixture if the expected repaint or submission
never arrives. R17b's `.agentrig/r17/terminal-baseline.py` fixture, in
[PR #234](https://github.com/agentkitai/agentrig/pull/234), used 150 ms between
writes on its host; that delay is an observation, not a portable readiness
guarantee. Measure cold
start to the first visible prompt separately from Enter to the first assistant
token, and do not count the echoed task text as an assistant response.

In-process tests can use `packages/cli/test/tui-readiness.ts` to wait for a
specific controller state (for example, a pending permission) rather than a
fixed sleep. That helper is test-only, not a mounted-PTY or latency contract.

See [train operations](TRAIN-OPERATIONS.md) for live child and permission monitoring.
