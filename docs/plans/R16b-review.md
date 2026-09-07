# R16b independent review

One review: **APPROVE**, no material findings. Frozen `c1c256de850aa782d6400018e6f330d1cafaf323`
against `74699dac9fd6a1914e741e5f102cdb36d4bcfb04`. Session
`07f886ec-cba8-4cd7-943c-9966fd295cf7`; requested 24 / reported **13 turns**,
147.479s, exit 0. One ad-hoc shell probe was denied; no second
review or tools-disabled continuation. Reviewer independently ran 43 + 176 tests
and typecheck, not the author's full Docker suite or build. Some original line
references reflect concatenated output offsets rather than actual file lines;
the original is preserved, not endorsed as exact navigation.

Author disposition: the raw ACP opt-in content consequence is now explicit in the
plan. Large-file changed-region excerpts are optional at the literal roadmap end.
In-progress labels remain until the actual delivery gates, not premature done.

## Original result (verbatim)

**Verdict: APPROVE.** R16b commit c1c256d meets the contract in docs/plans/R16b.md on every focus point I checked, and the independent runs below all passed.

**Commands run and results**

| Command | Result |
|---|---|
| `pnpm exec vitest run packages/core/test/file-diff.test.ts packages/cli/test/file-diff.test.ts packages/cli/test/transcript-diff.test.ts packages/core/test/post-edit-diagnostics.test.ts packages/cli/test/post-edit-diagnostics.test.ts` | 5 files, 43 passed |
| `pnpm exec vitest run` on sandbox, sandbox-effects, sandbox-denial-evidence, cli render, skip-permissions, otel, tools | 7 files, 176 passed |
| `pnpm typecheck` | clean |

I did not run the full suite, so the author's 2,976-test Docker figure is not independently reproduced. One planned ad-hoc probe of symlink and sandbox capture outside the worktree was blocked by the sandbox, so those two behaviours below are code-read conclusions, not observed.

**Independently observed, meets acceptance**

- **Protected builtin capture.** Only the two factories call `diffBuiltin` (`packages/core/src/tools/edit-file.ts:23`, `write-file.ts:18`). `takeFileDiff` requires WeakMap tool identity, the exact result object and the exact context (`packages/core/src/file-diff.ts:548`), and consumes once. The forged same-named extension test confirms a JSON `fileDiff` field is dropped.
- **No preapproval reads.** The proposal is built purely from validated input (`file-diff.ts:536`); the write-before read runs inside `execute`, after permission (`write-file.ts:29`). The denied-ask test asserts no `open`/`readFile` on the target.
- **Honest unknown/truncated/complexity.** Non-file, symlink, inode change, size/mtime/ctime change, NUL bytes, invalid UTF-8 and abort all yield `unknown`; only an initial ENOENT yields empty-complete. The renderer refuses to emit hunks unless both sides are `complete` (`packages/cli/src/file-diff.ts:159`) and labels the jsdiff `maxEditLength` fallback explicitly.
- **Bounded coloured diffs.** 80 lines including elision, 512 code points per line, 48 KiB total, three fixed ANSI codes, `NO_COLOR` respected, control/bidi/surrogate sanitation applied to every line including the path header. The wide-character and 5,000-line tests exercise these.
- **Actual wiring.** Transcript: `render.ts:212` renders on ok results only. Permission: `permission-prompt.ts:39` appends the excerpt only for write-class asks with a builtin proposal; the Ink test at 80 and 120 columns confirms both surfaces and no full-screen clear.
- **Sensitive metadata exclusion.** Model replay builds tool results from display/output only (`session-store.ts:532` area); OTLP pushes only the permission attribute on tool.result (`otel.ts:87`); memory ingest and the supervisor reviewer use display/output only. The core test checks provider requests, replayed messages and spans for the canary.
- **Preservation.** Sandbox: capture short-circuits when a policy is active, and the existing sandbox suites pass. Diagnostics: `stampChanged` still runs after `stampFileDiff`, and the checker tests now assert both. Static: rendering goes through the existing `print`/chat path with no viewport changes.

**Hypotheses, nonblocking**

- The ACP raw event channel forwards whole events when the client opts into `raw` (`packages/cli/src/acp-server.ts:91`), so captured before/after content reaches that authenticated editor client. This matches the contract's "raw canonical logs retain it" posture but is worth one line in the plan.
- Capture-then-write is not atomic. The contract already disclaims this.

**Optional polish, roadmap end**

- Any edit to a file over 64 KiB or 6,000 lines falls back to 32-line head excerpts on both sides, which usually will not show the change at all. A window around the edited region would make large-file edits reviewable while staying honest.
- ROADMAP and STATUS still read "in progress"; the merge receipts need the usual flip in the delivery step.

