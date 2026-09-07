# Slash suggestions independent review

Frozen8041f81 vs basedb2271b. One substantive review requested24/reported25,
exhausted without verdict; sole tools-disabled same-session summary1/1, total26
reported turns. Session06150679-e708-4d92-8768-4496242d076a. Metadata list-price
$1.7889635 + $0.79505 is not a subscription invoice. No reviewer tests/build/typecheck.

## Verbatim reviewer result

# Slash suggestions review — frozen 8041f81 vs base db2271b

**Verdict: APPROVE with one material finding (dead code, not a behavior defect) and two non-blocking notes.**

## Commands actually run

Static inspection only, plus these read-only git/grep commands: `git diff --stat`, `git diff` over `packages/cli/src/tui/{app.tsx,controller.ts}`, `packages/cli/test/`, `README.md`, `docs/`; `grep`/`sed` over `controller.ts`, `commands.ts`, `settings.ts`, `viewport.ts`, `input-buffer.ts`, `raw-input.ts`, `start.tsx`, the two touched test files, `tui-settings-ui.test.ts`, `bracketed-paste.test.ts`, and Ink 5.2.1's `parse-keypress.js`.

**No tests, build, or typecheck were run.** One attempt to transpile `input-buffer.ts` with `pnpm exec esbuild` for a scratch harness was denied by the permission mode; I did not retry or work around it. Every conclusion below is static, derived from source and from existing committed tests that already pin the relevant decoder behavior. I did not verify the author's claim of 34 passing focused tests, nor the frame/Docker/Chromium evidence.

## Material finding

**`packages/cli/src/tui/app.tsx:262` is unreachable.**

```tsx
if (key.escape) { composerAction({ type: "escape" }); return; }
```

Ink sets `key.escape` only when the raw chunk is exactly `\x1b` or `\x1b\x1b` (`parse-keypress.js:168-172`). Both chunks end in a bare ESC, which `BracketedPasteDecoder.feed` retains as a possible marker prefix (`input-buffer.ts:147-153`), so `decoded.protocol` is `true` and `app.tsx:203-223` returns before line 262 is ever evaluated. This is pinned by an existing committed test: `bracketed-paste.test.ts:71` asserts `decoder.feed(ESC).protocol === true`, and `tui-settings-ui.test.ts:51` needs **two** `send("\u001b")` calls to land one deny.

The intended behavior still works, via a different path: the ESC is delivered on the *next* chunk as an ordinary segment, `ordinaryInputActions` (`input-buffer.ts:69`) maps it to `{type:"escape"}`, and `dispatchAction` (`app.tsx:200`) routes it to `composerAction`, where the new branch at `app.tsx:136-137` closes the menu. So escape-dismisses-suggestions requires two presses, exactly like escape-denies-permission does today — consistent with the plan's "Escape retains the existing split-terminal-sequence/quiet-point handling."

Fix: delete `app.tsx:262`. If you keep it, add a comment saying it is a fallback for a stdin source that bypasses the decoder, because as written it reads like the primary escape path and it is not. Also note that no new test covers escape closing the menu; the five added cases never send ESC as a composer key. A two-chunk `send("\u001b"); send("\u001b")` assertion in `prompt-composer.test.ts`, mirroring `tui-settings-ui.test.ts:51`, would pin the real path.

## Non-blocking notes

**Two of the six frame-budget configurations do not exercise the menu.** At `rows=8`, `liveRows` returns `max(1, min(8, floor((8-6)/2))) = 1` (`viewport.ts:90-95`), so `menuRows = min(4, matches, max(0, rows-1)) = 0` (`app.tsx:294`) and no list renders. The `[80,8]` and `[120,8]` cases in `prompt-composer.test.ts` are satisfied by `/Skill00` / `/Skill15` appearing in the *status hint* (`app.tsx:394`), not the menu. That is the correct safe degradation, and the cases still verify the real cliff property (no `\u001b[2J`, no `SCROLLBACK_` replay, `unreadAtWrite` all zero), so I would not gate on it — but the test name overstates what those two rows prove.

**Redraw on arrow navigation is indirect.** `slashIndex` is a ref, and `buf.touch()` (`app.tsx:134`) reaches React only through the draw callback, where `setInput(next)` is a same-value no-op; the re-render is actually forced by `setClock(Date.now())` (`app.tsx:85`). It works because draws are separated by the 32 ms quiet window (`input-buffer.ts:194`), so the clock always advances — but the menu's correctness rests on an unrelated state update. A `useState` selection index, or a version counter bumped in the touch path, would make it explicit.

## What I confirmed sound

- **Frame budget is preserved.** `menuRows ≤ rows - 1`, so `fitToRows(input, columns-2, rows - menuRows)` always gets ≥ 1 row and input + menu ≤ the pre-existing single-region budget. No net frame growth (`app.tsx:294, 376, 380-385`).
- **Selection vs typed Enter.** Enter (`app.tsx:155-168`) submits `buf.value` and clears `slashActive`; the highlighted candidate is never substituted. Tab (`app.tsx:140`) only fills `/name ` — the trailing space breaks `/^\/[^\s/]*$/` and closes the menu.
- **Protected input is inert.** `suggestions()` (`app.tsx:53-58`) re-checks `controller.snapshot()` for `pending`/`question`/`escalation` on every call, and `edit()` sets `slashActive = !protectedInput`. I traced the pending-permission case: `/`, Tab and Down all reach `permissionAction` and do nothing, and `suggestions(buf.value)` at line 194 returns `[]` so `mapTuiAction` still applies.
- **Framed paste is inert.** `app.tsx:209` clears `slashActive` inside the `segment.pasted` branch before the buffer append.
- **Beyond-eight navigation.** Paging via `menuStart = floor(selected / menuRows) * menuRows` reaches every match; the added test drives index 10 of 37, past the old eight-name hint.
- **Catalogue and labels.** `completionCandidates` (`controller.ts:417-420`) reuses `completionNames`, so the 256 cap, the `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$` validation and the reserved-name shadow rule all carry over. Every `COMMANDS` name is present in `RESERVED_COMMAND_NAMES`, so the `[skill]`/`[command]` split is accurate, and V8's stable sort preserves alphabetical order within each kind. Extension commands set via `setCommands` were already absent from `completionNames` and remain absent — pre-existing, and outside this plan's stated scope.
- **Keybindings.** `mapTuiAction` passes `escape` through unchanged, so bypassing it at line 262 would have been harmless anyway. The up/down bypass at `app.tsx:194-195` means arrows drive the menu even for a user who rebound history to ctrl-p/ctrl-n; ctrl-p/ctrl-n still map to up/down and also drive the menu, so both bindings work. Themes are used only through `palette.prompt`/`palette.status`, and `NO_COLOR` still strips via the existing `PlainText` provider.
- **Startup wiring is real.** `start.tsx:126` calls `controller.setSkills(built.skills)`, and the added `prompt-history-startup.test.ts` case drives `startTui` with the actual `buildAgent` (only `provider.stream` is spied), asserting a temp on-disk skill appears on `/` with `fetch` never called.

## Author disposition

Removed the unreachable ordinary Escape branch; retained decoded Escape handling.
The redraw note produced two real failures with Date.now held constant. An explicit
quiet-point draw revision now makes navigation independent of clock progress;
the same two controls pass after restoration. No immediate React update is made
while input remains buffered. No second broad review.

Clarification: two Escapes change menu state but leave a possible marker prefix,
so dismissal becomes visible at the next safe decoded draw, not necessarily on
the second key. A retained actual-Ink test sends a disambiguating Tab and verifies
no menu or dispatch. Tiny8-row terminals intentionally use the one-row status
fallback; test wording now distinguishes it from the visible list at12/24 rows.

