# Grapheme-safe backspace

Existing R16d END follow-up. Replace UTF-16-unit deletion in the common composer
and permission scope editor with deletion of the final extended grapheme cluster.
Use the supported runtime's Intl.Segmenter without copying the whole segmented
buffer into an array. Keep all retained code units unchanged: no normalization,
cursor redesign, Unicode repair, paste decoding or permission-policy changes.
The existing explicit trailing-backslash newline behavior remains literal.

Actual mounted Ink controls cover emoji, combining accents, skin-tone/ZWJ emoji,
flags and family clusters through both ordinary and protocol-replay backspace.
Verify the exact next provider prompt and unconfirmed scope text, no new grant,
and literal framed pasted control bytes. Question/supervisor answers use the same
composer. Unit controls include empty/ASCII/newline and incomplete surrogate input.
Keep menu redraw, quiet-point input, history and frame bounds. One bounded Claude
review; build/typecheck, full required pinned real Docker, Chromium, exact-head
and post-main CI. Independent follow-ups merge when ready; no artificial order.

## Author validation

All four actual prompt/scope cases fail on the original one-code-unit deletion;
both keyboard paths pass after the two sites use the helper. Reproduce against
the original source with `pnpm exec vitest run packages/cli/test/prompt-composer.test.ts -t 'backspace removes whole graphemes'`.
Final focused group72 tests/3files passed5.50s, including exact next-provider text,
unconfirmed scope/zero grants, protected answers and literal pasted DEL. Unit
controls preserve prefix spelling and handle empty/incomplete-surrogate text.
Build/typecheck pass. Full pinned-Docker, Chromium and hosted receipts follow.
