# R16g independent review receipt

One frozen review of `530f882f8e3c0dbad359c5e479394388a45391aa` against
`93452df95a731a38bd46badb78953d13a7c8f272`.
Session `4220c198-9b66-401d-9efa-0f3ad4483157`. Initial request: 24 turns; **25 reported**,
216.327 seconds, exit 1, `error_max_turns`, no verdict. The sole permitted
same-session tools-disabled summary requested one turn; **one reported**,
64.618 seconds, exit 0. **26 total reported turns, one substantive review**.
No denied commands, delegates or external searches. Reported metadata costs are
list-price estimates, not evidence of subscription billing.

## Original bounded-review terminal result

`error_max_turns`: "Reached maximum number of turns (24)"; `stop_reason: tool_use`.
No initial verdict or findings text was returned.

## Original same-session summary (verbatim)

# R16g Review Summary — frozen `530f882` vs `93452df`

## Verdict: APPROVE (static review only — no executed verification)

No material lifecycle, persistence, caps/provenance, permission/sandbox or TUI-wiring defect was substantiated in the scoped diff. This verdict rests entirely on reading the complete scoped source diff and the two principal test files; **I executed no tests, build or typecheck** before turn exhaustion. See Limitations — the approval is correspondingly weaker than one backed by a run.

## Material findings

**None.** I am not reporting any finding, because none reached a reproducible counterexample. Two threads were left open (below); they are questions I did not close, not defects I confirmed.

## Checks completed, with outcomes

| # | Concern probed | Outcome |
|---|---|---|
| 1 | `/doctor` sandbox gate reachable from real wiring | `sandbox` is a member of `ConfigValuesSchema` (`packages/cli/src/config.ts:88`), so `diagnosticConfigValues` preserves it through the `CONFIG_KEYS` filter and the `sandbox !== "none"` refusal in `packages/cli/src/tui/manual.ts` is live from `start.tsx:141`. Not a gap. |
| 2 | `/doctor` provider/credential probe | `packages/cli/src/doctor.ts:556` gates all provider construction, `probeProvider` and `writeProviderProbe` on `cli.probe === true`; `manualDoctor` forces `probe: false`. Model-free as contracted. |
| 3 | Silent truncation of a bounded `/diff` | `reviewProcess` (`packages/cli/src/review-process.ts`) calls `stop()` and **rejects** on exceeding `min(maxBytes, 65_536)`; it does not truncate. So the 16 KiB bound in `manual.ts` cannot present a truncated patch under a verified `sha256:` identity. Not a defect. |
| 4 | `/diff` store-root mismatch | `start.tsx:145` uses `new SessionStore({ root: opts.root })`, identical to the existing sessions/fork store at `start.tsx:122`. No mismatch. |
| 5 | `diagnosticConfigValues(opts)` throwing at `/doctor` time on a type mismatch | No `--context-window` flag exists in `program.ts`, so `contextWindow` (the one strict-number setting) can only arrive already parsed from the config file; `positiveSetting` accepts `string \| number`. No failure path identified. |
| 6 | Widened `isIdle()` regressing prompt queueing | `state.pending`/`state.queued` are permission-request fields (`controller.ts:88-90`, `:466-481`, `:655-657`), not queued prompts. No regression identified. |
| 7 | `startupAbort` blanket command block (`controller.ts:743`) spanning a whole turn | Cleared at `controller.ts:1130` immediately after `this.session = session`, so it covers only the startup window. |
| 8 | Double-release / leak of parent+child locks in `manual-compaction.ts` | The `handedOff` flag partitions the outer `finally` from the result-IIFE `finally`; no double release found. `releaseParent()` is skipped only if `lifecycle.finish` throws, which the author comment and the `terminal` persistence test indicate it does not. |
| 9 | Adoption of an unverified child | The post-terminal block re-acquires the child lock and requires `session.end`/`reason: "done"`, `readSnapshot(id).messages` and `materializeMessages(id)` all deep-equal `compacted`, else demotes to unadopted. This is the guard named as a restored mutant in `docs/plans/R16g.md:66`. |
| 10 | Controller adopting a stale/foreign fork | `controller.ts` `runManual` re-checks `result.compacted && !abort.signal.aborted && !this.closing && this.agent === agent && this.state.sessionId === parent` and a successful `resetGrants` before switching `sessionId`. |

Test files read (not run): `packages/core/test/manual-compaction.test.ts` (14 cases — parent byte/snapshot identity via `unchanged()` on every failure path, context/snapshot/terminal persistence failures, veto/no-op, abort with late compactor result, legacy `maxTokens`/`maxUsd` refusal before fork, capped no-dispatch, held parent lock, stale snapshot, unknown usage blocking the next capped dispatch, forged user authority, opaque reasoning byte-identity, one-call/output-token bounds, oversized summary, deadline). `packages/cli/test/manual-commands.test.ts` (Ink `App` `/compact` at 80/120 columns, failed-publication identity retention, agent replacement during compaction, synchronous shutdown inside `Agent.run`, `/clear`–`/new` parity and reserved names, owned-doctor exclusion, resume/fork preparation ownership, real Git diff with untracked-canary exclusion and filter/denial/sandbox refusal, checkpoint validation with a moved-ref counterexample, abort of pending policy/ask decisions). These read as discriminating actual behavior rather than restating implementation.

## Unresolved threads (not findings)

1. **`checkpoint.sealed` binding.** In `packages/cli/src/tui/manual.ts` the seal is selected by `event.sessionId === checkpoint.sessionId && event.seq > checkpoint.seq` only — not by `ref` or `turn`. I did not read the `checkpoint.sealed` schema, so whether a seal recorded for a different turn could authorize the `realpath(seal.repo) === root` check is unverified. Worth the author confirming; I have no counterexample.
2. **`EventStream` buffering for a late consumer.** `emit` pushes through a promise chain without awaiting a consumer (`packages/core/src/session-lifecycle.ts:90-98`), which argues against a backpressure deadlock when the controller attaches its `for await` only after `await agent.compact(...)` resolves. I did not read `EventStream` itself, so whether `session.resume` or an early `budget.cap` is buffered for that late consumer is unverified. Note the capped test asserts on the persisted child log, not on the stream, so a dropped early event would not be caught there.

## Optional polish (END, non-blocking)

- A `/diff` exceeding the 16 KiB subprocess bound surfaces the generic `"review subprocess refused, failed, exceeded its bound or was cancelled"` message rather than naming the size bound. Correct and safe; only the diagnostic is imprecise.
- `this.set({ maintenance: kind })` is issued twice in `runManual` (once inside the compact branch, once after the promise is assigned). Harmless.

## Tests actually run

**None.** No focused test, build or typecheck was executed. All 24 turns went to reading `CLAUDE.md`, `docs/PLAN.md` §5, `docs/plans/R16g.md`, the full scoped source diff and the two test files, plus the ten targeted source checks tabulated above.

## Limitations and denied commands

- No commands were denied; no live provider call, clipboard, notification, auth or external search was used. No source, commit, branch, PR or roadmap file was edited.
- The full required-Docker suite and Chromium smoke run independently on this same frozen tree; the pass counts quoted in `docs/plans/R16g.md:81` and `:88` are the author's, unverified by me.
- `packages/cli/test/manual-startup.test.ts` (71 lines) was not read.
- I did not confirm that `renderEvent` is already imported in `controller.ts` for its new use in `runManual`; a typecheck would settle this immediately.
- Static reading cannot establish that the three restored mutants named in `docs/plans/R16g.md:66-68` actually fail without the guards; I confirmed only that the corresponding guards exist in source.

## Author disposition

APPROVE retained, explicitly static-only. Author validation on the frozen source:
build/typecheck, 129 focused controls, full actual-Docker **3,089 passed plus two
existing skips /194 files, 68.36s**, real Chromium one (2.33s). No reviewer-run test
is claimed; original test-count/reading statements above remain unchanged.
The two open questions receive narrow author checks, not another review. The
second state notification intentionally exposes the actual maintenance Session
for status consumers; it is not removed as duplicate work. Generic diff-error
wording remains optional END polish.

Author closure of the open questions: EventStream buffers from index zero for each
subscriber (`core/session-lifecycle.ts`); an actual capped maintenance Session,
consumed only after its result completed, yields the full resume/cap/end sequence.
No production stream change was needed. Seal binding did yield a concrete author
counterexample: a real first run with a failed seal followed by a successfully
sealed resume allowed `/diff checkpoint 1` to borrow the later seal. The exact
test failed before and passes after selecting the seal only inside the checkpoint's
own completed run, with matching namespace and a non-earlier turn. This does not
claim undo ownership, and does not require seal.turn to equal an earlier tool turn.
The original APPROVE and unconfirmed question above remain verbatim.

Separately, #205 macOS/Windows failures exposed the same raw-temporary-path fixture
pattern in these tests. Running the original missing-usage and unmetered tests with
TMPDIR pointing through an explicit directory symlink reproduced two unavailable-
ledger failures on Linux. Canonicalizing only the test fixture cwd with realpath
makes both unchanged assertions pass through the same alias; production ledger
canonical-root validation is unchanged. This is author fixture evidence, not an
independent-review finding or a claim of remote R16g failure.
