# TUI tool summaries

The default TUI shows a completed tool as one logical line: outcome glyph, tool,
bounded key argument, observed elapsed and outcome. Running tools still appear in
the existing activity line. Elapsed comes from `tool.result.durationMs`; invalid
or unmatched observations do not become guessed successful execution. Missing
results at a boundary are marked incomplete.

Consecutive successful, runtime-correlated `read_file` results with permission
class `read` collapse to, for example:

```text
✓ read 5 files · 5 requests, repeats counted · 14ms summed
```

This counts completed read requests, not unique filesystem identities or proof of
semantic success. The elapsed sum is not wall-clock duration for parallel calls.
A tool name alone is insufficient: unknown/legacy permission or call-sequence
metadata remains uncollapsed. Other read tools get individual summaries.
Errors, denials, questions, permission asks, diagnostics and post-tool patches
remain visible and break read runs. The display never changes execution, grants,
provenance, model history, memory ingestion or immutable session logs.
Matched-grant, explicit approval-handler and boundary decision explanations remain
visible. Only ordinary rule/fallback allow receipts are hidden in compact mode.

`/verbose` appends retained tool details and then shows future raw event lines.
It does not erase or redraw earlier Static scrollback. Turning it off affects
future events only; toggling again does not duplicate already expanded details.
R15c thinking stays collapsed by default and reveals disclosed text in verbose
mode; opaque reasoning signatures are not surfaced by this feature.

Recent expansion is bounded: at most 128 lines / 64 KiB, 2,048 characters per
line. Tool inputs are a labelled bounded projection (eight top-level keys,
256 characters per string, nested values explicitly omitted); full events remain
in the session log. Elided older lines are counted explicitly. Display controls
and bidi/invisible formatting are removed, not interpreted as terminal commands.

There are at most 128 pending display correlations and 64 reads per compact run.
Overflow flushes with an explicit incomplete marker or starts a new read run.
Oversized identities refuse correlation (256-character tool ID, 128-character
session ID); no truncated identity is used to match results. Compact lines are
at most 160 characters. The existing viewport owns terminal wrapping; these are
logical lines, not a promise that every long argument fits one physical row.

This is TUI presentation only. Headless `run`, `sessions show`, stored JSONL,
exports, permissions and provider requests are unchanged.
