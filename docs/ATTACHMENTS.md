# Explicit TUI attachments

In an ordinary TUI prompt, write `inspect @src/example.ts` or
`compare @"file with spaces.txt" @other.txt`. `@@name` means a literal `@name`;
email addresses are not references. Slash commands, approval answers and question
answers are not parsed as attachments. A reference-only prompt is allowed, but is
advisory data, not fresh authorization to execute its contents.

Tab after an unquoted `@path-prefix` completes one directory level. It performs a
configured read-class policy check, with one-time approval when required. This is
metadata enumeration, not a content read or a canonical tool execution receipt.
It does not consume/create standing grants; the later file read goes through the
actual session permission/grant/audit pipeline. Enforcing sandboxes refuse this
host-side completion; explicitly typed references remain available. Whitespace,
quote and at-sign names are not suggested; type a quoted reference instead.

Press **Ctrl+V** as a distinct key event to stage an image from the clipboard.
Normal terminal text paste (including bracketed paste) never inspects the clipboard.
The key must reach AgentRig: terminal keybindings may intercept it. A chip confirms
staging; Enter submits it with the current prompt, and `/new` discards staged images.
Only two clipboard images may be staged. File images use `@image.png` instead.

Clipboard support uses an existing desktop helper, not a dependency installer:

| Platform | Helper |
|---|---|
| Wayland Linux | `wl-paste --type image/png --no-newline` |
| X11 Linux | `xclip -selection clipboard -t image/png -o`; local `:display[.screen]` only |
| macOS | `pngpaste -` from jcsalterego/pngpaste |
| Windows | Windows PowerShell, fixed no-profile/noninteractive STA script using Clipboard.GetImage |

One backend is selected; failure never probes another clipboard. Missing helper,
unsupported display, non-image content, cancellation or timeout visibly refuses.
There is no OSC52 request, startup read, polling, or clipboard access in headless,
ACP or web input. Enforcing sandboxes refuse host clipboard access. Clipboard
helpers and their native image codecs are trusted local host code; the two-second
deadline and four-MiB capture cap are not a native decoder memory sandbox. The
owned child is killed and its close is joined before reporting cancellation.

Per submission: eight attachments; text must be valid UTF-8, at most 64 KiB each
and 256 KiB total. Images: PNG/JPEG/GIF/WebP with recognized bounded headers, at most
4 MiB each and 8 MiB total, 16 million declared pixels each. Clipboard is PNG only.
These are container-header checks, not a full image decoder or authenticity check.
Directories, aliased file paths, unsupported binary data and excess limits refuse
before provider dispatch. Reads are cooperative point-in-time observations, not
atomic snapshots against hostile external writers. Hooks which rewrite attachment
input/output refuse, rather than bypassing a hook's intended redaction.

File content inside the canonical trusted project is project-sourced; other file
content is external. Clipboard images are explicitly user-sourced. All are advisory
blocks, not instructions or permission grants. Only separately typed prose supplies
fresh user instructions. The same metadata survives continuation, resume and
compaction according to the existing conservative source rules.

Privacy: input history retains only typed references, not materialized contents or
clipboard bytes. Screen chips similarly omit payloads. **Canonical session logs
and snapshots contain the actual attachments** and are sensitive; normal configured
ingestion may process those records. Recalling a reference re-reads it with fresh
authorization; it does not recover the old clipboard image. No source-labeling
claim proves model obedience or prevents an explicitly authorized file disclosure.
