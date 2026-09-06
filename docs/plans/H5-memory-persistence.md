# H5 remaining persistence

Starts from updated main ba4569c after PR #129 and post-merge CI 33970638299 passed.
This closes existing H5 scope; it does not introduce another milestone hierarchy.

Acceptance:

- Preserve unknown frontmatter through read/modify/write and dream regeneration, including
  opaque human-authored blocks. Do not flatten nested metadata into schema fields.
- Understand legacy multiline facts and their references without partial destructive removal.
- Bound session-scoped attempt lookup independently of unrelated history, with a bounded,
  explicit cache rebuild path and immutable raw records.
- Migrate the CLI supervisor's unbounded ledger caller.
- Record existing deterministic staged-target preservation and child-abort evidence; distinguish
  the repaired fixture-readiness timeout from any reproduced runtime defect.

Gate: focused regressions/negative cases, build/typecheck/full Node22 suite, independent Claude
review, exact-head PR CI, merge and exact post-merge main CI. Nonblocking polish belongs only at
the END of ROADMAP, not in new prerequisite rows.

## Implemented contract and limits

`WikiPage.extraFrontmatter` retains unknown frontmatter as opaque lines, not a YAML object.
Read/modify/write preserves it when omitted by a transform; an explicit empty string clears it.
The trusted unconditional `write()` still replaces the page. Pass the read page or its metadata
when using it. Dream keeps metadata-bearing merge sources because automatic cross-page metadata
precedence is undefined. Continuation text and references remain intact; removals must match the
whole tagged fact. Blank lines, headings and new list items delimit facts; this is not a general
Markdown parser. Adjacent prose without a blank separator is a lazy continuation; quoting just
its first line is deliberately insufficient for deletion. Fenced examples and reservation
bookkeeping do not count as evidence. Legacy indented known keys remain accepted unless nested
under an opaque unknown key.

Named-session attempt reads use `.agentrig/attempt-index.json`, outside immutable `raw/`.
Append and index operations share `attempt-index.write.lock`. The index is a disposable local
cache, not authenticated evidence. Cooperating appends invalidate it; directory identity/change
stamps detect ordinary legacy additions. In-place external rewrites violate raw immutability:
stop writers and explicitly rebuild after any such repair, rather than trusting directory stamps.
The first lookup or invalid cache triggers a separate bounded rebuild (10,000 directory entries,
64 KiB per raw record, 64 MiB total); it never raises the requested session query budget. Cached
index reads/writes have an 8 MiB cap. New attempts must fit 64 KiB before an immutable ID is
claimed. Oversized legacy records are reported as unreadable during rebuild rather than disabling
unrelated session lookups; failed bounded reads are charged conservatively to the aggregate cap.
Entry/aggregate limits still stop the rebuild visibly, not as empty history. For larger legacy
ledgers, call `raw.rebuildAttemptIndex({ signal, maxEntries, maxFileBytes, maxTotalBytes })` with
deliberate operator-selected limits; the index's 8 MiB cap remains. No raw file is rewritten.
Corrupt entries whose session cannot be established remain reported on every scoped lookup.
The supervisor warns that it is reviewing only readable attempts, then continues; ingest retains
its existing corrupt-entry diagnostic. Neither silently claims a complete ledger. Dream's existing
full-scan limit and incomplete-evidence refusal of automatic apply are unchanged.
Unscoped SDK compatibility reads remain available; dream already supplies explicit full-scan caps.

CLI supervisor lookup now receives the reviewed session ID and a timeout signal, with 128-entry,
64 KiB-file and 2 MiB-total query caps. Full session-end/detach cancellation of reviewer/grader
work remains H5d; this persistence change does not claim to close that lifecycle contract.

## Target/child-abort closure

`packages/core/test/sandbox-effects.test.ts` retains ten repetitions of the production staged
write program through a controlled transport: readiness is signaled after FIFO creation, the
shell parks, abort rejects, and the original target bytes remain. This is transport/target proof,
not live OS isolation. `background-jobs.test.ts` checks aborted jobs settle and completed sessions
reap their actual child PID. The historical macOS timeout was repaired by the H5a fixture barrier;
no separate production cancellation defect was reproduced. Keep these assertions in full CI.
