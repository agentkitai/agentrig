# R7a — explicit, bounded scheduler ticks

## Contract

`schedule ls/add/rm` manages `.agentrig/schedule.json` at the canonical project
root. Entries have an ID, UTC cron, literal task and typed budget flags. No shell,
environment or template interpolation occurs. `tick` previews due entries by
default, without loading provider configuration or credentials or recording claims.
Only `tick --execute` invokes headless sessions, and requires the existing project
trust decision (recorded trust or explicit run-only `--trust`). R15i remains the
gate before unattended execution becomes a default: these budgets are not a hard
monetary spending cap.

Fixed bounds: 256 KiB table, 100 entries, 64-character IDs, 128-character cron,
8,192-character tasks, and at most 10 launches per tick. Budget flags are integers:
maxTurns 1–50 (default 5), maxTokens 1–100,000 (default 10,000), maxMinutes 1–30
(default 5). No table-owned provider, endpoint, credentials, permissions, hooks,
extensions, resume, filesystem-root or arbitrary argv flags are accepted.

Cron has five fields: minute/hour/day-of-month/month/day-of-week, all UTC. Numeric
values, comma lists, inclusive ranges, `*` and `/step` on stars/ranges are supported;
Sunday is 0 (not 7), no aliases/macros/timezones. Minute/hour/month always match;
day-of-month and day-of-week use OR when both are restricted, otherwise the
restricted field controls. Only the current minute is due: no implicit catch-up.

Cooperating mutations and executing ticks share one exclusive lock, held through
serial session settlement. Acquisition is bounded; locks are never stolen by age.
Each occurrence is durably claimed before dispatch. Repeated or earlier minutes
cannot launch it again. A crash after claiming may lose that occurrence; it is
not silently retried. More than ten due entries is an explicit refusal, not an
invisible partial tick. Cancellation stops further launches and joins active
session cleanup. Existing runtime budgets and cancellation limitations still
apply to uncooperative host JavaScript or remote work.

Table, lock and mutation paths reject symlinks, including `.agentrig`; canonical
project containment is checked before access. Atomic replacement and the lock
protect cooperating commands, not hostile external writers racing path checks.
Manual crashed-lock recovery requires stopping writers first. Schedule state is
mutable operational data, never an immutable raw session log.

## Provenance and authority

A small trusted runtime scheduled-run descriptor emits `run.scheduled` and gives
the initial task advisory context with project-source trust. It is not fresh user
input and cannot clear the external-expansion restriction or mint tool grants.
Consequently a headless scheduled first exec/network/outside-or-unknown write
still requires unavailable fresh approval and refuses, even with blanket allow.
This deliberately does not claim scheduled shell checks are preauthorized.
Provider/model prose and schedule-file fields cannot change this classification.

Reuse existing headless execution and session persistence; no second runner,
daemon, heartbeat (R7b), report/banner/ingestion (R7c), or spend ledger (R15i).

## Verification and delivery

Actual CLI parsing and frozen-clock runtime fixtures must distinguish due/undue,
preview/execute, duplicate/concurrent ticks, malformed input, unsafe paths,
persisted provenance, cancellation and fresh-permission refusals. Named negative
controls remove due/claim/provenance guards and must fail before restoration.
One bounded independent Claude review, material fixes, build/typecheck/full tests
and updated-main exact-head three-platform CI precede root-coordinated merge.
Post-merge CI gates completion. No live provider calls or evaluation spend.

Implementation and evidence receipts pending.
