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
