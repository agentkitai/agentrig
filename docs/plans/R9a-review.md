# R9a independent review — original verdict

One read-only Claude process, session `6c19c9db-0440-4ad7-ac39-8c130be71ac1`,
235 seconds, 17 reported turns / requested maximum 24, no restart or subagents.
Reviewed clean stable head `5897aea` against main `391514b`. The original verdict below is
verbatim. It did not discover the author's separate five-second long-token timing failure;
that material post-review fix and its regressions are recorded in R9a.md. No second review.

**Verdict: APPROVE**

No material defects found in R9a. Every path I exercised failed closed with fixed diagnostics, the fork and compaction fold matches the store's own materialization, and redaction runs on a clone before any readable or canonical copy is rendered.

**What I verified against the code**

- **Bounded stable materialization** at `packages/core/src/session-export.ts:38-112`. Limits can only be lowered, cumulative bytes are checked from the lstat size before open and again per chunk, event count and line bytes are checked before JSON parse, depth is checked before schema validation, and stamps are compared before open, after read, and again over all files after ancestry load. Symlinks and non-regular files refuse.
- **Strict unknown content** at lines 26-30 and 88-92. Deep equality against the zod output rejects stripped fields on messages, compaction lists, and event context. A `signature` field on a text block refused in my probe.
- **Shared fold** at `packages/core/src/session-store.ts:523`. Export reuses the store's fold rather than reimplementing it, and the round-trip test compares against `materializeMessages` directly.
- **Redaction before all copies** at `packages/cli/src/session-export.ts:98-101,120-128`. Clone, scrub, revalidate, then render. ShareGPT `value` and Markdown readable text are derived from the already-redacted messages.
- **Opaque handling** at lines 89-93. Images refuse without the flag, nested images inside tool results are replaced, and neither base64 nor media type survives.
- **Safe errors** at lines 108-113 and core 107-111. Invalid ID, missing file, and malformed log all produce the same generic string with no path or ID.
- **CLI side effects** at `packages/cli/src/program.ts:450-460`. No `configured()` call, single write after full construction. Refusals produced zero stdout bytes in my runs.

**Independent checks actually run**

- `pnpm build` and `pnpm typecheck`: both exit 0.
- `pnpm exec vitest run packages/cli/test/session-export.test.ts`: 33 passed.
- `pnpm exec vitest run --maxWorkers=4`: 148 files, 2575 passed, 2 skipped, exit 0.
- Node probes of `redactExportMessages` from `dist`: innocent `max_tokens`/`token_count` untouched, credential keys in nested tool input redacted, string tool input redacted, JWT inside JSON text redacted, unterminated PEM redacted to end, nested image refused then omitted with the flag, unknown field refused.
- Real CLI on a temp session store: JSONL positive path, ShareGPT with `--redact-file`, Markdown with `--omit-opaque` through a fork prefix, image refusal, missing session, path-traversal ID, bad format, and a log lacking `session.end`. All positive outputs were correct and all refusals exited 1 with generic text and empty stdout.
- `git status` remains clean.

**Optional followups, not blocking**

- **Double-redaction artifact.** When a prefix or Bearer pattern fires first, the later assignment pattern at line 55 re-matches `[redacted` and leaves `[redacted]]`, and the count inflates. Input `API_KEY=sk-abcdefghijklmnop` produced that output with two counted redactions. Cosmetic, no leak.
- **Misleading error on label overflow.** A short literal redacted inside a near-limit `hook:` principal or delegation makes the label exceed its schema length, and the revalidation at line 100 reports "unsupported message content" rather than a redaction-specific refusal. Still fail-closed.
- **Plan doc receipt is stale.** `docs/plans/R9a.md` cites 2,563 tests across 147 files; the merged tree now runs 2,575 across 148.
