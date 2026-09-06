# R15e independent review receipt

Frozen snapshot: `3fa85e4abc068cb96fa643cfb8dc2b97d9d72b12`.
Session: `2f2c6c57-6301-4733-965c-8963d9bdc551`.
One process, no restart; requested/reported24 turns,499.122s including an external
Claude security-hook delay. No tracked edits during review. Independent typecheck,
20 focused tests and full2751+2/160files passed; no independent build claim.
The complete final reviewer response follows verbatim. Material fixes and the
separate author-found unanswered-prompt timeout are recorded in R15e.md; no second
review was performed.

---

Review complete. Verdict below.

**Verdict: REQUEST_CHANGES** on one narrow, material contract gap. Everything else I checked holds, and the fix is a one-line regex plus a test.

**Independent evidence on frozen snapshot `3fa85e4`** (worktree clean, no tracked file edited, no agents, no live providers, no build):

```
pnpm typecheck                                                        # all 4 packages pass
pnpm exec vitest run packages/supervisor/test/diff-review.test.ts \
  packages/cli/test/review.test.ts packages/cli/test/tui-visible.test.ts --maxWorkers=4
                                                                      # 3 files, 20 passed, 1.79s
pnpm exec vitest run --maxWorkers=4                                   # 160 files, 2751 passed, 2 skipped, 47.56s
```

The full run matches the author's final figure. Dist was author-built, so I make no independent build claim.

**Material finding**

- **Added or deleted submodule gitlinks pass the text-patch gate.** The plan states "changed gitlinks refuse as unsupported", but only the modified form is caught. `packages/supervisor/src/diff-review.ts:73` refuses `index … 160000`, while line 74 accepts any `new file mode \d+` / `deleted file mode \d+`. I confirmed with real Git in a temp repo that adding a gitlink via `update-index --cacheinfo 160000,…` and committing produces `new file mode 160000` followed by an `index 0000000..1234567` line with no mode, and the built dist parser accepts it and returns a location at `sub:1`. Deletion behaves the same on the old side. No execution risk, but the model receives a `Subproject commit` line as reviewable text and the stated refusal does not hold. Fix: refuse `new file mode 160000` and `deleted file mode 160000` at line 74, and extend the negative case list in `packages/supervisor/test/diff-review.test.ts:25` with both forms.

**Verified as claimed**

- **Reviewer reuse.** `TrajectoryReviewer.reviewDiff` uses the existing `AuxiliaryRun` with `maxCalls: 1`, empty tools, 2048-token request cap, 32 KiB output, 4096 events, 30 s call / 90 s total, `requireEndTurn`. No fabricated trajectory. Malformed JSON, invented line, foreign path, extra field, and 17 findings all reject rather than produce a clean verdict.
- **Nonexecution.** Fixed argv, no shell, hooks path nulled, fsmonitor off, `--no-ext-diff --no-textconv --no-renames`, all `GIT_*` env stripped except four safe keys, global and system config disabled. Explicit `--src-prefix/--dst-prefix/--unified` beat hostile local `diff.noprefix`, `diff.relative` and `core.quotePath`, which I confirmed by running the exact argv against a repo with those settings. Quoted paths, blank-empty context, binary, mode-only and rename headers all refuse. The filter preflight runs before any diff and rejects `filter.*` names.
- **Pre-provider refusals.** Total-session `maxTokens`/`maxUsd` throw a `ReviewRefusal` before policy, git, gh or provider construction in CLI. In the TUI the supervisor provider already exists at startup, so the refusal is before the provider call, not construction. The plan wording slightly overstates this.
- **PR identity and authorization.** Every gh call requires separate exec and net decisions; headless `ask` denies. Metadata is strict-parsed, the number is echoed back, the repo is bound from the URL and reused for diff and comment, and identity is rechecked after the model call and again before posting. Comment uses exactly `gh pr comment <n> --repo <owner/repo> --body-file -` with the rendered review on stdin, and refuses on missing `--pr`, incomplete usage, non-completed outcome or changed identity.
- **TUI lifecycle.** `/review` is reserved, refuses when a session, dream, undo, prompt or escalation is active, blocks all other commands except abort/quit/help/permissions while running, joins on abort and shutdown, and never touches a session or emits events. Ctrl-C aborts a running review. The Ink frame test shows activity and results.

**Optional polish, not blocking**

- Missing spaces in user-facing text: "at most2048", "at most1.5", "over16KiB,40files,128hunks" in `program.ts` help, and "at most16 findings", "at most2000" in the reviewer system prompt.
- `reviewFailure` collapses argument errors and permission denials into one generic line, so a user who forgot `--allow net` or typed `--comment` without `--pr` cannot see why. Making those validation errors `ReviewRefusal` would keep subprocess text hidden while restoring usability.
- Plan and STATUS could say "before any provider call" for the TUI path.

