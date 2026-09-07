# Status line

The mounted terminal shows one prioritized, truncated row. Narrow terminals can
hide lower-priority fields; `/cost`, `/permissions`, `/context` and `/supervisor`
remain detailed views. No status field changes authorization or execution.

- `asks:N`: pending plus queued permissions and clarifications, plus a supervisor
  question if present. This is not a count parsed from model text.
- `ask(policy)` / `yolo`: configured fallback posture; explicit rules still apply.
  `grants:N` counts live standing allow **and deny** records. `blocked` means those
  records report an audit blockage; inspection never counts as an approval.
- `sb:…`: configured runtime sandbox mode, not a claim that policy is isolation.
- `run~$…`: settled configured estimate for the actual run's bound ledger segment;
  reserved estimates are separate. `+?` means incomplete/unpriced/unresolved
  coverage. Unpriced runs instead show input/output/cache-read/cache-write token
  snapshots with `cost:?`. No ledger/current binding means cost unknown, not zero.
  These are point-in-time estimates, not invoices or complete external spend.
- `sup:<signal>:nextN=<rung>`: highest stored per-signal candidate index in the
  actual attached, capability-filtered ladder; `+N` counts other tracked signals.
  This is **before** confidence, cooldown, new progress and escalation-signature
  checks. It is not a promise to intervene. `ready` means no tracked signal yet;
  custom policy is unknown; no active supervisor is off/unavailable.
- Activity, model, turn, last-request context estimate, session and branch follow.
  Context tokens are not a total-spend estimate.

Ledger refreshes are serialized and coalesced, at most once every five seconds.
Old snapshots become labelled stale; a new actual Session invalidates old results
even when resuming the same conversation ID. The active accounting run can differ
from the selected conversation during owned maintenance. Only mounted TUI starts
refreshes. Unmount stops timers/publication; shutdown joins any bounded ledger
read already in progress. Filesystem hangs are not hard-time-bounded by this UI.
`/cost` uses that same actual-run source; a historical-ID-only SDK caller receives
an explicitly labelled latest-recorded segment, not a supposed live run.

Source labels have terminal/bidi controls replaced and finite display bounds.
No footer refresh performs a permission decision, model call, price lookup,
ledger mutation, raw-log rewrite or provider switch.
