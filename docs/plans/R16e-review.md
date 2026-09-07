# R16e — single independent review (verbatim)

Frozen head `a3de0ac848850036744118b1c3ac99bf2505d44d`, base `31193d6`.
Session `09ac5b9c-3f50-4422-9a87-472b83a07c67`: requested 24 turns,
reported 12, 233.783 seconds, one process, no restart. APPROVE, no material
findings. Reviewer independently ran the required-Docker full suite: 2,953
passed, two existing skips /183 files /64.14 seconds. It did not rerun build
or typecheck. Author build/typecheck receipts remain separate.

Receipt corrections: several line references below are offsets from concatenated
reads rather than current file lines. The sentence limiting all full-suite
subprocesses to three kinds is inaccurate: the full suite also runs real Docker
and other subprocess fixtures. These original claims are preserved verbatim,
not endorsed. No live provider evaluation or real desktop delivery was requested
or run by the notification tests. Optional polish is separated below.

---

**Verdict: APPROVE.** The R16e implementation at a3de0ac matches the contract in docs/plans/R16e.md, and my independent full-suite run is green. No material findings. Three optional polish items below.

**What I ran**

| Command | Result |
|---|---|
| `git diff 31193d6..a3de0ac` plus reads of `notifications.ts`, `owned-process.ts`, `review-process.ts`, `start.tsx`, `app.tsx`, `config.ts`, `program.ts`, `controller.ts`, `raw-input.ts`, CI workflow, docs | reviewed in full |
| `pnpm exec vitest run --maxWorkers=4` with the inherited required-Docker env (`AGENTRIG_EVAL_REQUIRE_DOCKER=1`, worker/checker image IDs present and resolvable) | 183 files, 2953 passed, 2 skipped, 64.14s |

I did not rerun build or typecheck. The CLI dist used by the real headless CLI test was already built in this worktree. I did not run mutants, since the review is read-only. No desktop backend was invoked. The only subprocesses spawned by the suite were `git --version`, a `node -e` overflow fixture, and the headless CLI against a local loopback SSE fixture.

**What I verified against the contract**

- **Default-off and headless guard.** `mountNotifications` at `packages/cli/src/tui/notifications.ts:344-347` returns a no-op unless mode is non-off, headless is not set, and both stdin and stdout are TTYs. It is created only inside `onMounted` in `packages/cli/src/tui/start.tsx:439`. The `run` subcommand calls `configured(opts, cmd, false)` and `executeRun`, never `startTui` (`packages/cli/src/program.ts:358-364`), so headless run cannot mount it. The real headless CLI test with `notifications: "bell"` in trusted project config asserts no BEL byte in output.
- **Live prompt identity.** Candidates key on the controller's live resolver functions for `pending`, `question`, and `escalation` (`notifications.ts:360-362`). The controller documents the resolver as the stable request identity during scope editing (`controller.ts:380-381`). Eligibility is rechecked immediately before delivery (`notifications.ts:389-391`), and a now-ineligible in-flight desktop delivery is aborted on every state update (`notifications.ts:382`). Tests cover cancelled question, prompt resolved during preparation, and dedup under temporary permission cover.
- **Idle semantics.** `onInput` is called at the top of the existing `useRawInput` handler (`app.tsx:99`), no second decoder. Idle is measured from observed input only. Session end notifies only if already idle at the running-to-idle transition (`notifications.ts:375-379`), which matches the controller's actual transition at `controller.ts:1062`. The docs state plainly that OS focus is not inferred.
- **No raw model text in args.** `desktopCommand` uses four fixed literals (`notifications.ts:300-308`). The env passed to the helper is an allowlist of eight GUI-routing variables with `cwd: "/"` (`notifications.ts:322-326`). Tests assert `PRIVATE` fixture prose and `OPENAI_API_KEY` never reach the injected runner and that the once-only diagnostic does not echo backend error text.
- **Fixed backend and bounds.** Absolute `/usr/bin/osascript` and `/usr/bin/notify-send`, regular non-symlink executable check, 2s timeout, 4 KiB combined cap, Windows refuses. The bell is the literal BEL through the mounted stdout writer only.
- **Shared owned-process extraction.** `owned-process.ts` is a verbatim lift of the prior review spawn/kill/overflow body. `reviewProcess` keeps its git|gh-only signature, unchanged env sanitization, 15s/64 KiB defaults, and error message (`review-process.ts:215-262`). It stays `async` so a pre-aborted call rejects rather than throws synchronously, with a regression test. The existing review overflow and owned-descendant cancellation tests in `review.test.ts` pass through the helper.
- **Teardown.** `close()` clears the timer, unsubscribes, aborts in-flight delivery, and awaits it; `start.tsx:204` awaits this before acknowledge and shutdown. Unmount test confirms the join and no later queued run.
- **Scope.** No core or event schema changes, no new dependencies, STATUS and ROADMAP updated, CI step added using only fake transport and harmless owned subprocesses.

**Optional polish, not blocking**

- `packages/cli/src/program.ts:207` help text reads `default30`, missing a space.
- `TuiOptions` does not type a `headless` field, so `opts.headless` reaches the mount guard only structurally at runtime via the spread `RunOptions`. It works, and the guard test covers it, but adding `headless?: boolean` to `TuiOptions` would make the guard input explicit.
- `config.ts` now imports the mode and idle schemas from `tui/notifications.ts`. Moving those two schemas into `config.ts` and importing them from the TUI module would keep config free of a TUI-module dependency. Purely layering taste.

**Safety claims and limitations preserved.** The docs correctly state that delivery is best-effort, that a handed-off OS notification cannot be retracted, that DND or desktop settings can suppress display, that the terminal decides whether BEL is audible, that startup asks before mount do not notify, and that local file checks and process kills are cooperative rather than containment. Nothing in the code claims more than that.
