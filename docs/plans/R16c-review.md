# R16c independent review — verbatim

Frozen `eb92b6b` against `749ff26`; session
`632d37a9-58e0-4fe5-af2e-2c12b7f3b7ea`. One read-only process,
24 requested / 24 reported turns, 299.060 seconds, no restart. Source remained
unchanged. Original findings and their line references are preserved below.

**Verdict: APPROVE** for R16c at HEAD eb92b6b against base 749ff26. No material findings. Two optional polish notes below, neither blocking.

**Exact checks run** (worktree stayed clean, no git writes):

| Check | Result |
|---|---|
| `pnpm build` and `pnpm typecheck` | pass |
| `vitest run` tool-summaries, tui, thinking test files | 103 passed |
| Full suite, `--maxWorkers=4`, local Docker image IDs, `AGENTRIG_EVAL_REQUIRE_DOCKER=1` | 181 files, 2919 passed, 2 skipped, exit 0 |
| Ad-hoc probes against built dist | see below |

**Scope and boundary.** The diff touches only the CLI: a new `packages/cli/src/tui/tool-summaries.ts`, small hooks in `controller.ts`, one command summary string, tests, CI step, docs. No core, schema, permission, log or provider change. The fold reads events and returns display lines only.

**Read eligibility uses runtime permission and exact identity.** Collapse requires a `read_file` call with a literal string path, no `internal`, result with `permission === "read"`, `ok`, no diagnostics, valid non-negative integer `durationMs`, and a single pending match on session, id and `toolCallSeq` equal to the call's seq (`tool-summaries.ts:268-272`). Probes confirmed: exec-class, missing `toolCallSeq`, negative duration, failed, diagnostic, internal-tool and duplicate-id results all render as individual or "unmatched" lines, never as a read run. A never-seen call id yields "? unmatched tool · 3ms · unmatched result", which is truthful rather than invented success.

**Grant-visibility regression fix verified.** Only `permission.decision` allow receipts with source `rule` or `fallback` are hidden (`tool-summaries.ts:247`). I probed `approval-handler`, `unattended`, `boundary`, `unknown` and `grant` sources: all return `handled: false`, flush the read run, and fall through to the existing `permission ...` explanation line. Deny and ask decisions, `tool.denied`, `error`, `question.asked`, `tool.result.patched`, `file.changed` and thinking message appends all flush. The App test asserts unchanged grant counts and unchanged stored events. Existing tui tests only swapped the call glyph for the completion glyph with identical counts.

**Bounds and sanitization.** Pending 128 with explicit "pending display cap" markers, read runs of 64, 160-char compact lines, raw retention 128 lines / 64 KiB / 2048 per line with an elision count, oversized ids refuse correlation. Summary lines and the expanded raw projection pass through `sanitizeLine`; probe confirmed ESC and RLO are stripped from expansion output.

**Static append-only and R15c.** `/verbose` on appends retained raw lines then switches renderer; off replaces the fold and affects future events only. The App test at 80/120 columns checks the earlier prefix is byte-identical and no clear-screen sequence is written. In verbose mode `push` is bypassed entirely, so thinking rendering is unchanged; the thinking test file passes.

**Optional polish, not required for merge:**

- `tool-summaries.ts:280` re-emits the pre-existing `renderChatEvent` failure detail line without `safe()`. The probe showed a failed result's display text reaches Static with raw ESC and RLO intact. This is identical to base behaviour for compact mode, so it is not a regression, but wrapping that one line in `safe(detail, TOOL_SUMMARY_LIMITS.rawLine)` would make the doc's sanitization claim cover it.
- Toggling `/verbose` off mid-turn discards pending correlations, so results for calls issued during verbose render as "unmatched result". Truthful, but a one-line note in `TOOL-SUMMARIES.md` would set expectations.
