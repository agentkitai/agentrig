# R11b independent review receipt

One read-only Claude review of combined head `b18a7fa` against R5b main `fef3f46`:
`ba153bee-f45e-4666-94b6-a4f309e45b1a`, 168 seconds, 11 reported turns under max24.
It ran 87 existing tests. Ad-hoc write/script attempts were denied; the material finding was
initially a code trace, not a reviewer-executed reproduction. No edits/agents or second review.
The reviewer line numbers below are retained verbatim even though they do not match file-local
line numbers. Original final result:

> Review complete. One material finding, plus a few optional polish notes. Everything else in the contract checked out against the code and the local tests.
>
> **Verdict: not APPROVE.** One material correctness defect in HTML extraction. All permission, credential, redirect, cap, deadline, cleanup, provenance and CLI composition checks pass.
>
> **Material finding**
>
> - **Script or style content containing a bare `<` swallows the rest of the document.** In `packages/core/src/tools/web-fetch.ts:297-313`, while `suppressed` is set, a `<` inside the raw-text element is still scanned as a tag up to the next `>`. That `>` is frequently the one that closes the real `</script>` tag, so the closing tag is consumed as part of a pseudo-tag and suppression never ends. This is valid HTML, not malformed markup, so the contract's "malformed markup can lose text" disclaimer does not cover it. Inline analytics snippets with `i<n` loops or comparisons are common on real pages.
>
>   Reproduction, traced by hand against the loop since the session declined to run an ad-hoc script:
>
>   ```html
>   <script>if (x<3) y();</script><h1>Visible heading</h1><p>Body text</p>
>   ```
>   1. `<script>` sets `suppressed = "script"`. Text `if (x` is dropped.
>   2. At `<3) y();</script>`, the scan runs to the `>` that ends `</script>`. The token starts with `3`, so the name regex fails and `name` is undefined. Line 309 leaves `suppressed` set.
>   3. `<h1>`, `Visible heading`, `<p>`, `Body text` are all dropped. Output text is empty, `truncated` is false, and the model sees a successful fetch with nothing in it.
>
>   The existing extraction test at `packages/core/test/web-fetch.test.ts:523` uses `alert("bad")`, which has no `<`, so it does not catch this. Suggested fix: when `suppressed` is set, skip directly to the next case-insensitive `</script` or `</style` occurrence instead of tag-scanning, and add the case above as a test.
>
> **Verified as specified**
>
> - **Strict URL and no ambient credentials.** Schema refuses non-HTTP(S), userinfo, control characters, and any extra fields. Fetch sends fixed headers with `credentials: "omit"` and no cookie jar, and the test confirms Set-Cookie is not replayed.
> - **No redirects.** All 3xx statuses are refused before any body read, and the target is never hit.
> - **Decoded cap with compression.** Streaming count is post-decoding, so the gzip case trips the cap. Declared Content-Length above the cap refuses early.
> - **Deadline and cleanup.** Timer composes with the caller signal via AbortSignal.any, is cleared in finally, and refused bodies are cancelled. The pre-abort check runs before the timer is created, so no leak.
> - **Provenance and gates.** The tool declares external result source, and the runtime maps that to external trust. The R11a runtime gate and the tool's own policy check both refuse non-none no-network policy. Effects only feed checkpointing, so read-only does not weaken the net ask.
> - **CLI and children.** The CLI builder registers built-ins, so web_fetch ships. Children inherit the parent's tool list minus subagent. The reserved-name set and tests were updated.
>
> Tests run locally: the two new web-fetch files plus tools and extensions tests, 87 passing.
>
> **Optional polish, not blocking**
>
> - A 304 response is reported as "refuses redirects" at line 347. A separate message for 300 and 304 would be clearer.
> - Text-only pages with a bare `<` followed by a space, such as `a < b`, also lose text after it. Browsers treat that as literal text. Same fix family as the finding.
> - Trusted extensions can replace undici's global dispatcher with a proxy agent, and Node's opt-in env proxy support would route through a proxy URL that may embed credentials. This is within the documented trusted-host limitation, but the contract could name it.

## Material finding addressed

Two actual local HTTP fixtures (`script` and `style`) failed before the fix, returning empty
text instead of following visible headings/body. The fix searches raw-text closing names directly
with ASCII case folding, advancing through rejected longer-name prefixes and checking delimiter
boundaries. It does not parse JavaScript/CSS or build a DOM. Fixtures include comparison `<`,
`</scripted>`/`</styleed>` false prefixes, uppercase real closing names and Unicode text whose
case folding could otherwise shift indices. Both pass after the fix. Optional notes are at the
roadmap END; no second general review was requested.
