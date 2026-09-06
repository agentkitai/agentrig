# R15i independent review receipt

One frozen review of `bc051a1a8eb7d9241c1fa3f99dbb393b96f74ed2` against
`31193d649880ade62d6b8ca1ec0525318727ea76`. Session `1b782f7f-e85a-4877-a7fe-dff77f4ecb1f`.
Requested max 24 turns; returned metadata reports **28 turns**,
328.818 seconds, exit 0. Outer timeout 600 seconds. No denied commands.
The requested turn limit was not an enforced actual-turn ceiling. No second review.

## Original result (verbatim)

**Verdict: REQUEST_CHANGES** for R15i frozen commit bc051a1 against base 31193d6.

Focused evidence I used: the full diff, the core and CLI spend-ledger tests, and one run of both focused test files with maxWorkers=2. Result:

| Files | Tests | Result |
|---|---|---|
| core + cli spend-ledger | 25 | all passed, 1.84 s |

The overall design matches the contract. One wrapper at provider construction meters main, child, compaction and session-end maintenance calls through the async-local segment context. Rates are frozen per admission record and settlement cost is recomputed and verified against them on every read. Reservation is appended and fsynced under the lock before dispatch. Unsettled, aborted, retried, `reported:false`, overrun and gap records all block later capped admission across midnight. ChatGPT, custom endpoints, unpriced and unmetered capped paths refuse before any fetch. The `/cost` and `usage` surfaces never initialise a provider. I found no counterexample to any of those properties.

**Material finding (one)**

- **The ledger lock has zero wait, so a benign collision between two cooperating processes becomes a permanent capped lockout.** In `packages/core/src/spend-ledger.ts:134` the `locked()` helper does a single `open(lock, "wx")` and maps any failure, including plain `EEXIST`, straight to `SpendCapError("unavailable")`. There is no bounded retry loop, unlike the memory lock at `packages/memory/src/lock.ts:48`. Counterexample: process A (a TUI session) and process B (a scheduled tick, the exact R7 scenario this row gates) both run capped in one project. B's model call finishes while A is appending its own admission. B's `settle()` fails on the lock, then `packages/core/src/spend-ledger.ts:219` removes the call from `live`, leaving a durable admission with no settlement. Every later `gate()` in any process now throws `uncertain`, and the row provides no recovery command by design. The same collision on an uncapped run fails the compensating `gap()` write too, since it also needs the lock, leaving unknown coverage that likewise blocks any future capped run. This contradicts both the plan ("Reuse canonical path checks and a bounded cooperative lock") and SPEND-LEDGER.md ("Cooperating writers serialize append/check operations"). The existing cross-process test accepts any refusal, so it cannot distinguish proper `uncertain` refusal from a lock collision. Fix: give `locked()` a bounded EEXIST retry loop with an overall deadline and abort-signal check, keep the fail-closed `unavailable` result only when the deadline expires, and tighten the cross-process test to assert the loser's reason is `uncertain`.

**Optional polish (non-blocking)**

- `records()` allocates a fresh 16 MiB buffer and re-parses and re-folds the whole file on every admit, settle, check, end and gap. Within the stated bounds it is correct, but it is quadratic over a busy day. Caching the fold keyed on the observed prefix would remove that.
- A torn ledger surfaces a raw `JSON.parse` SyntaxError through `usage` (`packages/cli/src/program.ts:672`) and through `/cost`, and Node's message includes a snippet of the file. Session events are already protected, but wrapping parse and zod failures in `records()` as `SpendCapError("unavailable")` would give every surface the same fixed reason.
- `report()` and `costLines()` mutate `this.observed` on the live ledger outside the lock. I could not construct an actual interleaving that breaks a later append, but read-only surfaces would be safer not touching live state.
- The refusal text in `packages/cli/src/provider.ts:152` always says `--daily-cap` even when the cap came from config `dailyCap`, which also silently disables `dream`, `memory ingest`, `review` and `doctor --probe` for that project. Naming the config key in the message would help operators.
- The `schedule tick --daily-cap` flag path is not covered by a test; only the config `dailyCap` scheduler path is.

Scope note: this review covers configured-estimate admission behaviour only, as requested. It does not assess invoice accuracy or containment against hostile writers, which the row explicitly excludes.

## Author disposition

Material lock-contention finding is being reproduced and corrected with bounded
retry and cancellation-aware admission, preserving durable uncertainty on genuine
failure. Privacy-safe parser errors and nonmutating report reads are small related
fixes. Prefix/fold caching remains optional END polish.

Separate author-found findings, not findings attributed to this review: mixed SDK
agents must not mutate a parent accounting context; a still-live prior-day
reservation must block new-day admission until settled. Exact controls and final
validation will be recorded in the implementation plan. The original favorable
midnight statement above is retained verbatim, not silently amended.

