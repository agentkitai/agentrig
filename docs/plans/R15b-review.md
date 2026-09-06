# R15b independent review

Frozen head `0be90a5` against `b2390ce`. Session `48da2fb5-e807-4c43-b0fc-b59c950edbc8`,
254,499ms,34 reported turns despite24 requested; no enforced-cap claim. No command denials.
The reviewer independently passed typecheck and22 focused cases. One initial invocation failed
before any session because the prompt was consumed by a variadic option; it was corrected.
There was one substantive review. No edits/full suite/live calls were requested or reported.

Author disposition: the medium supervisor error-burst finding is material and receives an
actual failing-before/passing-after detector control. The separately author-found checkpoint
ownership interaction receives a two-edit/undo control. Neither fix starts another review.
The optional lone-surrogate claim was not reproduced: the added real-write control confirms
both `contentHash` and file writing encode UTF-8 replacement identically. No pending defect
is inferred from that suggestion. The original claim remains untouched below.

## Original response (verbatim)

Project config is read only when the project is trusted (config.ts:317), so untrusted repos cannot inject a checker command. I have everything needed for the verdict.

## Verdict: APPROVE, with one non-blocking finding worth fixing before merge

Read-only review of R15b at 0be90a5 against b2390ce. `pnpm typecheck` clean. Focused suites: 22 passed across the two files. No edits made.

**Verified against the plan's claims**

- **Private receipts.** Only `diagnosticBuiltin` factories can stamp a receipt, keyed by the exact result object and tool context (diagnostics.ts:198-208). The copied-name test confirms a look-alike tool cannot activate a checker.
- **Exclusive lease, no reacquire.** Tools with configured checkers admit with undefined effects, which the scheduler treats as a conflict with everything (tool-execution.ts:289, parallel-runtime.ts:65). The nested call strips `schedule` (tool-execution.ts:478), so prepare/admit are skipped and the outer release happens once in `finish`. The onAsk wrapper uses a separate ask mutex not held by the caller, so no self-deadlock.
- **Edit truth survives checker outcomes.** The nested call is wrapped in try/catch; a denied, failed, aborted or unknown checker still yields `ok: true` with `status: unavailable|incomplete|changed` (tool-execution.ts:487-491). Tests cover exec denial, sandbox refusal, and external-ancestry R13c expansion denial.
- **Exec authorization is real.** The checker goes through `executeTool` with permission class `exec`, so policy, grants, fresh-expansion checks, pre/post hooks and sandbox wrapping all apply. `sandboxSpawnInvocation` refuses when a policy exists without a launcher (sandbox-providers.ts:74).
- **Cancellation.** Job registered with the tool's abort signal, detached process group, `killOnOverflow`, timeout kill, and `join()` awaits `record.done` (close after a 200 ms pipe grace). The bounded-buffer validation in `JobRegistry.start` rejects out-of-range sizes.
- **Parser.** Canonical realpath comparison separates other-file findings; unparseable lines, oversized lines, and nonzero exit with no entries all degrade to `incomplete`. Ruff absolute filenames resolve correctly via `resolve(cwd, path)`.
- **Replay isolation.** `messagesFromEvents` skips any `tool.call`/`tool.result`/`tool.result.patched` carrying `internal` before the authoritative-message branch (session-store.ts:543). `tool.denied` never produces a tool_result block. Fork, resume, compaction and the fallback path without `message.append` are all exercised in the core test.
- **CLI/heartbeat/export.** Heartbeat forces `diagnostics: []` so `hasDiagnostics` is false. `redactExportMessages` runs the diagnostics object through the same recursive string scrubber. Untrusted project config never loads (config.ts:317).

**Finding 1, Medium, not a security issue but a behavioral regression for supervised runs**

`packages/core/src/diagnostics.ts:251` marks the checker result `isError` whenever the exit code is nonzero. tsc exits 2 on any error, including other-file errors. The supervisor's error-burst detector counts every `tool.result` without checking `internal` (packages/supervisor/src/detectors/error-burst.ts:26-27), and `state.toolErrors` increments likewise (state.ts:114).

Reproduction: enable a tsc checker plus the default supervisor. Make two edits that each leave a type error. Result stream is `[diag fail, edit ok, diag fail, edit ok]`, which is 2 of 4 failed at the default `minSamples: 4` and `threshold: 0.5`, so `error_burst` fires on ordinary in-progress work. This is exactly the scenario the feature exists for.

Recommended fix: treat a completed checker run as `isError` only when `observed.incomplete` is true, matching `bash_job`'s own convention that a nonzero exit is the job's outcome, not a tool failure (background-jobs.ts:385). The diagnostics report already carries `exitCode`. Alternatively have the supervisor state fold skip `internal` results, but the core-side change is smaller and keeps supervisor free of new coupling.

I am not blocking on this because it does not affect correctness, safety, audit or replay, and diagnostics are opt-in. It should be fixed before this is relied on under supervision.

**Optional polish**

- `packages/cli/src/render.ts:107`: internal checker results with `ok: false` render as `✗ checker completed` in chat view immediately before the real diagnostics line. Skipping `e.internal !== undefined` there removes the spurious failure line. Resolves itself if Finding 1 is fixed the core-side way.
- `packages/core/src/diagnostics.ts:218`: the hash compares a UTF-8 round trip of the file against the original string. Content with lone surrogates will always report `changed`. Correctly conservative, just worth a comment.
