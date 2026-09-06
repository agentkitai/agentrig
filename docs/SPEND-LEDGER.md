# Project model-cost estimates

Trusted session execution records `.agentrig/usage.jsonl`. This is an append-only
operational ledger: call admission, final usage settlement, coverage gaps and run
end. It contains model/segment/session IDs, timestamps, disjoint token counts and
the configured rates used at that time. It never contains prompts, model output,
credentials or invoice data. Resume and fork charge only new calls, not copied
session totals. Repeated cumulative usage updates count once.

```
agentrig usage --since 2026-09-07
agentrig usage --since 2026-09-07 --json
agentrig run "inspect the project" --trust --daily-cap 2 \
  --price-in 1 --price-out 4
```

Prices above are illustrative user inputs, not current vendor prices. `/cost` in
the TUI shows today's project estimate and the current run segment when recorded.
The standalone `usage` command is read-only: no provider/configuration or credential
initialization. Dates are UTC `YYYY-MM-DD`. Unknown coverage is shown explicitly,
including unresolved earlier-day calls. An empty ledger does not establish spend
before recording began. Existing per-session token and USD budgets are separate.

## Daily cap is configured-estimate admission, not billing

`dailyCap` in trusted configuration or `--daily-cap` on run/TUI/schedule tick must
be positive, at most 1,000,000 USD and at least one micro-USD after rounding down.
Explicit input/output rates are required; cache rates override provider multipliers.
The current CLI rates apply to all configured provider entries; choose them
deliberately for the models used. Each call freezes its resolved rates. No historic
usage is repriced when configuration changes.

Before each model dispatch the ledger reserves the configured full context window
at the highest input/cache rate plus requested maximum output at the output rate,
rounding upward to micro-USD. This is a configured envelope, not tokenization or
server enforcement attestation. Actual reported overrun is recorded and blocks
further capped calls. No invented actual-invoice estimate replaces it.

Capped execution supports built-in Anthropic/OpenAI adapters at their canonical
endpoints. It refuses ChatGPT subscription execution (the backend ignores the
output cap), custom endpoints without the supported contract and unpriced calls.
Automatic provider retries are disabled under the cap: an uncertain failed attempt
cannot quietly spend another reservation. Standalone model commands without the
session metering seam refuse a configured daily cap; they are not silently uncapped.

The shared wrapper covers main, children/grandchildren, compaction and configured
session maintenance/reviewer/grader calls, including lazy provider entries.
Auxiliary usage-report snapshots are not added a second time. Auxiliary work
outside an attached run has its own explicit segment. Trusted SDK callers opt in
with `SpendLedger`, `meterProvider` and `AgentConfig.spend`; capped unmetered
providers refuse, while uncapped injected providers record a coverage gap and retain
ordinary behavior. Copying historical records does not create a live meter.

This is not a limit on shell/MCP/service charges, arbitrary trusted host code, or
other programs/accounts. It is not a tamper-proof ledger or a sandbox. R7 still
requires explicit `--execute`. Heartbeat permits usage.jsonl as operational
accounting while retaining its tool-free empty-checklist and no task/wiki/report
artifact requirements.

## Concurrency, uncertainty and recovery

Cooperating writers serialize append/check operations with `usage.lock`; model
requests run outside the lock. One ledger instance permits up to 32 live calls
with at most 64 queued bookkeeping operations. Lock contention retries every 20 ms
under a two-second overall waiting deadline. Admission observes caller cancellation;
settlement gets its own bounded cleanup attempt even after a call was aborted.
It never steals another owner's lock. An outstanding reservation owned by
another process conservatively blocks capped admission even if that process is
alive and allowance remains. This is not a general parallel-throughput guarantee.

Each call belongs to its admission UTC day. Missing final usage, interruption,
retry uncertainty, a crash or failed settlement cannot become zero spend. Unresolved
reservations and unmetered coverage gaps block later capped execution across midnight.
A still-live prior-day reservation blocks new-day admission until it settles too.
An actual cost above the configured reservation also blocks further capped calls.
There is no automatic expiry, lock stealing, model replay or ledger pruning.

The fixed limits are 16 MiB, 100,000 records and 8 KiB per record. Unsafe linked
paths, malformed/truncated files and overflow refuse accounting. The live object
checks its observed byte prefix for deletion/rewrite, but this does not establish
persistent integrity across process restart or against hostile external writers.
Reads during an external/noncooperating write may report unavailable rather than
claim a complete estimate.

Without a daily cap, unavailable accounting warns and ordinary execution continues;
it attempts a durable coverage gap but does not claim one was written when storage
is unavailable. With a cap, the same condition refuses model dispatch. Original
malformed data is preserved, not repaired or replaced automatically.

No automated recovery command is implemented. Stop all cooperating writers first,
preserve the ledger, named lock and session logs, and reconcile uncertain calls
against trustworthy provider/account evidence. Do not treat deleting a lock,
record or ledger as safe recovery or a free allowance reset. Preserve the original
audit evidence and explicitly accept any new accounting epoch's unknown prior
coverage. Aborting local work does not prove remote billing stopped.

See [R15i contract and validation](plans/R15i.md).
