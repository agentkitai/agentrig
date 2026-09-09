# R17g CLI UI follow-ups

This is the UI subset of the single CLI batch, implemented by Codex in the shared
CLI worktree with explicitly disjoint ownership. Root owns delivery, driver
disclosure and independent review. No live AgentRig provider or evaluation calls were
used to assess these changes. Source tests use the private temporary root and fixture
preflight; compiled tests wait for the coordinated CLI build.

| END fragment | Precise disposition |
|---|---|
| R12b synchronous pending snapshot for framed paste | Already implemented at the current baseline in `app.tsx` (`controller.snapshot().pending` before retaining each pasted segment). Added an actual same-stdin-batch permission/open → pasted canary → deny → ordinary submit control in `prompt-composer.test.ts`; the canary never becomes a prompt or grant. No permission logic changed. |
| R4c disabled restore adapter | Root assigned startup wiring after the UI changes: `start.tsx` constructs the restore adapter and callback only when `supervisorAbortRestores === true`; startup validation and shared supervisor validation remain unchanged. Runtime helper owns the matching `run.ts` change and omitted-option abort lifecycle control; this is not new restore authority. |
| R16d stale completion hint | Implemented: `app.tsx` retires the hint synchronously on controller updates, preserving deferred paste-safe drawing. `prompt-composer.test.ts` first shows a completed hint, then unrelated controller output, then verifies the stale hint disappears without dispatch. |
| R16d hand-edited history blank/duplicate normalization | Declined behavior change: history is sensitive user-authored text; the existing bounded loader/recall contract does not authorize reinterpretation of manual edits. No demonstrated retrieval failure justifies a migration. `prompt-history.test.ts` retains its bounded persistence/recall checks. |
| Held-backspace ZWJ redraw | Implemented explicit decoded edit-gesture scheduling in `input-buffer.ts` and both composer/scope paths of `app.tsx`. Long grapheme deletion keeps its existing draw deadline. Unmatched close-marker plus edit-only chunks also retain it; closing an actual paste or split marker still starts a fresh quiet wait, and open framing holds all drawing. `input-buffer.test.ts` checks scheduling and hold/release; `prompt-composer.test.ts` drives actual Ink with ordinary/protocol repeated backspace and a controlled clock, observes a frame before release and no frame during pasted backspace. Existing payload, permissions, scope, questions and frame-budget controls remain. |
| R16a heading-level cues | Implemented bounded `#` depth markers in `markdown.ts`, including plain/NO_COLOR output. `markdown.test.ts` checks level one/three, plain level two, exact ANSI/table snapshots and existing resource/control-byte limits. |
| R16a restore assistant tone after inline SGR | Implemented a fixed white/black assistant tone argument through `App` and its weak completed-line Markdown cache. Renderer-owned resets restore that palette; source Markdown never supplies terminal codes. `markdown.test.ts` checks both tones; `tui-settings-ui.test.ts` checks compiled actual Ink in fresh dark/light/NO_COLOR processes. Source limits, table widths, weak-key cache retention and immutable original line text remain. |
| R16a browse oversized replies | Declined optional feature: a scrolling/searchable retained-reply viewer needs a separate bounded UI/interaction design; no request requires it here. Existing explicit truncated display and complete canonical logs remain, and no resource limit is widened. |
| R16h direct SDK invalid-settings diagnostic | Implemented `parseTuiSettings` shared by `resolveTuiSettings`/App and `startTui`, preserving strict validation and startup capture before provider construction. Fixed text explains supported theme/keys without printing arbitrary unknown field names/values. `tui-settings.test.ts` checks redaction; startup test checks refusal before build/mount. Config retains its own safe diagnostic path and whole-object precedence. |
| R16h collision-count derivation | Declined conditional refactor: this batch adds no permission actions; all six current actions and case-insensitive defaults remain tested. A derived count can accompany an actual new action. |
| R16h OSC handling | Declined conditional feature: no OSC queries or terminal background detection are issued, so no reply protocol exists to distinguish from Ctrl+G. Existing control stripping and opted-in abort mapping remain. |
| R15a pending slash/numeric wording | Implemented actual question-frame text: digits 1–4 alone select options; other text including `/commands` is literal, and numeric prose can use “value 2”. Answers remain separate from permissions. Existing actual Ink slash-answer controls now assert the displayed explanation. Controller validation is unchanged; unavailable option numbers still refuse. |
| R15a heartbeat suppression and deadline attribution | Root owns `run.ts`, question-controller deadline alignment and `heartbeat.test.ts`. UI does not determine heartbeat tool registration; root added explicit missing `ask_user` and no question-event assertions. |
| R15a nonheadless terminal questions | Declined optional extra surface: the TUI/ACP/explicit file-policy question paths already define protected input. Introducing another terminal question queue is not necessary for these diagnostics and would require lifecycle/permission-priority design. |
| R16e headless option type and schema-module extraction | Root implemented `TuiOptions.headless` and `notification-config.ts`; preserved both. Existing `notifications.test.ts` already has actual mounted headless silence and real headless CLI no-BEL controls, plus positive mounted notification ownership tests. No duplicate wiring test is needed for the type-only addition. Root owns CLI help spacing. |
| R16f absent usage snapshots | Already delivered in PR #222; this UI subset does not change usage accounting or status observations. |
| R16f detached custom-policy label | Declined conditional feature: no observable detached custom-policy lifecycle was added; the existing unknown label remains honest. |
| R16f multiple-App reference counting | Declined unsupported scenario: simultaneous App mounts for one controller are not a supported contract. No reference-count lifecycle is introduced speculatively. |

Initial fail-first run: seven assertions failed against unmodified UI behavior
(long-grapheme deadline, two heading/theme cases, two ANSI snapshots, stale
completion hint, startup diagnostic); 66 other assertions passed. The actual
held-backspace test then caught the unmatched-close-marker redraw reset and passed
after its bounded correction. Initial broad source verification passed 121 tests
in seven files including paste controls and frame budgets. Final results and
restored mutation controls are recorded below after the coordinated build.

Final restored source verification passed 124 tests in eight files (input buffer,
actual composer, Markdown, settings/defaults/startup, bracketed paste, history and
visible transcript). Earlier full frame-budget coverage also passed in the
121-test run above. After the evaluation helper's coordinated CLI build, the
fresh-process actual Ink theme suite plus notifications and startup passed all
32 tests in three files. Ink normalizes SGR sequences, so the theme oracle folds
actual terminal foreground at the following prose instead of assuming an
intermediate renderer reset spelling; both dark/light foregrounds and NO_COLOR
are asserted. Existing actual headless no-BEL coverage passed unchanged.

Two temporary production mutations were run and restored: removing the App's
decoded backspace gesture failed both ordinary/protocol held-key tests (two
failures); removing assistant tone restoration failed both palette tests (two
failures). The final source runs used restored code. No fixture deadline was
increased, no test skipped, no trust/input/permission checks relaxed. Root owns
the final combined source build/full suite and exact-head CI; this helper did not
stage, commit, push or review independently.
The final CLI source typecheck and `git diff --check` passed after the later R4c
startup gating change; root's final build will refresh that compiled startup path.
