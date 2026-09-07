# Original bounded independent review

Frozen HEAD `51be32b`, base `31193d6`. Claude session
`55ee46f2-a150-413c-a3e1-f97d644e90aa`; 24 requested / 25 reported turns.
The original final response follows verbatim. Findings are closed separately in
R16d.md; no second general review.

**Verdict: APPROVE WITH FIXES.** One required fix is documentation, not code. No reproducible correctness or security regression found in the composer, history store, or input paths.

**Tests actually run**

| Check | Result |
|---|---|
| `prompt-history.test.ts`, `prompt-composer.test.ts`, `prompt-history-startup.test.ts`, `input-buffer.test.ts` | 4 files, 32 tests, all pass |
| `pnpm typecheck` | all 4 packages pass |
| `git status` | clean at 51be32b |

**Required fix**

- **`docs/STATUS.md` has no R16d entry.** The diff touches PLAN.md and README but not STATUS.md, and a search for "R16d" in STATUS.md returns nothing. CLAUDE.md's definition of done requires the STATUS update. Add the row before merge.

**Verified positive (no findings)**

- **Both input paths route through one `composerAction`** at `packages/cli/src/tui/app.tsx:107`. The Ink path uses `key.upArrow/downArrow/tab/shift`, which Ink 5.2.1 does populate (use-input.js:57-58). The marker-adjacent replay path decodes the same arrow and CSI-u sequences in `input-buffer.ts:61`. Tests exercise both with and without a `201~` prefix.
- **Protected input is excluded** from recall, completion, newline and history at `app.tsx:109`. Question and escalation answers bypass `remember`. The test at `prompt-composer.test.ts:65` confirms canaries never reach history or the provider on either path.
- **Persistence is trust-gated and TUI-only.** `PromptHistory.load` is called only from `start.tsx:181` with `trustedProjectRoot`, which `config.ts:368` sets only when trust is established. No other controller references the class. The restart test proves untrusted runs never create the file.
- **Filesystem lifecycle is bounded.** Load resolves the real root, refuses a symlinked `.agentrig`, refuses non-regular, hard-linked, oversized or malformed history without overwriting, and never chmods an existing file. Writes go through `withMemoryLock` with a 500 ms window, no stale-lock stealing, a `wx` 0600 temp file, same-directory rename, and cleanup in `finally`. Release failure disables persistence via `onReleaseError`. `close()` joins the in-flight flush and the loop drains the pending batch. Lock, oversize, malformed, symlink and concurrent-writer cases are all tested.
- **Ingest exclusion is real.** `prompt-history.test.ts:85` runs the actual `ingestSession` with a history-only canary and checks provider input and wiki pages.

**Hypotheses and optional polish, none reproduced as bugs**

- **Code-unit iteration** at `input-buffer.ts:60-63` replaced code-point iteration. An astral character in a marker-adjacent segment becomes two lone-surrogate appends. The final buffer is correct, and backspace was already per-code-unit on the Ink path, so this is not a regression.
- **CSI-u Shift-Enter on the Ink path** at `app.tsx:205` matches only when the sequence arrives as its own chunk. If glued with trailing bytes, Ink strips the ESC and the remainder would be inserted as text. Terminals normally deliver key sequences alone. Unverified, and consistent with pre-existing handling of unknown sequences.
- **Completion hint persistence** at `app.tsx:323`: the hint is a ref and replaces the status line until the next edit or submit, even across controller updates. Cosmetic.
- **Load does not apply `bounded()`** at `prompt-history.ts:36`, so a hand-edited file with blank or consecutive duplicate entries is recalled as-is until the next write. Harmless.
- **Enter is silently ignored** in `composerAction` if a prompt or question appeared earlier in the same chunk's action loop, and the buffer is retained for the next Enter. Same race shape as before the change. Not a regression.

**Checks not performed**

- `pnpm build`, the full test suite, Docker, and macOS or Windows runs.
- Manual testing in a live terminal for Shift-Enter and paste behaviour.
- One shell command to inspect Ink internals was denied by the sandbox. I read the same file with the search tool instead, so nothing was lost.
