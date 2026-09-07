# R16h independent review

Frozen commit: `1cea9f8bbff0fce2fd7a707fd69677c097ef8a97` against `8fe6f29580fff065fd52ebe9ae1f169ca8b93580`.
One substantive review, requested24/reported25 turns, exhausted without a verdict;
sole same-session tools-disabled summary requested1/reported1. Total26 reported
turns, session `b25fe5c0-9bae-4f35-bc69-6752408c96b0`. Metadata list-price values
$1.605357 + $0.752710 are not a subscription invoice. Static APPROVE; reviewer
ran no successful tests/build/typecheck. Author validation is separate.

## Verbatim reviewer result

## Verdict: APPROVE (static inspection only — no tests executed)

### What I actually ran
**No tests, no build, no typecheck.** `npm run -s typecheck` and `npx vitest run packages/cli/test/tui-settings.test.ts` were both denied by the permission mode, so every statement below is static reading of the commit's source, its three new test files, and the installed `ink@5.2.1` source. The commit's own evidence claims (66-test group pass, the wiring fail-before/restore control) are **unverified by me**.

### Contract areas checked, and why they hold on inspection

- **Strict config before provider construction** — `TuiSettingsSchema` is `.strict()` at both levels with `letter`/`historyKey`/`z.literal("ctrl-g")` bounds (`settings.ts:11-25`). `startTui` parses at `start.tsx:54`, ahead of `buildAgent` at `start.tsx:102` and ahead of `render`, so an invalid table cannot reach a provider or a mount. Config-file path is covered independently by `ConfigValuesSchema.tui` (`config.ts:96`), which fails inside `loadRunConfig` — earlier still. `safeIssueMessage`/`issueField` keep rejected values out of the message (`config.ts:189-198`), matching the no-echo test.
- **Immutable startup capture** — zod object parse returns fresh nested objects, so the captured `settings` does not alias `opts.tui`; `resolveTuiSettings` re-freezes palette and keybindings (`settings.ts:31-40`). The `afterBuild` mutation control in `tui-settings-startup.test.ts:61` is the right shape for this.
- **Whole-object precedence** — `resolveConfig` spreads layer objects (`config.ts:267-276`), so `tui` replaces wholesale; no keymap deep-merge was introduced.
- **Permission remapping / scope identity / paste guards** — `pressed` is derived only from `/^[a-zA-Z]$/` on an `append` action and lowercased (`app.tsx:158`), so Unicode casefold lookalikes cannot answer. Scope confirmation still requires `pending.scope === previewAtInput` (`app.tsx:163`), preserving the same-chunk refusal. Escape remains hard-wired deny/cancel (`app.tsx:161`, `app.tsx:175`). Pasted segments are appended as text and never dispatched (`app.tsx:191-194`); the new control-byte intercept sits after the `decoded.protocol` early return, so paste bytes are untouched.
- **Ordinary and protocol paths share one keymap** — both funnel through `dispatchAction` → `mapTuiAction` (`app.tsx:177-184`, `app.tsx:199`, `app.tsx:217`, `app.tsx:243`). `ordinaryInputActions` already yields `{type:"interrupt"}` for `\u0003`, and `mapTuiAction` passes `interrupt`/`escape` through unchanged, so Ctrl+C and Escape are not rebindable. I confirmed in `ink/build/hooks/use-input.js:45-89` that `useInput` fires for *every* stdin `input` event, so `useRawInput`'s chunk queue stays in sync and `\u0010`/`\u000e`/`\u0007` do reach the handler as exact raw chunks rather than being filtered by Ink.
- **Protected input** — history actions reaching the composer are still gated by `protectedInput` (`app.tsx:120-123`), and permission mode ignores `up`/`down` entirely, so question/supervisor prompts keep their behaviour.
- **NO_COLOR** — `plain` is latched once at mount (`app.tsx:43`); the local `Text` wrapper drops every style prop and strips SGR from string children (`app.tsx:23-35`). `renderMarkdown` is called with `!plain` and returns a string, and `file-diff.ts:57` already gates on `NO_COLOR`, so both the markdown and captured-diff routes are covered without touching chalk or `process.env`. `Static` is inside the provider, so scrollback lines are stripped too; `Static`, `fitToRows`/`liveRows` and the width/height bounds are unchanged.

### Non-material notes (no fix required for approval)

1. **`packages/cli/src/tui/controller.ts:497`** — indentation regression: the reworded `this.print(...)` sits at 10 spaces inside a block indented to 12. Cosmetic only; fix by restoring two spaces.
2. **`packages/cli/src/tui/app.tsx:217`** — a bare `\u0007` chunk is treated as ctrl-g. If a terminal ever delivered a BEL-terminated OSC *reply* split such that BEL arrived alone, that would read as an abort — but only for users who opted into `abort: "ctrl-g"`, and this TUI issues no OSC queries (docs explicitly rule out background detection). Not worth code today; noting it only because it is the one input assumption that is environment-dependent.
3. **`packages/cli/src/tui/settings.ts:22`** — the collision check hard-codes `!== 6` against `permissionDefaults`' size. Correct now; `Object.keys(permissionDefaults).length` would keep it correct if a seventh action is ever added.
4. `startTui` throws a raw `ZodError` for a direct invalid `tui` (asserted by `tui-settings-startup.test.ts:75`) rather than the friendly-message/exit-code path used elsewhere. Unreachable from the CLI, since there is no `--tui` flag and the config path fails earlier with the sanitised message.

### Inspection limits
- Nothing was executed: no typecheck, no build, no vitest, no Chromium, no Docker suite. In particular the fresh-process light/dark assertions in `tui-settings-ui.test.ts:79-101` import from `packages/cli/dist/`, so they require a prior build; whether that build is green here is unverified by me.
- I did not evaluate the R16g `!controller.isIdle()` Ctrl+C predicate at `app.tsx:180`, per your instruction that it is already tracked for integration.

## Author disposition

No material findings. Cosmetic indentation corrected. Optional input/environment,
future key-count and direct-call diagnostic polish recorded at roadmap END, not
new delivery gates. The already tracked R16g idle-ownership integration remains
required before final R16h delivery. No second broad review.

