# R15k independent review

Frozen head: `08d41a31c95f5e503a948cf26014d6619fd7b557`; base `93452df`.
One read-only Claude invocation requested at most 24 turns; result reported 35 turns,
`is_error: false`. No additional review round. Two attempted ad-hoc Node checks
were denied; those findings were explicitly inference, not independent reproduction.
Review session: `e2cb24b5-3134-4865-9e2d-68d1b0efb2eb`; reported duration
270,068 ms (API duration 268,563 ms).

## Author clarification

The original review's statement that no `renderEvent` function exists is incorrect:
`packages/cli/src/render.ts:64` exports it. The statement that this row adds no new
event type is correct. The post-review additive `session.start.inputAttachments`
marker passes the real event-schema/store pipeline and the attachment-only
initial/resumed regression asserts materialized messages equal snapshot messages.
This clarification does not change the original prose below or imply another review.

## Original result (verbatim)

**Verdict: approve with one material fix.** R15k at 08d41a3 versus 93452df is sound on the security properties it claims. I found one correctness defect on a shipped gesture, plus minor optional items.

**Verification actually executed**

| Check | Result |
|---|---|
| `pnpm typecheck` | pass, all packages |
| `vitest run` core/input-attachments, cli/attachments, cli/attachments-startup | 3 files, 23 tests pass |

**Findings**

1. **Medium, correctness (inference, not reproduced live).** Attachment-only submission on a fresh conversation sends an empty text block to the provider. In `packages/core/src/agent.ts:518` the initial user message is built with the empty task text. The advisory branch clears it at line 520, but the attachments branch at lines 551 to 584 appends a second user message and leaves the empty one in place. The TUI reaches this through `packages/cli/src/tui/controller.ts:268`, where an empty line with staged clipboard images calls continueConversation with an empty task and, with no prior session, no resume. The resume path is guarded at agent.ts:503. The Anthropic mapping at `packages/core/src/providers/anthropic.ts:64` serializes the empty block verbatim, and the Anthropic API rejects empty text blocks. The core test for attachment-only initial input passes only because its fixture provider does not validate content. Fix: mirror line 520 for the attachments case. My node reproduction script was denied by the permission mode, so this is code-based inference.

2. **Low, robustness (inference).** `packages/cli/src/tui/attachments.ts:159` relies on the close event firing after a spawn ENOENT to reject with "helper unavailable". Node does emit close after ENOENT in my understanding, but no test covers a missing helper. If close never fired, the input-busy flag in controller.ts:189 would stay set and every later submit would refuse at controller.ts:266. A test spawning a nonexistent command would settle this. My direct spawn check was also denied.

3. **Low, optional polish.** Ctrl+V while a turn is running or while completion is in flight returns silently from pasteImage at controller.ts:199. The plan promises visible refusal for unavailable clipboard. This is a gesture ignored rather than a clipboard failure, so it is polish, not a contract breach.

**Properties verified as holding, with locations**

- No clipboard access except the explicit gesture. Only the raw Ctrl+V byte at app.tsx:205 and the decoded paste-image action at app.tsx:125 call pasteImage. Bracketed paste segments are appended as text at app.tsx:171. The startup test asserts zero helper calls at startup, one after the gesture, and none during a pending permission prompt.
- Read-class authorization and provenance. The file reader runs through executeTool with the session grant registry and expansion state at agent.ts:561. Read deny wins with exec allowed, grants are matched and audited before the call, and project versus external labels come from the resultSource seam via `content-provenance.ts:42`. Clipboard blocks are labeled user and advisory.
- Whole-batch refusal. Any failed read, header, or aggregate check throws before the single message.append at agent.ts:583, so no partial attachment reaches the model. Hook patches and injects on the attachment path refuse at agent.ts:567.
- Attachment-only expansion and resume. Covered by the core test that runs an outside file initially and a clipboard image on resume with exec allowed, observing zero tool effects and two expansion events.
- Completion is per-request and one-time. completeAttachment consults only the configured policy at attachments.ts:118 and asks with an empty context, which makes the registry undefined at controller.ts:405. The prompt then shows the no-standing-grant hint at app.tsx:76 and the test asserts no grants are recorded.
- Bounds, cancel, cleanup. Counts, per-item and aggregate byte caps, pixel cap, 256-entry scan cap, 2-second deadline, bounded stderr, SIGKILL on abort, and shutdown awaiting input work and clearing staged images are all present and mostly exercised by tests.
- Privacy. History and screen output are asserted free of file contents and PNG bytes. The internal attachment kind reuses the protected user-role message.append and tool receipts. The ACP change is title mapping only.

**Omitted checks**

- No full suite, no real clipboard, provider, auth, or network.
- No live node reproduction of finding 1 or finding 2, both denied by the permission mode.
- JPEG, GIF, and WebP header parsing reviewed by reading only; tests use PNG fixtures.
- Windows and macOS helper invocation not executed.
- The CLAUDE.md rule mentioning a renderEvent case did not apply since no new event type was added, and no renderEvent function exists in source.
