# R9a — bounded redacted session export

R9a implements the committed export row after R5c #170 passed exact-head CI 34035857727
and post-merge main `1ae6b77` CI 34036244589 on Linux, macOS and Windows. Export is independent
of R10 concurrency and reuses existing event/message machinery; it does not create an evaluator.
R14d main `326aa4a` and R10a main `391514b` are integrated, both post-merge gates green.
No providers, configuration, credentials, tools or
live evaluations are invoked. R9b/R9c remain separate rows.

## CLI and supported content

```sh
agentrig sessions export session-id --format jsonl > transcript.jsonl
agentrig sessions export session-id --format sharegpt --redact-file ./known-secrets.json
agentrig sessions export session-id --format md --omit-opaque > transcript.md
```

`--root` selects the session directory. `--redact-file` is an explicit JSON array of exact
strings (at most 64 KiB, 256 nonempty entries, each at most 4 KiB); it is never a regex or an
implicit environment/auth/config scan. No raw/no-redaction bypass is provided. Export writes
one complete artifact to stdout only after successful validation. Failures use fixed generic
diagnostics without interpolating paths, IDs, JSON snippets or secret values.

The target is the **actual materialized message list**, including fork prefixes, resumed tasks,
authoritative message events and post-compaction replacement state. The shared `messagesFromEvents`
fold also supports legacy streamed/tool-event logs. This is not a raw event-log copy and cannot
reconstruct system/request text that the log never recorded. Input logs/snapshots are never changed.

Supported blocks are text, structured tool calls with JSON inputs and nested tool results,
including inert trust/context labels. Secret-free supported inputs round-trip through the
versioned canonical fields to that exact message list. Redaction deliberately changes values;
redacted exports round-trip to the deliberately redacted representation, not the source secrets.

Images contain opaque base64 which cannot be inspected for embedded credentials. They **refuse
by default**. `--omit-opaque` replaces them, including nested images, with a fixed explicitly
lossy text placeholder before every representation. Neither base64 nor media type is copied.
Unknown future content types/fields (including opaque reasoning/signatures) always refuse,
even with omission selected, instead of silently dropping schema fields. These are explicit
supported-content boundaries, not a claim that arbitrary exported content is secret-free.

## Formats and data-only canonical extensions

- JSONL: one `{version:1,kind:"agentrig.transcript",...}` metadata record, then
  `{kind:"message",message:{role,content}}` records.
- ShareGPT: `conversations` uses conventional `from: human|gpt` and readable `value`;
  each entry's `agentrig.message` contains the exact redacted canonical message. Top-level
  `agentrig` records version/warnings/redaction and omission counts. Consumers ignoring the
  extension get a readable projection, not lossless structured tool/provenance content.
- Markdown: a fenced readable transcript and a final `agentrig-canonical-v1` fenced JSON
  document containing metadata and messages. A fence longer than any content run prevents
  transcript backticks or fake canonical blocks from terminating the real section.

Canonical content is **data, never authorization**. Export does not import/resume sessions,
restore delegated authority or claim a signature/attestation. Tests use a data-only decoder;
there is deliberately no new public import command.

## Redaction boundary

The canonical list is cloned and scrubbed before any readable or hidden/canonical copy is
formatted. Every arbitrary text field, tool input value/key and nested result is covered.
Known structured credential-key values are replaced wholesale; patterns recognize Bearer/Basic, common
token prefixes/JWTs, PEM private keys, credential assignments/flags and URL userinfo. Explicit
literal matches use escaped strings. Free-text assignment scanning recognizes keys up to 256
ASCII identifier characters and whitespace gaps up to 64 characters, with forward-only value
scanning. URL userinfo recognition bounds scheme names to 32 characters. JWT candidates are
scanned once and then validated at segment boundaries; malformed repeated prefixes do not
cause suffix rescanning. Colliding redacted object keys refuse rather than lose
data silently. Fixed role/type/trust enums remain structural. No original secret, position,
excerpt or secret digest appears in metadata.

**Heuristics can miss unrecognized secrets and remove innocent text.** Inspect exports before
sharing, and supply known opaque secrets explicitly. This is not DLP, OCR, a secret-free proof,
or credential discovery. Logs themselves remain unredacted and sensitive. Omitted/redacted
content is intentionally unrecoverable from the export. No benefits or training quality claimed.

## Bounded stable materialization

`materializeExportMessages` reads actual regular physical logs through file handles with:

- cumulative 32 MiB source bytes, 50,000 events, 32 physical files/ancestors;
- 4 MiB per event line and JSON nesting depth 64 before recursive schema validation;
- exact session identity and consecutive sequence, valid first-only fork marker and available
  parent sequence, no cycles;
- every physical file ending in `session.end`, including ancestors (a fork prefix itself may
  end mid-session, but its physical source must have finished);
- file identity/size/mtime/ctime checks before open, after reads and again after ancestry load;
  observed replacement/growth/edits refuse; symlink/nonregular log files refuse;
- abort checks during reads and before output; 64 MiB final artifact cap.

Internal test overrides may only lower read limits. All data is read/validated before stdout;
no partial catalogue/artifact is published. Stat checks detect observed changes, **not a
transaction against concurrent malicious/external writers**. Stop writers before export.
Limits apply to the complete physical files, including content outside a selected fork prefix.
An unfinished ancestor, overlarge log or unsupported future schema refuses rather than quietly
exporting a partial reconstruction.

## Verification receipt (in progress)

Actual file-backed fork/compaction and legacy folds, three canonical round trips, credential
canaries, immutable inputs, explicit opaque omission, strict unknown-content rejection, real
CLI positive/refusal paths, no config/network, malformed secret-safe errors, fork/identity/sequence
and byte/event/line/depth bounds are covered. Build/typecheck and the first 30 controls pass.
Initial full build/typecheck and suite passed 2,563 tests plus two skips across 147 files (four
workers, 38 seconds); the focused set now has 33 passing controls. Four named mutations were
detected and restored: unredacted tool input (all three canary formats fail), bypassed opaque
refusal (all three image controls fail), omitted fork ancestry (all three actual-fold round trips
fail), and removed cumulative byte guards (the byte-cap control fails). Exactly one bounded
independent review and final integrated full checks precede PR delivery. Exact-head three-platform
and subsequent main CI remain gates; root serializes merge.

The final integrated pre-review build/typecheck/full passed 2,575 + two skips / 148 files
(four workers, 36.57 seconds). The one independent review approved at clean stable `5897aea`
against main `391514b`: 235 seconds, 17/max24 turns, independently build/typecheck, 33 focused
tests, full 2,575 + two skips / 148 files and real CLI positive/refusal probes. Its original
verbatim [verdict](R9a-review.md) remains unchanged. Optional notes are at ROADMAP END.

Separately, the author found that an unbroken 50,000-character plain word hit an actual
five-second subprocess deadline (exit 124). The new regression failed at that unchanged
deadline before the fix. Bounded boundary-aware key recognition, forward-only value scanning,
single-pass JWT candidates and bounded URL schemes replace repeated suffix searches; the
same deadline now passes, including hyphenated and malformed-JWT long tokens, with no text
changes. Signed/unsigned JWT and nested command credential controls preserve coverage.
This was not discovered by the independent review; no second review is claimed or planned.

Final fixed-head build/typecheck/full suite passes **2,577 tests + two skips / 148 files**
(four workers, 36.15 seconds); the exporter has 35 controls. The actual five-second subprocess
regression now passes without raising its deadline. Exact-head PR CI and post-merge CI remain
pending delivery gates; no live evaluation was run.
