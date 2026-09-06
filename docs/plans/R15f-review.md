# R15f — independent review (verbatim)

One Claude process/session `7e311611-bccb-414c-8132-809ee68e003c`, frozen
HEAD `b7df8a5` versus main `6322139`. Requested maximum 24 turns; CLI reported
35 turns and 387.218 seconds. This exceeded the requested turn cap; no restart
or second review was performed. The following final response is preserved verbatim.

**Verdict: APPROVE** for R15f at frozen HEAD `b7df8a5` against `origin/main` `6322139`. No material contract, correctness or security gap found. Tracked files are unchanged (git status clean after the review). One scratch directory was created outside the repo at `/tmp/agentrig-rv` for a probe.

**Independent commands and results versus author evidence**

| Command | My result | Author evidence |
|---|---|---|
| `pnpm exec vitest run --maxWorkers=4 packages/cli/test/ci-run.test.ts packages/cli/test/review.test.ts packages/cli/test/program.test.ts packages/cli/test/run.test.ts packages/cli/test/mcp-serve.test.ts` | 4 files, 66 passed, 10.55s (one listed path did not resolve; vitest ran the 4 existing files) | 66 focused tests passed |
| `pnpm exec vitest run --maxWorkers=4` with inherited `AGENTRIG_EVAL_REQUIRE_DOCKER=1` and both pinned `sha256:` image variables | 169 files, 2805 passed, 2 skipped, 52.20s | 2805 passed + 2 skips / 169 files, 55.07s |
| `git status --short` before and after | clean | frozen HEAD claim holds |
| dist freshness | last source commit `dba032a` 22:03:11, `dist/ci-run.js` built 22:03:19, and both new strings (`CI refuses --json/--verbose`, `dependencies.observe`) present in dist | "existing dist is already built" |
| Probe: 16,384-byte task through `readCiTask` then `AdvisoryPromptContextSchema` | accepted at both layers (schema cap is 32,768 chars / 256 KiB) | not claimed; closes a suspected late-refusal gap |

No build, typecheck, install, network, provider or `gh` invocation was performed. The prior malformed checker-image run is not treated as evidence; the run above with the exact pinned digests is my own receipt.

**Contract items verified by reading code plus the passing actual-CLI tests**

- Empty runtime task plus advisory context never grants fresh approval. `packages/core/src/agent.ts:284-286` starts the expansion restricted, `expansion.user("")` sets nothing, and `expansion.unknown()` is called for advisory context. `packages/core/src/tool-execution.ts:310-343` forces `ask` for exec/network/outside-cwd write even under an allow rule, and any non-allow or aborted answer becomes deny. The `--allow exec` negative in `ci-run.test.ts:89-102` exercises this end to end.
- Asks deny, abort and stop queued effects. `ci-run.ts:125` returns deny and aborts the run controller; `run.ts:481-482` forwards the abort to `session.control.abort()`. `ci-run.test.ts:53-60` confirms both queued `write_file` sentinels are absent and exit is nonzero. `outcome` is forced to `permission-refused` regardless of runtime reason (`ci-run.ts:127,129`).
- Fixed clamps and config. `ceiling()` at `ci-run.ts:60-64` takes the smaller value, rejects nonpositive or non-integer turns/tokens, and `parseBudget` retains `maxUsd`/pricing validation. Commander's 300-turn headless default is clamped to 20. YOLO, `dangerouslySkipPermissions`, resume, scheduled, heartbeat, `--json` and `--verbose` refuse before any provider work (`ci-run.ts:66-69`), and `json`/`verbose` are not config fields.
- Bounded source selection, no payload authority. Exactly one source enforced at `ci-run.ts:45-46`; selector is a closed enum; symlink/FIFO/oversized/changed-during-read inputs refuse (`ci-run.ts:20-34`); depth 16 pre-check; unselected fields are never read. No `GITHUB_EVENT_PATH` reference exists in any package source.
- Create-only report. `reserveReport` uses `wx` with mode 0600 under a realpath'd existing parent (`ci-run.ts:80-84`), reserved before provider work, so occupied and symlink destinations refuse with zero provider calls. Failure reports are written on early refusal; report absence or write failure is nonzero.
- Inert text and redaction. Export redaction is cloned, then `sanitizeLine` strips controls and bidi/zero-width, then backticks, `@`, `<`, `>` are neutralised (`ci-run.ts:74-79`). Capture is 16 KiB raw, render cap 32 KiB, total report 64 KiB, with explicit omission markers. Canary test passes; task/tool/error payloads are not copied.
- GitHub path. Every `gh` call goes through the shared `gitHubRequest` (`github-report.ts:15-26`) requiring exec and net allow decisions from the base policy and refusing under any non-`none` sandbox. Identity is pinned before the run and re-read before posting; comment is refused on non-done outcome, omission, cancellation, or non-complete accounting (`ci-run.ts:148-149`). Fake-`gh` test covers denial, identity change, partial accounting, cancellation and no implicit report.
- R15e preserved. `review.ts` now delegates `gh` to the shared helper with the same permit shape; review tests pass unchanged.
- Ordinary run and MCP regressions. `runCommand` gained an optional third argument only; `mcp-serve.ts` and `acp.ts` build agents directly and are untouched. Full suite green.

**Material findings**

None.

**Optional polish (not blocking)**

- `docs/CI-MODE.md:65-66` says at most 16 KiB of assistant text is shown, while the rendered cap after escaping is 32 KiB (`ci-run.ts:78,131`). State both numbers.
- `sanitizeLine` collapses all newlines, so the assistant section of the report is one long line inside the fence (`ci-run.ts:78`). Newlines inside a fenced block cannot forge headings once backticks are replaced, so preserving them would improve readability without weakening inertness.
- `ci-run.ts:82` checks `isSymbolicLink()` on an already realpath'd parent, which can never be true. Dead check; harmless.
- Byte-slicing at `ci-run.ts:99` can split a multibyte character at the 16 KiB boundary, yielding a replacement character at the cut. Cosmetic.

**Limits of this review**

- The three Action SHAs in `docs/CI-MODE.md:111-129` were not verified against upstream tags because network access was out of scope. Root should confirm the pins before anyone adopts the example.
- Dist was spot-checked for freshness, not rebuilt.
- R15a question events remain a separate lane and were not assessed here.
