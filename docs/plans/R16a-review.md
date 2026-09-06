# R16a independent review

Author disposition: REQUEST_CHANGES addressed with three actual fail-before/pass-after
controls for nested lists, fences and quotes. Tight list-item block text had no trailing
separator; joining the item blocks before indentation fixes the common cause. Original
review below is unchanged and is not represented as approval of the correction. No
second review. Cosmetic observations are at the literal END of ROADMAP.

Frozen `c79e5b9` against `749ff26`; session `bb68d627-381d-41af-915c-238a904004cc`.
One process, requested 24 / reported **20 turns**, 198.552s, exit 0. Three commands
were denied (attempted probe-file writes, ad-hoc node probe, CLI typecheck). No
independent build/typecheck/full-suite claim. Reported list-price USD 1.63214175 is
not a subscription billing receipt. Original result follows verbatim.

## Original result

Wrapping up: I've read the contract, diff, renderer and tests, run the focused suite, and confirmed marked's list tokenization by reading its source. Composing the review now.

**Review of R16a `c79e5b9` vs `749ff26`**

**Verdict: REQUEST_CHANGES** (one material correctness defect; everything else is polish or contract-compliant).

**Tests actually run by me**

| Command | Result |
|---|---|
| `vitest run markdown/viewport/tui-frame/thinking --maxWorkers=2` | 4 files, 45 tests passed |

Typecheck, build and any ad-hoc renderer probe were not run: the sandbox denied `tsc` and `node -e`. The author's Docker 2925+2/181 figure is not independently reproduced here.

**Material finding**

1. **Nested blocks inside list items collapse onto the parent line.** In `packages/cli/src/tui/markdown.ts:78-85` a list item's tokens are concatenated with no separator. marked lexes item bodies with `state.top=false`, so the leading text becomes a block `text` token (rule `^[^\n]+`, no trailing newline) rather than a `paragraph`. The `text` case at line 62 emits no newline, and `list`/`code`/`blockquote` emit only trailing `\n\n`. Result for the ubiquitous tight nested list

   ```
   - item
     - nested
   ```
   is `• item• nested` on one line. Same for a fence or blockquote following text inside a tight item. Verified by reading marked 18.0.11's lexer (`blockTokens(a.text,[])` under `top=!1`, `text` merge branch), not by execution. No test covers nesting: the golden and structure tests use flat lists only. Fix is small: have block-level `text` tokens end with `\n` when followed by a sibling block, or join item tokens with `\n`; add a nested-list golden at 80 columns.

**Non-material observations (no change required)**

- **Long-reply display bound.** Replies over 32 KiB now show only the first 32 KiB plus a notice (`fallback`, line 33). Before R16a the full text reached `Static`. The contract explicitly permits this, so it is not a defect, but the literal fallback could pass `terminalText(source)` unbounded since it needs no parser. Flagging for the roadmap end.
- **Tone colour lost after first styled span.** Renderer emits `\e[0m`, which also cancels Ink's `white` tone for the assistant line; chalk only re-opens its own close code. Cosmetic.
- **All headings render identically** (bold cyan, no level cue). Cosmetic.
- Bold/emphasis inside table cells is stripped by design; comment in `viewport.ts` says so.

**Things I checked that are correct**

- Terminal safety: `terminalText` strips C0 (except `\n`), DEL, C1 (so `\x9b` CSI), bidi controls, and runs after entity decoding; codespan/code/html paths use `decode=false` but still sanitize. marked 18's lexer does not HTML-escape codespan text, so `` `a < b` `` stays literal. Only renderer-owned SGR is emitted; `markdownTable` strips SGR before slicing so no escape is cut mid-sequence.
- Lifecycle: `App` wires the cache once via `useState`; `Static` items keep object identity across snapshots (`controller.ts:342` spreads the array, and eviction replaces with a new empty-text object that renders as empty). First-width caching holds. Streaming stays on `fitToRows`. Cancellation flush reuses the existing `assistant.push` path.
- Bounds: node/depth/output guards throw into fallback; table 16×100 elision and narrow "key: value" layout are exercised. Ink lifecycle tests assert one parser call, one banner, no clear-screen, unchanged log.
- Named mutations are plausible and the tests would catch them.
- Docs/CI: STATUS, ROADMAP top/row/§5 and the CI step are updated as required; deps pinned exactly.
