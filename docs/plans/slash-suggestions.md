# Automatic slash suggestions

User-observed gap: R16d only completed on Tab and exposed eight names, so typing
`/` offered no skill discovery despite the broader roadmap wording. This is a
bounded correction, not a new milestone hierarchy.

Show a live filtered catalogue on an ordinary initial slash token. Loaded skills
come first and are labelled separately from built-ins; use the existing validated
256-name catalogue and reserved-name collision rules. Arrow navigation reaches
all matches through a bounded window; Tab fills the selected name without running
it. Enter keeps explicit typed-command submission. Entering arguments or deleting
the slash closes suggestions; outside suggestions, history keeps its behavior.
Escape retains the existing split-terminal-sequence/quiet-point handling rather
than introducing a timeout that could reinterpret pasted bytes as commands.
Framed pasted payloads and permission/question/supervisor prompts do not open or
act on the menu. No discovery I/O or provider call is triggered by presentation.

Suggestions share the existing composer row budget, and their instructions occupy
the existing single status row. Preserve Static scrollback, narrow-terminal bounds,
NO_COLOR and startup catalogue wiring. Tests must use actual mounted Ink without
Tab for initial discovery, beyond-eight navigation, filtering and safe completion;
both ordinary and protocol input, paste/protected-input negatives and bounded frames.
One bounded Claude review, build/typecheck, real pinned-Docker full suite, Chromium,
exact-head and post-main green CI before delivery.

## Author evidence

Five new actual-Ink cases failed on the original implementation: ordinary and
protocol automatic discovery/navigation, filtering, and pasted/protected input.
After implementation the focused composer/startup group passes34 tests, including
six bounded-frame configurations (80/120 columns,8/12/24 rows), no Static replay
and no output while input remains unread. Question and supervisor answers stay
literal and outside history. Enter still dispatches the typed command, not the
highlighted suggestion; Tab is filling only.

Real startup discovers a temporary on-disk skill using the actual builder and
mounts actual Ink. Replacing only `controller.setSkills(built.skills)` with an
empty catalogue fails both startup cases; restoring the exact wiring passes.
Neither startup case invokes a provider or fetch. Reproduce with
`pnpm exec vitest run packages/cli/test/prompt-history-startup.test.ts -t 'real startup discovers'`.

Initial author test corrections: Ink trims trailing displayed whitespace (now
verified by appending an argument); permission notices precede the pending prompt
(assert the final protected frame, not its earlier unprotected notice frames);
configured skill directories are an array. Escape remains constrained by split
terminal framing, not a new timing-based decoder. A fresh-worktree typecheck
required the normal build first; no dependency or runtime fix was inferred.

Frozen8041f81 full required digest-pinned Docker:3,257 passed plus two existing
skips /209 files,82.80s; real Chromium one passed,2.49s. The [single review](slash-suggestions-review.md)
returned approval with unreachable-code removal and two notes, static only,
26 reported turns including the sole summary. Removed that branch; the clock
note was reproduced as two failing actual-Ink cases and fixed with an explicit
quiet-point render revision. Tiny-terminal fallback and deferred Escape behavior
are labelled honestly. Final post-fix validation and hosted receipts follow.
