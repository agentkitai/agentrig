# Grapheme-editing independent review

One substantive review, frozene9870f9 against300c5e2. Requested24/reported21
turns; session61e1a448-7015-495a-adfe-80e40c3a5845. APPROVE. No summary continuation
or second review. Reviewer ran the test groups listed below; build/typecheck were
not independently run. Metadata list-price $0.775661 is not a subscription invoice.

## Verbatim result

# APPROVE

Single commit `e9870f9` on top of `300c5e2`, clean tree, 8 files, no source changes outside the two named sites.

## Executed here (not inferred)
All via `pnpm exec vitest run` (the only permitted runner; `tsc`/build was denied, so **typecheck and build are author-claimed, not re-verified by me**):

| Run | Result |
|---|---|
| `prompt-composer` + `prompt-history` + `bracketed-paste` | 3 files, 73 passed, 5.93s |
| `tui-visible` + `tui-settings` | 2 files, 15 passed |
| `tui` + `tui-frame` + `tui-status` + `tui-settings-ui` + `input-buffer` + `bracketed-paste-mode` + `scoped-approval` + `child-grants-ui` + `prompt-history-startup` | 9 files, 189 passed |
| `nightly-structure` + `acceptance-plan` | 8 passed, 1 skipped |

No failures; no test in the approval, paste, menu, history or frame suites regressed.

## Static review against scope

- **Retained-text exactness** — `packages/cli/src/tui/graphemes.ts:6-7` returns `text.slice(0, last.index)`. Pure prefix slice: no normalization, no re-encode, no CRLF rewrite. ✅
- **Whole final grapheme** — `segment(text).containing(text.length - 1)` resolves the cluster owning the last code unit and drops from its start; no array copy of the buffer, matching the plan's constraint. `!` is sound: for non-empty `text`, `length - 1` is always in range, so `containing` cannot return `undefined`. Empty-string guard is present. ✅
- **Node 22+ / Intl** — repo `engines: >=22` (root and `packages/cli`), `lib: ["ES2022"]` in `tsconfig.base.json`, which supplies `lib.es2022.intl` `Segmenter`/`Segments.containing` types. Node ships full ICU, and `new Intl.Segmenter(undefined, …)` at module scope cannot throw on a bad `LANG` (only explicit malformed tags do), so the import-time construction is not a CLI startup hazard. Grapheme granularity is locale-independent, so the `undefined` locale is correct rather than sloppy. ✅
- **Two sites only** — `app.tsx:158` (composer) and `app.tsx:188` (unconfirmed scope). `grep` for `slice(0, -1)` leaves only unrelated hits; the remaining one in `app.tsx:166` is the explicit trailing-backslash newline path, correctly left literal per the plan. ✅
- **No paste regression** — pasted segments bypass the action path entirely (`app.tsx:216` `buf.set(buf.value + segment.text)`), so `\u007f` inside a frame stays literal; the replay path (`ordinaryInputActions`, `input-buffer.ts:65`) is the only route to the helper, and both suites are parameterized over `["", "\u001b[201~"]` to cover ordinary and post-marker replay. ✅
- **No permission/menu regression** — the preview branch still takes precedence over backspace at `app.tsx:183-188`, so backspace only edits an *unconfirmed* scope; policy and grants untouched, and the test asserts `permissionGrants.list()` stays `[]` and the answer is still `deny`. `edit()` (`app.tsx:134`) keeps the same `slashActive`/`slashIndex`/`recall` reset, so suggestion redraw is unchanged. ✅
- **Protected answers** — backspace remains ungated by `protectedInput`, exactly as before the change; question and supervisor paths share the composer and are asserted (`answer: kept`, and negatively `not.toContain("🇮")`). ✅
- **Tests actually discriminate** — I confirmed statically that each new mounted case fails on the old code: `"kept0😀"` → `"kept0\ud83d"`, `"kept👩🏽‍💻"` → `"kept👩🏽‍"`, and the scope case leaves a dangling surrogate instead of `original`. The author's "fails on the original" claim is consistent with the assertions; I did not re-run against reverted source (no edits permitted). Unit row `["kept\r\n","kept"]` passing is live evidence that CRLF is treated as one cluster.

## One minor finding — roadmap END, not a gate

`InputBuffer.set` (`packages/cli/src/tui/input-buffer.ts:215-219`) treats a change of ≤ 4 code units as a keystroke that leaves the draw deadline alone. Deleting a ZWJ cluster now moves 7 units (`👩🏽‍💻`) or 11 (`👨‍👩‍👧‍👦`) instead of 1, so it exceeds `KEYSTROKE` and reschedules the 32 ms quiet timer. Held backspace (auto-repeat 15–30 ms) across a run of ZWJ emoji therefore re-arms the timer faster than it fires and the prompt stays frozen until release — precisely the symptom the `KEYSTROKE` comment at `input-buffer.ts:33-42` was added to fix.

Bounded, and deliberately not a blocker: it needs ≥5-code-unit clusters (flags at 4 units and combining accents at 2 stay under the threshold), it only ever *delays* a draw — the safe direction for the deadlock invariant, and `value` never lags — and the identical asymmetry already exists on the append side (`app.tsx:159`, where typing/replaying a multi-unit character has always exceeded 4). Fix, if ever taken, belongs at the ROADMAP END entry: measure the delta in graphemes rather than code units, or raise `KEYSTROKE` to cover one cluster. No new nested gate.

## Observation, no action
The `removeLastGrapheme` unit table lives in `prompt-history.test.ts:9-13` rather than beside the new module. Harmless cohabitation, and it does carry the required empty/ASCII/newline/lone-surrogate controls; flagging only so it is a choice rather than an accident. `docs/plans/R16d.md:127` still lists grapheme editing as an END note, which is correct for a frozen historical plan — the live ROADMAP END entry was updated in place at `docs/ROADMAP.md:1374`.

## Author disposition

No material findings. The repeat-key redraw latency observation is recorded at
roadmap END; logical buffer contents and paste-safe quiet-point guarantees remain
unchanged. No timeout increase, broadened paste heuristic or new nested gate.
Author build/typecheck, required real Docker full3,288 passed plus two existing
skips/209files92.56s, and real Chromium1passed2.97s are separate evidence.

