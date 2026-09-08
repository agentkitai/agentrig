# TUI notifications

The recommended CLI profile defaults to a bell after 30 seconds without input
in this TUI. To change the threshold:

```sh
agentrig --notification-idle-seconds 30
```

Trusted project or user config can set:

```json
{"notifications":"both","notificationIdleSeconds":30}
```

Modes are `off`, `bell`, `desktop`, `both`; idle seconds are integers 1–3600.
Set `"notifications":"off"` in user or trusted project config to disable. See [the complete flag migration](DEFAULTS.md). These are UI preferences,
not model permissions. Headless run/CI, ACP, MCP and scheduler never notify.
Both input and output must be actual TTYs and the UI must be mounted.

Idle means no observed keyboard input in this TUI. AgentRig does **not** know
whether your terminal window has OS focus or whether you are active elsewhere.
An unanswered permission/question/supervisor prompt notifies once when the idle
threshold is reached. Input resets the timer. Permission prompts take precedence
over questions, then supervisor prompts. Cancelled/answered prompts are not
delivered later; notifications do not answer anything or grant permissions.
An OS notification already handed off cannot be retracted; cancellation prevents
new queued launches and cancels owned preparation/process work, not an atomic
check-and-display guarantee. Startup asks before the TUI mounts do not notify.
A completed run notifies only if already idle at completion. One delivery per two
seconds coalesces bursts; this is not a delivery guarantee or a persistent queue.

Desktop mode uses fixed generic text, never task/model/tool/path/error content.
It uses `/usr/bin/osascript` on macOS or `/usr/bin/notify-send` on Linux when
available. It neither installs a notification service nor follows repository PATH.
Windows and unavailable backends have no desktop delivery; a bounded diagnostic
appears once. Bell remains enabled only in `bell`/`both` mode. Desktop preferences,
permissions or do-not-disturb can suppress display, and process success does not
prove the human saw anything. The terminal also controls whether BEL is audible.

Helpers have a two-second execution bound and 4-KiB combined output cap. Output
is discarded. UI teardown cancels timers and joins the owned process/group;
platform kill cleanup can take additional time (Windows up to ten seconds).
Local filesystem checks and OS termination are cooperative, not hostile-process
containment. Notification preferences do not modify raw logs or provider context.

Primary backend references:

- [Apple's display notification guide](https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/DisplayNotifications.html)
  describes fixed message/title syntax and user notification settings.
- [GNOME's notify-send implementation](https://github.com/GNOME/libnotify/blob/master/tools/notify-send.c)
  defines the command's literal arguments. Notification display lifetime is owned
  by the desktop, separate from the helper's execution timeout.
